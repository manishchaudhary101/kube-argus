package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	autov2 "k8s.io/api/autoscaling/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
)

// ─── Workloads ───────────────────────────────────────────────────────

func apiWorkloads(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	type pdbStatus struct {
		Name               string `json:"name"`
		Status             string `json:"status"`
		DisruptionsAllowed int32  `json:"disruptionsAllowed"`
	}
	type wlStrategy struct {
		Type           string `json:"type"`
		MaxSurge       string `json:"maxSurge,omitempty"`
		MaxUnavailable string `json:"maxUnavailable,omitempty"`
		Partition      *int32 `json:"partition,omitempty"`
	}
	type wl struct {
		Kind      string            `json:"kind"`
		Name      string            `json:"name"`
		NS        string            `json:"namespace"`
		Ready     int32             `json:"ready"`
		Desired   int32             `json:"desired"`
		Age       string            `json:"age"`
		Images    string            `json:"images"`
		PDB       *pdbStatus        `json:"pdb,omitempty"`
		Strategy  *wlStrategy       `json:"strategy,omitempty"`
		CpuReqM   int64             `json:"cpuReqM"`
		CpuLimM   int64             `json:"cpuLimM"`
		CpuUsedM  int64             `json:"cpuUsedM"`
		MemReqMi  int64             `json:"memReqMi"`
		MemLimMi  int64             `json:"memLimMi"`
		MemUsedMi int64             `json:"memUsedMi"`
	}

	podMetricsMap := cache.podMetricsMap

	// Pre-group active pods by namespace so sumPodUsage only scans the
	// relevant namespace instead of all pods (O(pods) once vs O(pods × workloads)).
	podsByNS := map[string][]corev1.Pod{}
	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed { continue }
			podsByNS[p.Namespace] = append(podsByNS[p.Namespace], p)
		}
	}

	sumPodUsage := func(namespace string, selector map[string]string) (int64, int64) {
		if len(selector) == 0 { return 0, 0 }
		var cpuTotal, memTotal int64
		for _, p := range podsByNS[namespace] {
			match := true
			for k, v := range selector { if p.Labels[k] != v { match = false; break } }
			if !match { continue }
			usage := podMetricsMap[p.Namespace+"/"+p.Name]
			cpuTotal += usage[0]
			memTotal += usage[1]
		}
		return cpuTotal, memTotal
	}

	matchPDB := func(namespace string, podLabels map[string]string) *pdbStatus {
		if cache.pdbs == nil || len(podLabels) == 0 { return nil }
		for _, p := range cache.pdbs.Items {
			if p.Namespace != namespace { continue }
			if p.Spec.Selector == nil || len(p.Spec.Selector.MatchLabels) == 0 { continue }
			match := true
			for k, v := range p.Spec.Selector.MatchLabels {
				if podLabels[k] != v { match = false; break }
			}
			if !match { continue }
			status := "healthy"
			if p.Status.DisruptionsAllowed == 0 && p.Status.CurrentHealthy <= p.Status.DesiredHealthy {
				status = "blocking"
			} else if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
				status = "degraded"
			}
			return &pdbStatus{Name: p.Name, Status: status, DisruptionsAllowed: p.Status.DisruptionsAllowed}
		}
		return nil
	}

	var out []wl
	if cache.deployments != nil {
		for _, d := range cache.deployments.Items {
			if ns != "" && d.Namespace != ns { continue }
			desired := int32(1)
			if d.Spec.Replicas != nil { desired = *d.Spec.Replicas }
			imgs := []string{}
			var cpuReq, cpuLim, memReq, memLim int64
			for _, c := range d.Spec.Template.Spec.Containers {
				imgs = append(imgs, shortImage(c.Image))
				cpuReq += c.Resources.Requests.Cpu().MilliValue()
				cpuLim += c.Resources.Limits.Cpu().MilliValue()
				memReq += c.Resources.Requests.Memory().Value() / (1024 * 1024)
				memLim += c.Resources.Limits.Memory().Value() / (1024 * 1024)
			}
			cpuUsed, memUsed := sumPodUsage(d.Namespace, d.Spec.Selector.MatchLabels)
			entry := wl{Kind: "Deployment", Name: d.Name, NS: d.Namespace, Ready: d.Status.ReadyReplicas, Desired: desired, Age: shortDur(time.Since(d.CreationTimestamp.Time)), Images: strings.Join(imgs, ", "), CpuReqM: cpuReq, CpuLimM: cpuLim, CpuUsedM: cpuUsed, MemReqMi: memReq, MemLimMi: memLim, MemUsedMi: memUsed}
			entry.PDB = matchPDB(d.Namespace, d.Spec.Template.Labels)
			st := &wlStrategy{Type: string(d.Spec.Strategy.Type)}
			if d.Spec.Strategy.RollingUpdate != nil {
				if d.Spec.Strategy.RollingUpdate.MaxSurge != nil { st.MaxSurge = d.Spec.Strategy.RollingUpdate.MaxSurge.String() }
				if d.Spec.Strategy.RollingUpdate.MaxUnavailable != nil { st.MaxUnavailable = d.Spec.Strategy.RollingUpdate.MaxUnavailable.String() }
			}
			entry.Strategy = st
			out = append(out, entry)
		}
	}
	if cache.statefulsets != nil {
		for _, s := range cache.statefulsets.Items {
			if ns != "" && s.Namespace != ns { continue }
			desired := int32(1)
			if s.Spec.Replicas != nil { desired = *s.Spec.Replicas }
			imgs := []string{}
			var cpuReq, cpuLim, memReq, memLim int64
			for _, c := range s.Spec.Template.Spec.Containers {
				imgs = append(imgs, shortImage(c.Image))
				cpuReq += c.Resources.Requests.Cpu().MilliValue()
				cpuLim += c.Resources.Limits.Cpu().MilliValue()
				memReq += c.Resources.Requests.Memory().Value() / (1024 * 1024)
				memLim += c.Resources.Limits.Memory().Value() / (1024 * 1024)
			}
			cpuUsed, memUsed := sumPodUsage(s.Namespace, s.Spec.Selector.MatchLabels)
			entry := wl{Kind: "StatefulSet", Name: s.Name, NS: s.Namespace, Ready: s.Status.ReadyReplicas, Desired: desired, Age: shortDur(time.Since(s.CreationTimestamp.Time)), Images: strings.Join(imgs, ", "), CpuReqM: cpuReq, CpuLimM: cpuLim, CpuUsedM: cpuUsed, MemReqMi: memReq, MemLimMi: memLim, MemUsedMi: memUsed}
			entry.PDB = matchPDB(s.Namespace, s.Spec.Template.Labels)
			st := &wlStrategy{Type: string(s.Spec.UpdateStrategy.Type)}
			if s.Spec.UpdateStrategy.RollingUpdate != nil && s.Spec.UpdateStrategy.RollingUpdate.Partition != nil {
				p := *s.Spec.UpdateStrategy.RollingUpdate.Partition
				st.Partition = &p
			}
			entry.Strategy = st
			out = append(out, entry)
		}
	}
	if cache.daemonsets != nil {
		for _, d := range cache.daemonsets.Items {
			if ns != "" && d.Namespace != ns { continue }
			imgs := []string{}
			var cpuReq, cpuLim, memReq, memLim int64
			for _, c := range d.Spec.Template.Spec.Containers {
				imgs = append(imgs, shortImage(c.Image))
				cpuReq += c.Resources.Requests.Cpu().MilliValue()
				cpuLim += c.Resources.Limits.Cpu().MilliValue()
				memReq += c.Resources.Requests.Memory().Value() / (1024 * 1024)
				memLim += c.Resources.Limits.Memory().Value() / (1024 * 1024)
			}
			cpuUsed, memUsed := sumPodUsage(d.Namespace, d.Spec.Selector.MatchLabels)
			entry := wl{Kind: "DaemonSet", Name: d.Name, NS: d.Namespace, Ready: d.Status.NumberReady, Desired: d.Status.DesiredNumberScheduled, Age: shortDur(time.Since(d.CreationTimestamp.Time)), Images: strings.Join(imgs, ", "), CpuReqM: cpuReq, CpuLimM: cpuLim, CpuUsedM: cpuUsed, MemReqMi: memReq, MemLimMi: memLim, MemUsedMi: memUsed}
			entry.PDB = matchPDB(d.Namespace, d.Spec.Template.Labels)
			st := &wlStrategy{Type: string(d.Spec.UpdateStrategy.Type)}
			if d.Spec.UpdateStrategy.RollingUpdate != nil {
				if d.Spec.UpdateStrategy.RollingUpdate.MaxSurge != nil { st.MaxSurge = d.Spec.UpdateStrategy.RollingUpdate.MaxSurge.String() }
				if d.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable != nil { st.MaxUnavailable = d.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable.String() }
			}
			entry.Strategy = st
			out = append(out, entry)
		}
	}
	if cache.jobs != nil {
		for _, jb := range cache.jobs.Items {
			if ns != "" && jb.Namespace != ns { continue }
			imgs := []string{}
			for _, c := range jb.Spec.Template.Spec.Containers { imgs = append(imgs, shortImage(c.Image)) }
			desired := int32(1)
			if jb.Spec.Completions != nil { desired = *jb.Spec.Completions }
			out = append(out, wl{Kind: "Job", Name: jb.Name, NS: jb.Namespace, Ready: jb.Status.Succeeded, Desired: desired, Age: shortDur(time.Since(jb.CreationTimestamp.Time)), Images: strings.Join(imgs, ", ")})
		}
	}
	if cache.cronjobs != nil {
		for _, cj := range cache.cronjobs.Items {
			if ns != "" && cj.Namespace != ns { continue }
			imgs := []string{}
			for _, c := range cj.Spec.JobTemplate.Spec.Template.Spec.Containers { imgs = append(imgs, shortImage(c.Image)) }
			active := int32(len(cj.Status.Active))
			out = append(out, wl{Kind: "CronJob", Name: cj.Name, NS: cj.Namespace, Ready: active, Desired: 0, Age: shortDur(time.Since(cj.CreationTimestamp.Time)), Images: strings.Join(imgs, ", ")})
		}
	}
	jGz(w, r, out)
}

