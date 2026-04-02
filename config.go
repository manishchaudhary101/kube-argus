package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── Config Drift Detection ─────────────────────────────────────────

func apiConfigDrift(w http.ResponseWriter, r *http.Request) {
	nsFilter := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	type driftPod struct {
		Name       string `json:"name"`
		Namespace  string `json:"namespace"`
		StartedAgo string `json:"startedAgo"`
		Workload   string `json:"workload"`
	}
	type driftEntry struct {
		Kind         string    `json:"kind"`
		Name         string    `json:"name"`
		Namespace    string    `json:"namespace"`
		LastModified string    `json:"lastModified"`
		ModifiedAgo  string    `json:"modifiedAgo"`
		DriftedPods  []driftPod `json:"driftedPods"`
		TotalPods    int       `json:"totalPods"`
		DriftedCount int       `json:"driftedCount"`
	}

	type cfgKey struct {
		kind, ns, name string
	}
	refPods := map[cfgKey][]corev1.Pod{}

	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			if p.Status.Phase != corev1.PodRunning { continue }
			if nsFilter != "" && p.Namespace != nsFilter { continue }
			seen := map[cfgKey]bool{}
			for _, vol := range p.Spec.Volumes {
				if vol.ConfigMap != nil {
					k := cfgKey{"ConfigMap", p.Namespace, vol.ConfigMap.Name}
					if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
				}
				if vol.Secret != nil {
					k := cfgKey{"Secret", p.Namespace, vol.Secret.SecretName}
					if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
				}
				if vol.Projected != nil {
					for _, src := range vol.Projected.Sources {
						if src.ConfigMap != nil {
							k := cfgKey{"ConfigMap", p.Namespace, src.ConfigMap.Name}
							if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
						}
						if src.Secret != nil {
							k := cfgKey{"Secret", p.Namespace, src.Secret.Name}
							if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
						}
					}
				}
			}
			for _, ct := range p.Spec.Containers {
				for _, ef := range ct.EnvFrom {
					if ef.ConfigMapRef != nil {
						k := cfgKey{"ConfigMap", p.Namespace, ef.ConfigMapRef.Name}
						if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
					}
					if ef.SecretRef != nil {
						k := cfgKey{"Secret", p.Namespace, ef.SecretRef.Name}
						if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
					}
				}
				for _, ev := range ct.Env {
					if ev.ValueFrom != nil {
						if ev.ValueFrom.ConfigMapKeyRef != nil {
							k := cfgKey{"ConfigMap", p.Namespace, ev.ValueFrom.ConfigMapKeyRef.Name}
							if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
						}
						if ev.ValueFrom.SecretKeyRef != nil {
							k := cfgKey{"Secret", p.Namespace, ev.ValueFrom.SecretKeyRef.Name}
							if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
						}
					}
				}
			}
			for _, ct := range p.Spec.InitContainers {
				for _, ef := range ct.EnvFrom {
					if ef.ConfigMapRef != nil {
						k := cfgKey{"ConfigMap", p.Namespace, ef.ConfigMapRef.Name}
						if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
					}
					if ef.SecretRef != nil {
						k := cfgKey{"Secret", p.Namespace, ef.SecretRef.Name}
						if !seen[k] { seen[k] = true; refPods[k] = append(refPods[k], p) }
					}
				}
			}
		}
	}

	podOwner := func(p corev1.Pod) string {
		for _, ref := range p.OwnerReferences {
			return ref.Name
		}
		return ""
	}

	var out []driftEntry

	checkDrift := func(kind string, metas []configMeta) {
		for _, m := range metas {
			if nsFilter != "" && m.Namespace != nsFilter { continue }
			k := cfgKey{kind, m.Namespace, m.Name}
			pods := refPods[k]
			if len(pods) == 0 { continue }
			var drifted []driftPod
			for _, p := range pods {
				if p.Status.StartTime == nil { continue }
				if m.LastModified.After(p.Status.StartTime.Time) {
					drifted = append(drifted, driftPod{
						Name:       p.Name,
						Namespace:  p.Namespace,
						StartedAgo: shortDur(time.Since(p.Status.StartTime.Time)),
						Workload:   podOwner(p),
					})
				}
			}
			if len(drifted) > 0 {
				out = append(out, driftEntry{
					Kind:         kind,
					Name:         m.Name,
					Namespace:    m.Namespace,
					LastModified: m.LastModified.Format(time.RFC3339),
					ModifiedAgo:  shortDur(time.Since(m.LastModified)),
					DriftedPods:  drifted,
					TotalPods:    len(pods),
					DriftedCount: len(drifted),
				})
			}
		}
	}

	checkDrift("ConfigMap", cache.configMeta)
	checkDrift("Secret", cache.secretMeta)

	if out == nil { out = []driftEntry{} }
	j(w, out)
}

// ─── ConfigMaps & Secrets ──────────────────────────────────────────────

func apiConfigs(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	kind := r.URL.Query().Get("kind") // "configmap" or "secret"
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	type configItem struct {
		Kind         string   `json:"kind"`
		Name         string   `json:"name"`
		Namespace    string   `json:"namespace"`
		Keys         []string `json:"keys"`
		KeyCount     int      `json:"keyCount"`
		Type         string   `json:"type,omitempty"`
		Age          string   `json:"age"`
		LastModified string   `json:"lastModified"`
		ModifiedAgo  string   `json:"modifiedAgo"`
		RecentChange bool     `json:"recentChange"`
	}

	out := make([]configItem, 0)
	recentThreshold := 24 * time.Hour

	if kind == "" || kind == "configmap" {
		for _, cm := range cache.configMeta {
			if ns != "" && cm.Namespace != ns { continue }
			modAgo := time.Since(cm.LastModified)
			out = append(out, configItem{
				Kind: "ConfigMap", Name: cm.Name, Namespace: cm.Namespace,
				Keys: cm.Keys, KeyCount: len(cm.Keys),
				Age: shortDur(time.Since(cm.CreatedAt)),
				LastModified: cm.LastModified.Format(time.RFC3339),
				ModifiedAgo: shortDur(modAgo),
				RecentChange: modAgo < recentThreshold && cm.LastModified.After(cm.CreatedAt.Add(time.Minute)),
			})
		}
	}

	if kind == "" || kind == "secret" {
		for _, s := range cache.secretMeta {
			if ns != "" && s.Namespace != ns { continue }
			modAgo := time.Since(s.LastModified)
			out = append(out, configItem{
				Kind: "Secret", Name: s.Name, Namespace: s.Namespace,
				Keys: s.Keys, KeyCount: len(s.Keys), Type: s.Type,
				Age: shortDur(time.Since(s.CreatedAt)),
				LastModified: s.LastModified.Format(time.RFC3339),
				ModifiedAgo: shortDur(modAgo),
				RecentChange: modAgo < recentThreshold && s.LastModified.After(s.CreatedAt.Add(time.Minute)),
			})
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Namespace+out[i].Kind+out[i].Name < out[j].Namespace+out[j].Kind+out[j].Name })
	jGz(w, r, out)
}

// /api/configs/{ns}/{name}?kind=configmap|secret
func apiConfigData(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/configs/"), "/")
	if len(parts) != 2 {
		http.Error(w, "usage: /api/configs/{namespace}/{name}?kind=configmap|secret", 400)
		return
	}
	ns, name := parts[0], parts[1]
	kind := r.URL.Query().Get("kind")
	if kind == "" { kind = "configmap" }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	isAdmin := false
	if authEnabled {
		sd, ok := r.Context().Value(userCtxKey).(*sessionData)
		isAdmin = ok && sd != nil && sd.Role == "admin"
	} else {
		isAdmin = true
	}

	type entry struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}

	entries := []entry{}

	if kind == "secret" {
		sec, err := clientset.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		keys := make([]string, 0, len(sec.Data)+len(sec.StringData))
		for k := range sec.Data { keys = append(keys, k) }
		for k := range sec.StringData { keys = append(keys, k) }
		sort.Strings(keys)
		for _, k := range keys {
			val := ""
			if isAdmin {
				if v, ok := sec.Data[k]; ok {
					val = string(v)
				} else if v, ok := sec.StringData[k]; ok {
					val = v
				}
			} else {
				val = "••••••••"
			}
			entries = append(entries, entry{Key: k, Value: val})
		}
	} else {
		cm, err := clientset.CoreV1().ConfigMaps(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		keys := make([]string, 0, len(cm.Data)+len(cm.BinaryData))
		for k := range cm.Data { keys = append(keys, k) }
		for k := range cm.BinaryData { keys = append(keys, k) }
		sort.Strings(keys)
		for _, k := range keys {
			val := ""
			if v, ok := cm.Data[k]; ok {
				val = v
			} else if v, ok := cm.BinaryData[k]; ok {
				val = fmt.Sprintf("<binary %d bytes>", len(v))
			}
			entries = append(entries, entry{Key: k, Value: val})
		}
	}

	jGz(w, r, map[string]interface{}{
		"kind":      kind,
		"name":      name,
		"namespace": ns,
		"entries":   entries,
		"masked":    kind == "secret" && !isAdmin,
	})
}