// /api/workloads/{ns}/{name}/restart or /api/workloads/{ns}/{name}/scale?replicas=N

// buildContainerInfo converts a corev1.Container to a map for the describe response.
func buildContainerInfo(ct corev1.Container, isInit bool) map[string]interface{} {
	cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
	if isInit {
		cm["init"] = true
	}
	if ct.Resources.Requests != nil {
		cm["cpuReq"] = ct.Resources.Requests.Cpu().String()
		cm["memReq"] = ct.Resources.Requests.Memory().String()
	}
	if ct.Resources.Limits != nil {
		cm["cpuLim"] = ct.Resources.Limits.Cpu().String()
		cm["memLim"] = ct.Resources.Limits.Memory().String()
	}
	ports := []string{}
	for _, p := range ct.Ports {
		ports = append(ports, fmt.Sprintf("%d/%s", p.ContainerPort, p.Protocol))
	}
	cm["ports"] = ports
	cm["envCount"] = len(ct.Env) + len(ct.EnvFrom)
	return cm
}

func apiWorkloadAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/workloads/"), "/"), "/")
	if len(parts) != 3 {
		je(w, "use /api/workloads/{ns}/{name}/{describe|restart|scale}", 400)
		return
	}
	ns, name, action := parts[0], parts[1], parts[2]
	c, cancel := ctx()
	defer cancel()

	if action == "describe" {
		kind := r.URL.Query().Get("kind")
		result := map[string]interface{}{"name": name, "namespace": ns, "kind": kind}

		switch kind {
		case "Deployment":
			d, err := clientset.AppsV1().Deployments(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			replicas := int32(1)
			if d.Spec.Replicas != nil { replicas = *d.Spec.Replicas }
			result["replicas"] = replicas
			result["readyReplicas"] = d.Status.ReadyReplicas
			result["updatedReplicas"] = d.Status.UpdatedReplicas
			result["availableReplicas"] = d.Status.AvailableReplicas
			strat := map[string]interface{}{"type": string(d.Spec.Strategy.Type)}
			if d.Spec.Strategy.RollingUpdate != nil {
				if d.Spec.Strategy.RollingUpdate.MaxSurge != nil { strat["maxSurge"] = d.Spec.Strategy.RollingUpdate.MaxSurge.String() }
				if d.Spec.Strategy.RollingUpdate.MaxUnavailable != nil { strat["maxUnavailable"] = d.Spec.Strategy.RollingUpdate.MaxUnavailable.String() }
			}
			result["strategy"] = strat
			result["selector"] = d.Spec.Selector.MatchLabels
			result["labels"] = d.Labels
			result["annotations"] = d.Annotations
			result["age"] = shortDur(time.Since(d.CreationTimestamp.Time))
			containers := []map[string]interface{}{}
			for _, ct := range d.Spec.Template.Spec.InitContainers {
				containers = append(containers, buildContainerInfo(ct, true))
			}
			for _, ct := range d.Spec.Template.Spec.Containers {
				containers = append(containers, buildContainerInfo(ct, false))
			}
			result["containers"] = containers
			conds := []map[string]string{}
			for _, cnd := range d.Status.Conditions {
				conds = append(conds, map[string]string{"type": string(cnd.Type), "status": string(cnd.Status), "reason": cnd.Reason, "message": cnd.Message, "age": shortDur(time.Since(cnd.LastTransitionTime.Time))})
			}
			result["conditions"] = conds
			// Attach owned ReplicaSets
			cache.mu.RLock()
			type rsSummary struct {
				Name      string `json:"name"`
				Desired   int32  `json:"desired"`
				Ready     int32  `json:"ready"`
				Available int32  `json:"available"`
				Age       string `json:"age"`
				Revision  string `json:"revision"`
				Current   bool   `json:"current"`
			}
			var replicaSets []rsSummary
			if cache.replicasets != nil {
				for _, rs := range cache.replicasets.Items {
					if rs.Namespace != ns { continue }
					owned := false
					for _, ref := range rs.OwnerReferences {
						if ref.Kind == "Deployment" && ref.Name == name { owned = true; break }
					}
					if !owned { continue }
					desired := int32(0)
					if rs.Spec.Replicas != nil { desired = *rs.Spec.Replicas }
					rev := rs.Annotations["deployment.kubernetes.io/revision"]
					replicaSets = append(replicaSets, rsSummary{
						Name: rs.Name, Desired: desired, Ready: rs.Status.ReadyReplicas,
						Available: rs.Status.AvailableReplicas, Age: shortDur(time.Since(rs.CreationTimestamp.Time)),
						Revision: rev, Current: desired > 0,
					})
				}
			}
			cache.mu.RUnlock()
			sort.Slice(replicaSets, func(i, j int) bool { return replicaSets[i].Revision > replicaSets[j].Revision })
			if len(replicaSets) > 5 { replicaSets = replicaSets[:5] }
			result["replicaSets"] = replicaSets
		case "StatefulSet":
			s, err := clientset.AppsV1().StatefulSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			replicas := int32(1)
			if s.Spec.Replicas != nil { replicas = *s.Spec.Replicas }
			result["replicas"] = replicas
			result["readyReplicas"] = s.Status.ReadyReplicas
			result["selector"] = s.Spec.Selector.MatchLabels
			result["labels"] = s.Labels
			result["annotations"] = s.Annotations
			result["age"] = shortDur(time.Since(s.CreationTimestamp.Time))
			result["serviceName"] = s.Spec.ServiceName
			sStrat := map[string]interface{}{"type": string(s.Spec.UpdateStrategy.Type)}
			if s.Spec.UpdateStrategy.RollingUpdate != nil && s.Spec.UpdateStrategy.RollingUpdate.Partition != nil {
				sStrat["partition"] = *s.Spec.UpdateStrategy.RollingUpdate.Partition
			}
			result["strategy"] = sStrat
			containers := []map[string]interface{}{}
			for _, ct := range s.Spec.Template.Spec.InitContainers {
				containers = append(containers, buildContainerInfo(ct, true))
			}
			for _, ct := range s.Spec.Template.Spec.Containers {
				containers = append(containers, buildContainerInfo(ct, false))
			}
			result["containers"] = containers
		case "DaemonSet":
			d, err := clientset.AppsV1().DaemonSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			result["desiredNumberScheduled"] = d.Status.DesiredNumberScheduled
			result["currentNumberScheduled"] = d.Status.CurrentNumberScheduled
			result["numberReady"] = d.Status.NumberReady
			result["selector"] = d.Spec.Selector.MatchLabels
			result["labels"] = d.Labels
			result["annotations"] = d.Annotations
			result["age"] = shortDur(time.Since(d.CreationTimestamp.Time))
			dStrat := map[string]interface{}{"type": string(d.Spec.UpdateStrategy.Type)}
			if d.Spec.UpdateStrategy.RollingUpdate != nil {
				if d.Spec.UpdateStrategy.RollingUpdate.MaxSurge != nil { dStrat["maxSurge"] = d.Spec.UpdateStrategy.RollingUpdate.MaxSurge.String() }
				if d.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable != nil { dStrat["maxUnavailable"] = d.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable.String() }
			}
			result["strategy"] = dStrat
			containers := []map[string]interface{}{}
			for _, ct := range d.Spec.Template.Spec.InitContainers {
				containers = append(containers, buildContainerInfo(ct, true))
			}
			for _, ct := range d.Spec.Template.Spec.Containers {
				containers = append(containers, buildContainerInfo(ct, false))
			}
			result["containers"] = containers
		case "CronJob":
			cj, err := clientset.BatchV1().CronJobs(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			result["schedule"] = cj.Spec.Schedule
			result["suspend"] = cj.Spec.Suspend != nil && *cj.Spec.Suspend
			result["activeJobs"] = len(cj.Status.Active)
			result["labels"] = cj.Labels
			result["annotations"] = cj.Annotations
			result["age"] = shortDur(time.Since(cj.CreationTimestamp.Time))
			if cj.Status.LastScheduleTime != nil { result["lastSchedule"] = shortDur(time.Since(cj.Status.LastScheduleTime.Time)) + " ago" }
			if cj.Status.LastSuccessfulTime != nil { result["lastSuccess"] = shortDur(time.Since(cj.Status.LastSuccessfulTime.Time)) + " ago" }
			containers := []map[string]interface{}{}
			for _, ct := range cj.Spec.JobTemplate.Spec.Template.Spec.InitContainers {
				containers = append(containers, buildContainerInfo(ct, true))
			}
			for _, ct := range cj.Spec.JobTemplate.Spec.Template.Spec.Containers {
				containers = append(containers, buildContainerInfo(ct, false))
			}
			result["containers"] = containers
			result["ownerKind"] = "CronJob"
			result["ownerName"] = name
		case "Job":
			jb, err := clientset.BatchV1().Jobs(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			result["completions"] = jb.Status.Succeeded
			result["active"] = jb.Status.Active
			result["failed"] = jb.Status.Failed
			if jb.Spec.Selector != nil { result["selector"] = jb.Spec.Selector.MatchLabels }
			result["labels"] = jb.Labels
			result["annotations"] = jb.Annotations
			result["age"] = shortDur(time.Since(jb.CreationTimestamp.Time))
			conds := []map[string]string{}
			for _, cnd := range jb.Status.Conditions {
				conds = append(conds, map[string]string{"type": string(cnd.Type), "status": string(cnd.Status), "reason": cnd.Reason, "message": cnd.Message})
			}
			result["conditions"] = conds
			containers := []map[string]interface{}{}
			for _, ct := range jb.Spec.Template.Spec.InitContainers {
				containers = append(containers, buildContainerInfo(ct, true))
			}
			for _, ct := range jb.Spec.Template.Spec.Containers {
				containers = append(containers, buildContainerInfo(ct, false))
			}
			result["containers"] = containers
		case "ReplicaSet":
			rs, err := clientset.AppsV1().ReplicaSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			replicas := int32(0)
			if rs.Spec.Replicas != nil { replicas = *rs.Spec.Replicas }
			result["replicas"] = replicas
			result["readyReplicas"] = rs.Status.ReadyReplicas
			result["availableReplicas"] = rs.Status.AvailableReplicas
			result["fullyLabeledReplicas"] = rs.Status.FullyLabeledReplicas
			if rs.Spec.Selector != nil { result["selector"] = rs.Spec.Selector.MatchLabels }
			result["labels"] = rs.Labels
			result["annotations"] = rs.Annotations
			result["age"] = shortDur(time.Since(rs.CreationTimestamp.Time))
			containers := []map[string]interface{}{}
			for _, ct := range rs.Spec.Template.Spec.InitContainers {
				containers = append(containers, buildContainerInfo(ct, true))
			}
			for _, ct := range rs.Spec.Template.Spec.Containers {
				containers = append(containers, buildContainerInfo(ct, false))
			}
			result["containers"] = containers
			conds := []map[string]string{}
			for _, cnd := range rs.Status.Conditions {
				conds = append(conds, map[string]string{"type": string(cnd.Type), "status": string(cnd.Status), "reason": cnd.Reason, "message": cnd.Message})
			}
			result["conditions"] = conds
		default:
			je(w, "unsupported kind", 400); return
		}

		// Fetch related events using field selector to avoid listing all namespace events
		events, _ := clientset.CoreV1().Events(ns).List(c, metav1.ListOptions{
			FieldSelector: "involvedObject.name=" + name,
		})
		evts := []map[string]string{}
		if events != nil {
			for _, e := range events.Items {
				ts := e.LastTimestamp.Time
				if ts.IsZero() { ts = e.CreationTimestamp.Time }
				evts = append(evts, map[string]string{"type": e.Type, "reason": e.Reason, "message": e.Message, "age": shortDur(time.Since(ts))})
			}
		}
		if len(evts) > 30 { evts = evts[len(evts)-30:] }
		result["events"] = evts

		// Collect pods matching this workload from cache
		cache.mu.RLock()
		type podSummary struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
			Status    string `json:"status"`
			Ready     string `json:"ready"`
			Restarts  int    `json:"restarts"`
			Age       string `json:"age"`
			Node      string `json:"node"`
		}
		pods := []podSummary{}
		sel, hasSel := result["selector"].(map[string]string)
		ownerKind, _ := result["ownerKind"].(string)
		ownerName, _ := result["ownerName"].(string)

		if cache.pods != nil {
			// For CronJobs, collect job names owned by this CronJob first
			cronJobNames := map[string]bool{}
			if ownerKind == "CronJob" && cache.jobs != nil {
				for _, jb := range cache.jobs.Items {
					for _, ref := range jb.OwnerReferences {
						if ref.Kind == "CronJob" && ref.Name == ownerName { cronJobNames[jb.Name] = true }
					}
				}
			}

			for _, p := range cache.pods.Items {
				if p.Namespace != ns { continue }

				matched := false
				if hasSel && len(sel) > 0 {
					matched = true
					for k, v := range sel {
						if p.Labels[k] != v { matched = false; break }
					}
				}
				if !matched && ownerKind == "CronJob" {
					for _, ref := range p.OwnerReferences {
						if ref.Kind == "Job" && cronJobNames[ref.Name] { matched = true; break }
					}
				}
				if !matched { continue }

			status := podDisplayStatus(p)
				readyCount, totalCount := 0, len(p.Status.ContainerStatuses)
				var restarts int32
				for _, cs := range p.Status.ContainerStatuses {
					if cs.Ready { readyCount++ }
					restarts += cs.RestartCount
				}
				pods = append(pods, podSummary{
					Name: p.Name, Namespace: p.Namespace, Status: status,
					Ready: fmt.Sprintf("%d/%d", readyCount, totalCount),
					Restarts: int(restarts), Age: shortDur(time.Since(p.CreationTimestamp.Time)), Node: p.Spec.NodeName,
				})
			}
		}
		cache.mu.RUnlock()
		sort.Slice(pods, func(i, j int) bool { return pods[i].Name < pods[j].Name })
		result["pods"] = pods

		jGz(w, r, result)
		return
	}

	if action == "dependencies" {
		kind := r.URL.Query().Get("kind")
		cache.mu.RLock()
		defer cache.mu.RUnlock()

		var podLabels map[string]string
		var podSpec *corev1.PodSpec
		switch kind {
		case "Deployment":
			if cache.deployments != nil {
				for _, d := range cache.deployments.Items {
					if d.Name == name && d.Namespace == ns {
						podLabels = d.Spec.Template.Labels
						podSpec = &d.Spec.Template.Spec
						break
					}
				}
			}
		case "StatefulSet":
			if cache.statefulsets != nil {
				for _, s := range cache.statefulsets.Items {
					if s.Name == name && s.Namespace == ns {
						podLabels = s.Spec.Template.Labels
						podSpec = &s.Spec.Template.Spec
						break
					}
				}
			}
		case "DaemonSet":
			if cache.daemonsets != nil {
				for _, d := range cache.daemonsets.Items {
					if d.Name == name && d.Namespace == ns {
						podLabels = d.Spec.Template.Labels
						podSpec = &d.Spec.Template.Spec
						break
					}
				}
			}
		}

		type svcDep struct {
			Name      string `json:"name"`
			Type      string `json:"type"`
			ClusterIP string `json:"clusterIP"`
			Ports     string `json:"ports"`
		}
		type ingDep struct {
			Name        string `json:"name"`
			Host        string `json:"host"`
			Path        string `json:"path"`
			TLS         bool   `json:"tls"`
			ServiceName string `json:"serviceName"`
		}
		type hpaDep struct {
			Name     string `json:"name"`
			Min      int32  `json:"minReplicas"`
			Max      int32  `json:"maxReplicas"`
			Current  int32  `json:"currentReplicas"`
			Desired  int32  `json:"desiredReplicas"`
			Metrics  string `json:"metrics"`
		}
		type cfgRef struct {
			Kind   string `json:"kind"`
			Name   string `json:"name"`
			Source string `json:"source"`
		}
		type pdbDep struct {
			Name               string `json:"name"`
			Status             string `json:"status"`
			DisruptionsAllowed int32  `json:"disruptionsAllowed"`
			MinAvailable       string `json:"minAvailable"`
			MaxUnavailable     string `json:"maxUnavailable"`
		}

		var svcs []svcDep
		var ings []ingDep
		var hpas []hpaDep
		var cfgs []cfgRef
		var pdb *pdbDep

		svcNames := map[string]bool{}
		if podLabels != nil && cache.services != nil {
			for _, s := range cache.services.Items {
				if s.Namespace != ns || len(s.Spec.Selector) == 0 { continue }
				match := true
				for k, v := range s.Spec.Selector {
					if podLabels[k] != v { match = false; break }
				}
				if !match { continue }
				ports := []string{}
				for _, p := range s.Spec.Ports {
					ports = append(ports, fmt.Sprintf("%d/%s", p.Port, p.Protocol))
				}
				svcs = append(svcs, svcDep{Name: s.Name, Type: string(s.Spec.Type), ClusterIP: s.Spec.ClusterIP, Ports: strings.Join(ports, ", ")})
				svcNames[s.Name] = true
			}
		}

		if len(svcNames) > 0 && cache.ingresses != nil {
			tlsHosts := map[string]bool{}
			for _, ing := range cache.ingresses.Items {
				if ing.Namespace != ns { continue }
				for _, t := range ing.Spec.TLS {
					for _, h := range t.Hosts { tlsHosts[h] = true }
				}
				for _, rule := range ing.Spec.Rules {
					if rule.HTTP == nil { continue }
					for _, p := range rule.HTTP.Paths {
						if p.Backend.Service != nil && svcNames[p.Backend.Service.Name] {
							path := "/"
							if p.Path != "" { path = p.Path }
							ings = append(ings, ingDep{Name: ing.Name, Host: rule.Host, Path: path, TLS: tlsHosts[rule.Host], ServiceName: p.Backend.Service.Name})
						}
					}
				}
			}
		}

		if cache.hpas != nil {
			for _, h := range cache.hpas.Items {
				if h.Namespace != ns { continue }
				if h.Spec.ScaleTargetRef.Kind != kind || h.Spec.ScaleTargetRef.Name != name { continue }
				metricStrs := []string{}
				for _, m := range h.Status.CurrentMetrics {
					switch m.Type {
					case autov2.ResourceMetricSourceType:
						if m.Resource != nil {
							if m.Resource.Current.AverageUtilization != nil {
							metricStrs = append(metricStrs, fmt.Sprintf("%s: %d%%", m.Resource.Name, *m.Resource.Current.AverageUtilization))
						}
						}
					}
				}
				min := int32(1)
				if h.Spec.MinReplicas != nil { min = *h.Spec.MinReplicas }
				hpas = append(hpas, hpaDep{Name: h.Name, Min: min, Max: h.Spec.MaxReplicas, Current: h.Status.CurrentReplicas, Desired: h.Status.DesiredReplicas, Metrics: strings.Join(metricStrs, ", ")})
			}
		}

		seen := map[string]bool{}
		if podSpec != nil {
			for _, v := range podSpec.Volumes {
				if v.ConfigMap != nil && !seen["cm:"+v.ConfigMap.Name] {
					cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: v.ConfigMap.Name, Source: "volume"})
					seen["cm:"+v.ConfigMap.Name] = true
				}
				if v.Secret != nil && !seen["sec:"+v.Secret.SecretName] {
					cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: v.Secret.SecretName, Source: "volume"})
					seen["sec:"+v.Secret.SecretName] = true
				}
				if v.Projected != nil {
					for _, src := range v.Projected.Sources {
						if src.ConfigMap != nil && !seen["cm:"+src.ConfigMap.Name] {
							cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: src.ConfigMap.Name, Source: "volume"})
							seen["cm:"+src.ConfigMap.Name] = true
						}
						if src.Secret != nil && !seen["sec:"+src.Secret.Name] {
							cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: src.Secret.Name, Source: "volume"})
							seen["sec:"+src.Secret.Name] = true
						}
					}
				}
			}
			allContainers := append(podSpec.Containers, podSpec.InitContainers...)
			for _, ct := range allContainers {
				for _, ef := range ct.EnvFrom {
					if ef.ConfigMapRef != nil && !seen["cm:"+ef.ConfigMapRef.Name] {
						cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: ef.ConfigMapRef.Name, Source: "envFrom"})
						seen["cm:"+ef.ConfigMapRef.Name] = true
					}
					if ef.SecretRef != nil && !seen["sec:"+ef.SecretRef.Name] {
						cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: ef.SecretRef.Name, Source: "envFrom"})
						seen["sec:"+ef.SecretRef.Name] = true
					}
				}
				for _, ev := range ct.Env {
					if ev.ValueFrom == nil { continue }
					if ev.ValueFrom.ConfigMapKeyRef != nil && !seen["cm:"+ev.ValueFrom.ConfigMapKeyRef.Name] {
						cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: ev.ValueFrom.ConfigMapKeyRef.Name, Source: "env"})
						seen["cm:"+ev.ValueFrom.ConfigMapKeyRef.Name] = true
					}
					if ev.ValueFrom.SecretKeyRef != nil && !seen["sec:"+ev.ValueFrom.SecretKeyRef.Name] {
						cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: ev.ValueFrom.SecretKeyRef.Name, Source: "env"})
						seen["sec:"+ev.ValueFrom.SecretKeyRef.Name] = true
					}
				}
			}
		}

		if podLabels != nil && cache.pdbs != nil {
			for _, p := range cache.pdbs.Items {
				if p.Namespace != ns || p.Spec.Selector == nil { continue }
				match := true
				for k, v := range p.Spec.Selector.MatchLabels {
					if podLabels[k] != v { match = false; break }
				}
				if !match { continue }
				status := "healthy"
				if p.Status.DisruptionsAllowed == 0 && p.Status.CurrentHealthy <= p.Status.DesiredHealthy {
					status = "blocking"
				} else if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
					status = "degraded"
				}
				dep := pdbDep{Name: p.Name, Status: status, DisruptionsAllowed: p.Status.DisruptionsAllowed}
				if p.Spec.MinAvailable != nil { dep.MinAvailable = p.Spec.MinAvailable.String() }
				if p.Spec.MaxUnavailable != nil { dep.MaxUnavailable = p.Spec.MaxUnavailable.String() }
				pdb = &dep
				break
			}
		}

		j(w, map[string]interface{}{
			"services":   svcs,
			"ingresses":  ings,
			"hpas":       hpas,
			"configRefs": cfgs,
			"pdb":        pdb,
		})
		return
	}

	if action == "agglogs" {
		kind := r.URL.Query().Get("kind")
		tail := int64(100)
		if t := r.URL.Query().Get("tail"); t != "" {
			fmt.Sscanf(t, "%d", &tail)
		}
		follow := r.URL.Query().Get("follow") == "true"

		var labelSel map[string]string
		switch kind {
		case "Deployment":
			d, err := clientset.AppsV1().Deployments(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			labelSel = d.Spec.Selector.MatchLabels
		case "StatefulSet":
			s, err := clientset.AppsV1().StatefulSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			labelSel = s.Spec.Selector.MatchLabels
		case "DaemonSet":
			d, err := clientset.AppsV1().DaemonSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { jk8s(w, err); return }
			labelSel = d.Spec.Selector.MatchLabels
		default:
			je(w, "agglogs only supports Deployment, StatefulSet, DaemonSet", 400)
			return
		}

		selParts := []string{}
		for k, v := range labelSel {
			selParts = append(selParts, k+"="+v)
		}
		podList, err := clientset.CoreV1().Pods(ns).List(c, metav1.ListOptions{
			LabelSelector: strings.Join(selParts, ","),
		})
		if err != nil { jk8s(w, err); return }
		if len(podList.Items) == 0 { je(w, "no pods found", 404); return }

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher, ok := w.(http.Flusher)
		if !ok { je(w, "streaming not supported", 500); return }

		type logLine struct {
			Pod  string `json:"pod"`
			Line string `json:"line"`
		}
		ch := make(chan logLine, 256)
		var wg sync.WaitGroup

		ctx, ctxCancel := context.WithCancel(r.Context())
		defer ctxCancel()

		for _, pod := range podList.Items {
			wg.Add(1)
			go func(podName string) {
				defer wg.Done()
				opts := &corev1.PodLogOptions{TailLines: &tail, Follow: follow}
				stream, err := clientset.CoreV1().Pods(ns).GetLogs(podName, opts).Stream(ctx)
				if err != nil { return }
				defer stream.Close()
				scanner := bufio.NewScanner(stream)
				scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
				for scanner.Scan() {
					select {
					case ch <- logLine{Pod: podName, Line: scanner.Text()}:
					case <-ctx.Done():
						return
					}
				}
			}(pod.Name)
		}

		go func() { wg.Wait(); close(ch) }()

		for ll := range ch {
			b, _ := json.Marshal(ll)
			fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
		}
		return
	}

	if r.Method != "POST" {
		je(w, "POST only", 405)
		return
	}

	switch action {
	case "restart":
		kind := r.URL.Query().Get("kind")
		if kind == "" { kind = "Deployment" }
		if !requireAdminOrJIT(w, r, ns, kind, name) { return }

		ts := time.Now().UTC().Format(time.RFC3339)
		patch := fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"%s"}}}}}`, ts)
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			switch kind {
			case "StatefulSet":
				_, e := clientset.AppsV1().StatefulSets(ns).Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
				return e
			case "DaemonSet":
				_, e := clientset.AppsV1().DaemonSets(ns).Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
				return e
			default:
				_, e := clientset.AppsV1().Deployments(ns).Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
				return e
			}
		})
		if err != nil {
			jk8s(w, err)
			return
		}
		go cache.refresh()
		if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
			auditRecord(sd.Email, sd.Role, "workload.restart", fmt.Sprintf("%s %s/%s", kind, ns, name), "", clientIP(r))
		}
		j(w, map[string]string{"ok": "restarting"})
	case "scale":
		if !requireAdmin(w, r) { return }
		replicaStr := r.URL.Query().Get("replicas")
		var replicas int32
		if _, err := fmt.Sscanf(replicaStr, "%d", &replicas); err != nil || replicas < 0 || replicas > 100 {
			je(w, "replicas must be 0-100", 400)
			return
		}
		patch := fmt.Sprintf(`{"spec":{"replicas":%d}}`, replicas)
		_, err := clientset.AppsV1().Deployments(ns).Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
		if err != nil {
			jk8s(w, err)
			return
		}
		go cache.refresh()
		if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
			auditRecord(sd.Email, sd.Role, "workload.scale", fmt.Sprintf("Deployment %s/%s", ns, name), fmt.Sprintf("replicas: %d", replicas), clientIP(r))
		}
		j(w, map[string]interface{}{"ok": "scaled", "replicas": replicas})
	default:
		je(w, "use restart or scale", 400)
	}
}
