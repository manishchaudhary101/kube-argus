package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// ─── Prometheus Metrics ──────────────────────────────────────────────

var promBaseURL string

func initPrometheus() {
	promURL := os.Getenv("PROMETHEUS_URL")
	if promURL == "" {
		slog.Info("PROMETHEUS_URL not set, metrics graphs disabled")
		return
	}
	base := strings.TrimRight(promURL, "/")
	if strings.Contains(base, "grafana.net") {
		base += "/api/prom"
	}
	promBaseURL = base
	slog.Info("prometheus configured", "endpoint", promBaseURL+"/api/v1/query_range")
}

// ─── Prometheus Query Cache (30s TTL) ────────────────────────────────

var promCache struct {
	mu      sync.RWMutex
	entries map[string]promCacheEntry
}

type promCacheEntry struct {
	data []byte
	ts   time.Time
}

const promCacheTTL = 30 * time.Second

func init() { promCache.entries = make(map[string]promCacheEntry) }

func promQuery(query, start, end, step string) ([]byte, error) {
	if promBaseURL == "" {
		return nil, fmt.Errorf("PROMETHEUS_URL not configured")
	}

	cacheKey := query + "|" + start + "|" + end + "|" + step
	promCache.mu.RLock()
	if e, ok := promCache.entries[cacheKey]; ok && time.Since(e.ts) < promCacheTTL {
		promCache.mu.RUnlock()
		return e.data, nil
	}
	promCache.mu.RUnlock()

	promUser := os.Getenv("PROMETHEUS_USER")
	promKey := os.Getenv("PROMETHEUS_KEY")

	u := promBaseURL + "/api/v1/query_range"
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("query", query)
	q.Set("start", start)
	q.Set("end", end)
	q.Set("step", step)
	req.URL.RawQuery = q.Encode()

	if promUser != "" && promKey != "" {
		req.SetBasicAuth(promUser, promKey)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		truncLen := len(body)
		if truncLen > 200 { truncLen = 200 }
		return nil, fmt.Errorf("prometheus returned %d: %s", resp.StatusCode, string(body[:truncLen]))
	}

	promCache.mu.Lock()
	promCache.entries[cacheKey] = promCacheEntry{data: body, ts: time.Now()}
	// Evict stale entries periodically.
	if len(promCache.entries) > 200 {
		for k, e := range promCache.entries {
			if time.Since(e.ts) > promCacheTTL { delete(promCache.entries, k) }
		}
	}
	promCache.mu.Unlock()

	return body, nil
}

func promInstantQuery(query string) (float64, error) {
	if promBaseURL == "" {
		return 0, fmt.Errorf("PROMETHEUS_URL not configured")
	}
	promUser := os.Getenv("PROMETHEUS_USER")
	promKey := os.Getenv("PROMETHEUS_KEY")

	u := promBaseURL + "/api/v1/query"
	req, err := http.NewRequest("GET", u, nil)
	if err != nil { return 0, err }
	q := req.URL.Query()
	q.Set("query", query)
	q.Set("time", fmt.Sprintf("%d", time.Now().Unix()))
	req.URL.RawQuery = q.Encode()
	if promUser != "" && promKey != "" {
		req.SetBasicAuth(promUser, promKey)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil { return 0, err }
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil { return 0, err }
	if resp.StatusCode != 200 {
		truncLen := len(body)
		if truncLen > 200 { truncLen = 200 }
		return 0, fmt.Errorf("prometheus %d: %s", resp.StatusCode, string(body[:truncLen]))
	}
	var result struct {
		Data struct {
			Result []struct {
				Value []interface{} `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil { return 0, err }
	if len(result.Data.Result) == 0 { return 0, nil }
	valStr, ok := result.Data.Result[0].Value[1].(string)
	if !ok { return 0, nil }
	return strconv.ParseFloat(valStr, 64)
}

// ─── Workload Right-Sizing (Prometheus 7-day) ───────────────────────
func apiWorkloadSizing(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	nsName := r.URL.Query().Get("namespace")
	wlName := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	if nsName == "" || wlName == "" {
		je(w, "need namespace and name", 400)
		return
	}

	cache.mu.RLock()
	var cpuReqM, cpuLimM, memReqMi, memLimMi int64
	var podRegex string
	switch kind {
	case "Deployment":
		if cache.deployments != nil {
			for _, d := range cache.deployments.Items {
				if d.Name == wlName && d.Namespace == nsName {
					for _, ct := range d.Spec.Template.Spec.Containers {
						cpuReqM += ct.Resources.Requests.Cpu().MilliValue()
						cpuLimM += ct.Resources.Limits.Cpu().MilliValue()
						memReqMi += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
						memLimMi += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
					}
					podRegex = wlName + "-[a-z0-9]+-[a-z0-9]+"
					break
				}
			}
		}
	case "StatefulSet":
		if cache.statefulsets != nil {
			for _, s := range cache.statefulsets.Items {
				if s.Name == wlName && s.Namespace == nsName {
					for _, ct := range s.Spec.Template.Spec.Containers {
						cpuReqM += ct.Resources.Requests.Cpu().MilliValue()
						cpuLimM += ct.Resources.Limits.Cpu().MilliValue()
						memReqMi += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
						memLimMi += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
					}
					podRegex = wlName + "-[0-9]+"
					break
				}
			}
		}
	case "DaemonSet":
		if cache.daemonsets != nil {
			for _, d := range cache.daemonsets.Items {
				if d.Name == wlName && d.Namespace == nsName {
					for _, ct := range d.Spec.Template.Spec.Containers {
						cpuReqM += ct.Resources.Requests.Cpu().MilliValue()
						cpuLimM += ct.Resources.Limits.Cpu().MilliValue()
						memReqMi += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
						memLimMi += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
					}
					podRegex = wlName + "-[a-z0-9]+"
					break
				}
			}
		}
	}
	cache.mu.RUnlock()

	if podRegex == "" {
		je(w, "workload not found", 404)
		return
	}

	podFilter := fmt.Sprintf(`namespace="%s",pod=~"%s",container!=""`, nsName, podRegex)
	type promResult struct {
		key string
		val float64
		err error
	}
	ch := make(chan promResult, 4)
	queries := map[string]string{
		"cpuAvg":  fmt.Sprintf(`avg_over_time(sum(rate(container_cpu_usage_seconds_total{%s}[5m]))[7d:5m])`, podFilter),
		"cpuMax":  fmt.Sprintf(`max_over_time(sum(rate(container_cpu_usage_seconds_total{%s}[5m]))[7d:5m])`, podFilter),
		"memAvg":  fmt.Sprintf(`avg_over_time(sum(container_memory_working_set_bytes{%s})[7d:5m])`, podFilter),
		"memMax":  fmt.Sprintf(`max_over_time(sum(container_memory_working_set_bytes{%s})[7d:5m])`, podFilter),
	}
	for k, q := range queries {
		go func(key, query string) {
			val, err := promInstantQuery(query)
			ch <- promResult{key, val, err}
		}(k, q)
	}
	vals := map[string]float64{}
	for i := 0; i < 4; i++ {
		r := <-ch
		if r.err != nil {
			slog.Warn("sizing query failed", "query", r.key, "error", r.err)
		}
		vals[r.key] = r.val
	}

	cpuAvgM := int64(vals["cpuAvg"] * 1000)
	cpuMaxM := int64(vals["cpuMax"] * 1000)
	memAvgMi := int64(vals["memAvg"] / (1024 * 1024))
	memMaxMi := int64(vals["memMax"] / (1024 * 1024))

	round10 := func(v int64) int64 { return ((v + 9) / 10) * 10 }
	roundMi := func(v int64) int64 {
		if v < 128 { return ((v + 7) / 8) * 8 }
		return ((v + 31) / 32) * 32
	}

	recCpuReq := round10(cpuAvgM * 120 / 100)
	recCpuLim := round10(cpuMaxM * 130 / 100)
	recMemReq := roundMi(memAvgMi * 120 / 100)
	recMemLim := roundMi(memMaxMi * 120 / 100)

	if recCpuReq < 10 { recCpuReq = 10 }
	if recCpuLim < recCpuReq { recCpuLim = recCpuReq }
	if recMemReq < 32 { recMemReq = 32 }
	if recMemLim < recMemReq { recMemLim = recMemReq }

	sizing := "ok"
	if cpuReqM > 0 && recCpuReq < cpuReqM*50/100 {
		sizing = "over"
	} else if cpuReqM > 0 && recCpuReq > cpuReqM {
		sizing = "under"
	}
	if memReqMi > 0 && recMemReq < memReqMi*50/100 {
		sizing = "over"
	} else if memReqMi > 0 && recMemReq > memReqMi {
		sizing = "under"
	}

	j(w, map[string]interface{}{
		"current": map[string]int64{"cpuReqM": cpuReqM, "cpuLimM": cpuLimM, "memReqMi": memReqMi, "memLimMi": memLimMi},
		"observed": map[string]int64{"cpuAvgM": cpuAvgM, "cpuMaxM": cpuMaxM, "memAvgMi": memAvgMi, "memMaxMi": memMaxMi},
		"recommended": map[string]int64{"cpuReqM": recCpuReq, "cpuLimM": recCpuLim, "memReqMi": recMemReq, "memLimMi": recMemLim},
		"sizing": sizing,
		"source": "prometheus-7d-avg",
	})
}

// ─── Firing Alerts (Prometheus) ──────────────────────────────────────
func apiAlerts(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": "Prometheus not configured"})
		return
	}
	promUser := os.Getenv("PROMETHEUS_USER")
	promKey := os.Getenv("PROMETHEUS_KEY")

	u := promBaseURL + "/api/v1/alerts"
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": err.Error()})
		return
	}
	if promUser != "" && promKey != "" {
		req.SetBasicAuth(promUser, promKey)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if resp.StatusCode != 200 {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": fmt.Sprintf("prometheus %d", resp.StatusCode)})
		return
	}

	var result struct {
		Data struct {
			Alerts []struct {
				Labels      map[string]string `json:"labels"`
				Annotations map[string]string `json:"annotations"`
				State       string            `json:"state"`
				ActiveAt    string            `json:"activeAt"`
			} `json:"alerts"`
		} `json:"data"`
	}
	json.Unmarshal(body, &result)

	type alertOut struct {
		Name        string `json:"name"`
		Severity    string `json:"severity"`
		State       string `json:"state"`
		Namespace   string `json:"namespace,omitempty"`
		Pod         string `json:"pod,omitempty"`
		Node        string `json:"node,omitempty"`
		Service     string `json:"service,omitempty"`
		Summary     string `json:"summary"`
		Description string `json:"description"`
		ActiveSince string `json:"activeSince"`
	}

	alerts := make([]alertOut, 0)
	for _, a := range result.Data.Alerts {
		if a.State != "firing" { continue }
		sev := a.Labels["severity"]
		if sev == "" { sev = "warning" }
		since := a.ActiveAt
		if t, err := time.Parse(time.RFC3339, a.ActiveAt); err == nil {
			since = shortDur(time.Since(t))
		}
		alerts = append(alerts, alertOut{
			Name: a.Labels["alertname"], Severity: sev, State: a.State,
			Namespace: a.Labels["namespace"], Pod: a.Labels["pod"],
			Node: a.Labels["node"], Service: a.Labels["service"],
			Summary: a.Annotations["summary"], Description: a.Annotations["description"],
			ActiveSince: since,
		})
	}
	sort.Slice(alerts, func(i, k int) bool {
		sevOrder := map[string]int{"critical": 0, "warning": 1, "info": 2}
		si, sk := sevOrder[alerts[i].Severity], sevOrder[alerts[k].Severity]
		if si != sk { return si < sk }
		return alerts[i].Name < alerts[k].Name
	})
	j(w, map[string]interface{}{"alerts": alerts})
}


func apiMetricsNode(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	node := r.URL.Query().Get("node")
	rangeStr := r.URL.Query().Get("range")
	if node == "" {
		je(w, `{"error":"node parameter required"}`, 400)
		return
	}
	if rangeStr == "" {
		rangeStr = "1h"
	}

	dur, _ := time.ParseDuration(rangeStr)
	if dur == 0 {
		dur = time.Hour
	}
	end := time.Now()
	start := end.Add(-dur)
	step := "60s"
	rateWin := "5m"
	if dur > 12*time.Hour {
		step = "600s"
		rateWin = "15m"
	} else if dur > 6*time.Hour {
		step = "300s"
		rateWin = "10m"
	} else if dur > time.Hour {
		step = "120s"
		rateWin = "5m"
	}
	startStr := fmt.Sprintf("%d", start.Unix())
	endStr := fmt.Sprintf("%d", end.Unix())

	nodeInstance := ""
	cache.mu.RLock()
	if cache.nodes != nil {
		for _, n := range cache.nodes.Items {
			if n.Name == node {
				for _, addr := range n.Status.Addresses {
					if addr.Type == corev1.NodeInternalIP {
						nodeInstance = addr.Address
						break
					}
				}
				break
			}
		}
	}
	cache.mu.RUnlock()

	podOnNode := fmt.Sprintf(`topk by(namespace,pod) (1, kube_pod_info{node="%s"})`, node)

	queries := map[string]string{
		// Recording-rule based (kube-prometheus-stack / Grafana Cloud)
		"rr_cpu_used":     fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{node=~"%s"})`, node),
		"rr_cpu_requests": fmt.Sprintf(`sum(cluster:namespace:pod_cpu:active:kube_pod_container_resource_requests{node=~"%s"})`, node),
		"rr_cpu_limits":   fmt.Sprintf(`sum(cluster:namespace:pod_cpu:active:kube_pod_container_resource_limits{node=~"%s"})`, node),
		"rr_mem_used":     fmt.Sprintf(`sum(node_namespace_pod_container:container_memory_working_set_bytes{node=~"%s", container!=""})`, node),
		"rr_mem_requests": fmt.Sprintf(`sum(cluster:namespace:pod_memory:active:kube_pod_container_resource_requests{node=~"%s"})`, node),
		"rr_mem_limits":   fmt.Sprintf(`sum(cluster:namespace:pod_memory:active:kube_pod_container_resource_limits{node=~"%s"})`, node),
		"rr_mem_rss":      fmt.Sprintf(`sum(node_namespace_pod_container:container_memory_rss{node=~"%s", container!=""})`, node),
		"rr_mem_cache":    fmt.Sprintf(`sum(node_namespace_pod_container:container_memory_cache{node=~"%s", container!=""})`, node),

		// Raw cadvisor / kube-state-metrics fallback (works with vanilla Prometheus)
		"cpu_used":     fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[%s]) * on(namespace,pod) group_left() %s)`, rateWin, podOnNode),
		"cpu_requests": fmt.Sprintf(`sum(kube_pod_container_resource_requests{resource="cpu",container!=""} * on(namespace,pod) group_left() %s)`, podOnNode),
		"cpu_limits":   fmt.Sprintf(`sum(kube_pod_container_resource_limits{resource="cpu",container!=""} * on(namespace,pod) group_left() %s)`, podOnNode),
		"mem_used":     fmt.Sprintf(`sum(container_memory_working_set_bytes{container!="",container!="POD"} * on(namespace,pod) group_left() %s)`, podOnNode),
		"mem_requests": fmt.Sprintf(`sum(kube_pod_container_resource_requests{resource="memory",container!=""} * on(namespace,pod) group_left() %s)`, podOnNode),
		"mem_limits":   fmt.Sprintf(`sum(kube_pod_container_resource_limits{resource="memory",container!=""} * on(namespace,pod) group_left() %s)`, podOnNode),
		"mem_rss":      fmt.Sprintf(`sum(container_memory_rss{container!="",container!="POD"} * on(namespace,pod) group_left() %s)`, podOnNode),
		"mem_cache":    fmt.Sprintf(`sum(container_memory_cache{container!="",container!="POD"} * on(namespace,pod) group_left() %s)`, podOnNode),

		// Always available (kube-state-metrics + node_exporter)
		"cpu_capacity": fmt.Sprintf(`sum(kube_node_status_capacity{node=~"%s", resource="cpu"})`, node),
		"mem_capacity": fmt.Sprintf(`sum(kube_node_status_capacity{node=~"%s", resource="memory"})`, node),
		"cpu":          fmt.Sprintf(`100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle",instance=~"%s:.*"}[%s])) * 100)`, nodeInstance, rateWin),
		"memory":       fmt.Sprintf(`(1 - node_memory_MemAvailable_bytes{instance=~"%s:.*"} / node_memory_MemTotal_bytes{instance=~"%s:.*"}) * 100`, nodeInstance, nodeInstance),
		"fs_used":      fmt.Sprintf(`(1 - node_filesystem_avail_bytes{instance=~"%s:.*",mountpoint="/",fstype!="tmpfs"} / node_filesystem_size_bytes{instance=~"%s:.*",mountpoint="/",fstype!="tmpfs"}) * 100`, nodeInstance, nodeInstance),
	}

	jGz(w, r, promQueryParallel(queries, startStr, endStr, step))
}

func apiMetricsPod(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	ns := r.URL.Query().Get("namespace")
	pod := r.URL.Query().Get("pod")
	rangeStr := r.URL.Query().Get("range")
	if ns == "" || pod == "" {
		je(w, `{"error":"namespace and pod parameters required"}`, 400)
		return
	}
	if rangeStr == "" {
		rangeStr = "1h"
	}

	dur, _ := time.ParseDuration(rangeStr)
	if dur == 0 {
		dur = time.Hour
	}
	end := time.Now()
	start := end.Add(-dur)
	step := "60s"
	rw := "5m"
	if dur > 12*time.Hour {
		step = "600s"
		rw = "15m"
	} else if dur > 6*time.Hour {
		step = "300s"
		rw = "10m"
	} else if dur > time.Hour {
		step = "120s"
		rw = "5m"
	}
	startStr := fmt.Sprintf("%d", start.Unix())
	endStr := fmt.Sprintf("%d", end.Unix())

	queries := map[string]string{
		"cpu":      fmt.Sprintf(`sum by(container)(rate(container_cpu_usage_seconds_total{namespace="%s",pod="%s",container!="",container!="POD"}[%s])) * 1000`, ns, pod, rw),
		"memory":   fmt.Sprintf(`sum by(container)(container_memory_working_set_bytes{namespace="%s",pod="%s",container!="",container!="POD"}) / (1024*1024)`, ns, pod),
		"net_rx":   fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{namespace="%s",pod="%s"}[%s]))`, ns, pod, rw),
		"net_tx":   fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{namespace="%s",pod="%s"}[%s]))`, ns, pod, rw),
		"throttle": fmt.Sprintf(`sum by(container)(rate(container_cpu_cfs_throttled_periods_total{namespace="%s",pod="%s",container!="",container!="POD"}[%s])) / sum by(container)(rate(container_cpu_cfs_periods_total{namespace="%s",pod="%s",container!="",container!="POD"}[%s])) * 100`, ns, pod, rw, ns, pod, rw),
		"restarts": fmt.Sprintf(`kube_pod_container_status_restarts_total{namespace="%s",pod="%s"}`, ns, pod),

		// K8s mixin recording rules (Grafana Cloud)
		"rr_cpu":    fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s",pod="%s",container!=""}) * 1000`, ns, pod),
		"rr_memory": fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_memory_working_set_bytes{namespace="%s",pod="%s",container!=""}) / (1024*1024)`, ns, pod),
		"rr_rss":    fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_memory_rss{namespace="%s",pod="%s",container!=""}) / (1024*1024)`, ns, pod),
		"rr_cache":  fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_memory_cache{namespace="%s",pod="%s",container!=""}) / (1024*1024)`, ns, pod),
	}

	metrics := promQueryParallel(queries, startStr, endStr, step)

	// Attach resource requests/limits from cached pod spec
	type containerResources struct {
		Container string  `json:"container"`
		CpuReq    float64 `json:"cpuReqM"`
		CpuLim    float64 `json:"cpuLimM"`
		MemReq    float64 `json:"memReqMi"`
		MemLim    float64 `json:"memLimMi"`
	}
	var resources []containerResources

	cache.mu.RLock()
	if cache.pods != nil {
		for i := range cache.pods.Items {
			p := &cache.pods.Items[i]
			if p.Namespace == ns && p.Name == pod {
				for _, c := range p.Spec.Containers {
					cr := containerResources{Container: c.Name}
					if c.Resources.Requests != nil {
						if v, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
							cr.CpuReq = float64(v.MilliValue())
						}
						if v, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
							cr.MemReq = float64(v.Value()) / (1024 * 1024)
						}
					}
					if c.Resources.Limits != nil {
						if v, ok := c.Resources.Limits[corev1.ResourceCPU]; ok {
							cr.CpuLim = float64(v.MilliValue())
						}
						if v, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
							cr.MemLim = float64(v.Value()) / (1024 * 1024)
						}
					}
					resources = append(resources, cr)
				}
				break
			}
		}
	}
	cache.mu.RUnlock()

	resp := map[string]interface{}{}
	for k, v := range metrics {
		resp[k] = v
	}
	if resources != nil {
		resp["resources"] = resources
	}

	jGz(w, r, resp)
}

func apiMetricsWorkload(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	rangeStr := r.URL.Query().Get("range")
	if ns == "" || name == "" {
		je(w, `{"error":"namespace and name parameters required"}`, 400)
		return
	}
	if kind == "" {
		kind = "deployment"
	}
	if rangeStr == "" {
		rangeStr = "1h"
	}

	dur, _ := time.ParseDuration(rangeStr)
	if dur == 0 {
		dur = time.Hour
	}
	end := time.Now()
	start := end.Add(-dur)
	step := "60s"
	rateWindow := "5m"
	if dur > 12*time.Hour {
		step = "600s"
		rateWindow = "15m"
	} else if dur > 6*time.Hour {
		step = "300s"
		rateWindow = "10m"
	} else if dur > time.Hour {
		step = "120s"
		rateWindow = "5m"
	}
	startStr := fmt.Sprintf("%d", start.Unix())
	endStr := fmt.Sprintf("%d", end.Unix())

	kindLower := strings.ToLower(kind)

	ownerJoin := fmt.Sprintf(`namespace_workload_pod:kube_pod_owner:relabel{namespace="%s", workload="%s", workload_type="%s"}`, ns, name, kindLower)

	var podMatcher string
	switch kindLower {
	case "statefulset":
		podMatcher = fmt.Sprintf("%s-[0-9]+", name)
	default:
		podMatcher = fmt.Sprintf("%s-[a-z0-9]+-[a-z0-9]+", name)
	}

	queries := map[string]string{
		// Recording-rule based (Grafana Cloud) — aggregated totals
		"rr_cpu_total": fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s"} * on(namespace,pod) group_left(workload, workload_type) %s) * 1000`, ns, ownerJoin),
		"rr_mem_total": fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s", container!="", image!=""} * on(namespace,pod) group_left(workload, workload_type) %s) / (1024*1024)`, ns, ownerJoin),

		// Recording-rule based — per-pod breakdown
		"rr_cpu_per_pod": fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_mem_per_pod": fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s", container!="", image!=""} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),

		"rr_cpu_req_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_requests{namespace="%s", resource="cpu"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_cpu_lim_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_limits{namespace="%s", resource="cpu"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_cpu_req_pct": fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s"} * on(namespace,pod) group_left(workload, workload_type) %s) / sum(kube_pod_container_resource_requests{namespace="%s", resource="cpu"} * on(namespace,pod) group_left(workload, workload_type) %s)`, ns, ownerJoin, ns, ownerJoin),
		"rr_mem_req_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_requests{namespace="%s", resource="memory"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_mem_lim_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_limits{namespace="%s", resource="memory"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),

		// Raw cadvisor fallback — aggregated totals
		"cpu_total":    fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) * 1000`, ns, podMatcher, rateWindow),
		"mem_total":    fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s",pod=~"%s",container!="",container!="POD"}) / (1024*1024)`, ns, podMatcher),

		// Raw cadvisor fallback — per-pod
		"cpu_per_pod":  fmt.Sprintf(`sum by(pod)(rate(container_cpu_usage_seconds_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) * 1000`, ns, podMatcher, rateWindow),
		"mem_per_pod":  fmt.Sprintf(`sum by(pod)(container_memory_working_set_bytes{namespace="%s",pod=~"%s",container!="",container!="POD"}) / (1024*1024)`, ns, podMatcher),

		"throttle":     fmt.Sprintf(`sum(rate(container_cpu_cfs_throttled_periods_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) / sum(rate(container_cpu_cfs_periods_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) * 100`, ns, podMatcher, rateWindow, ns, podMatcher, rateWindow),

		// ── kube-state-metrics (work in both envs) ──
		"restarts":       fmt.Sprintf(`sum by(pod)(kube_pod_container_status_restarts_total{namespace="%s",pod=~"%s"})`, ns, podMatcher),
		"pods_running":   fmt.Sprintf(`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Running"} == 1)`, ns, podMatcher),
		"pods_pending":   fmt.Sprintf(`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Pending"} == 1)`, ns, podMatcher),
		"pods_failed":    fmt.Sprintf(`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Failed"} == 1)`, ns, podMatcher),
		"containers_ready":     fmt.Sprintf(`sum(kube_pod_container_status_ready{namespace="%s",pod=~"%s"})`, ns, podMatcher),
		"containers_not_ready": fmt.Sprintf(`sum(kube_pod_container_status_ready{namespace="%s",pod=~"%s"} == 0)`, ns, podMatcher),
	}

	// Deployment-specific kube-state-metrics
	if kindLower == "deployment" {
		queries["replicas"] = fmt.Sprintf(`kube_deployment_status_replicas{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_avl"] = fmt.Sprintf(`kube_deployment_status_replicas_available{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_updated"] = fmt.Sprintf(`kube_deployment_status_replicas_updated{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_unavail"] = fmt.Sprintf(`kube_deployment_status_replicas_unavailable{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_desired"] = fmt.Sprintf(`kube_deployment_spec_replicas{namespace="%s",deployment="%s"}`, ns, name)
		queries["generation_observed"] = fmt.Sprintf(`kube_deployment_status_observed_generation{namespace="%s",deployment="%s"}`, ns, name)
		queries["generation_meta"] = fmt.Sprintf(`kube_deployment_metadata_generation{namespace="%s",deployment="%s"}`, ns, name)
	} else if kindLower == "statefulset" {
		queries["replicas"] = fmt.Sprintf(`kube_statefulset_status_replicas{namespace="%s",statefulset="%s"}`, ns, name)
		queries["replicas_avl"] = fmt.Sprintf(`kube_statefulset_status_replicas_ready{namespace="%s",statefulset="%s"}`, ns, name)
		queries["replicas_updated"] = fmt.Sprintf(`kube_statefulset_status_replicas_updated{namespace="%s",statefulset="%s"}`, ns, name)
		queries["replicas_desired"] = fmt.Sprintf(`kube_statefulset_replicas{namespace="%s",statefulset="%s"}`, ns, name)
	} else if kindLower == "daemonset" {
		queries["ds_desired"] = fmt.Sprintf(`kube_daemonset_status_desired_number_scheduled{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_ready"] = fmt.Sprintf(`kube_daemonset_status_number_ready{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_available"] = fmt.Sprintf(`kube_daemonset_status_number_available{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_misscheduled"] = fmt.Sprintf(`kube_daemonset_status_number_misscheduled{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_unavailable"] = fmt.Sprintf(`kube_daemonset_status_number_unavailable{namespace="%s",daemonset="%s"}`, ns, name)
	}

	metrics := promQueryParallel(queries, startStr, endStr, step)

	// Attach aggregate resource requests/limits
	type wlResources struct {
		Replicas int     `json:"replicas"`
		CpuReqM  float64 `json:"cpuReqM"`
		CpuLimM  float64 `json:"cpuLimM"`
		MemReqMi float64 `json:"memReqMi"`
		MemLimMi float64 `json:"memLimMi"`
	}
	var res wlResources

	cache.mu.RLock()
	if cache.pods != nil {
		var selector map[string]string
		switch kindLower {
		case "deployment":
			if cache.deployments != nil {
				for _, d := range cache.deployments.Items {
					if d.Name == name && d.Namespace == ns && d.Spec.Selector != nil {
						selector = d.Spec.Selector.MatchLabels; break
					}
				}
			}
		case "statefulset":
			if cache.statefulsets != nil {
				for _, s := range cache.statefulsets.Items {
					if s.Name == name && s.Namespace == ns && s.Spec.Selector != nil {
						selector = s.Spec.Selector.MatchLabels; break
					}
				}
			}
		case "daemonset":
			if cache.daemonsets != nil {
				for _, d := range cache.daemonsets.Items {
					if d.Name == name && d.Namespace == ns && d.Spec.Selector != nil {
						selector = d.Spec.Selector.MatchLabels; break
					}
				}
			}
		}

		if len(selector) > 0 {
			for i := range cache.pods.Items {
				p := &cache.pods.Items[i]
				if p.Namespace != ns { continue }
				if p.Status.Phase != corev1.PodRunning && p.Status.Phase != corev1.PodPending { continue }
				match := true
				for k, v := range selector { if p.Labels[k] != v { match = false; break } }
				if !match { continue }
				res.Replicas++
				for _, c := range p.Spec.Containers {
					if c.Resources.Requests != nil {
						if v, ok := c.Resources.Requests[corev1.ResourceCPU]; ok { res.CpuReqM += float64(v.MilliValue()) }
						if v, ok := c.Resources.Requests[corev1.ResourceMemory]; ok { res.MemReqMi += float64(v.Value()) / (1024 * 1024) }
					}
					if c.Resources.Limits != nil {
						if v, ok := c.Resources.Limits[corev1.ResourceCPU]; ok { res.CpuLimM += float64(v.MilliValue()) }
						if v, ok := c.Resources.Limits[corev1.ResourceMemory]; ok { res.MemLimMi += float64(v.Value()) / (1024 * 1024) }
					}
				}
			}
		}
	}
	cache.mu.RUnlock()

	resp := map[string]interface{}{}
	for k, v := range metrics {
		resp[k] = v
	}
	resp["resources"] = res

	jGz(w, r, resp)
}

type promMetricSeries struct {
	Name   string      `json:"name"`
	Values [][2]float64 `json:"values"`
}

func promQueryParallel(queries map[string]string, startStr, endStr, step string) map[string][]promMetricSeries {
	type queryResult struct {
		name   string
		series []promMetricSeries
	}

	ch := make(chan queryResult, len(queries))
	for name, query := range queries {
		go func(n, q string) {
			raw, err := promQuery(q, startStr, endStr, step)
			if err != nil {
				slog.Warn("prom query failed", "query", n, "error", err)
				ch <- queryResult{name: n}
				return
			}
			var promResp struct {
				Data struct {
					Result []struct {
						Metric map[string]string `json:"metric"`
						Values [][]interface{}   `json:"values"`
					} `json:"result"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &promResp); err != nil {
				ch <- queryResult{name: n}
				return
			}
			series := make([]promMetricSeries, 0, len(promResp.Data.Result))
			for _, r := range promResp.Data.Result {
				label := n
				if v, ok := r.Metric["pod"]; ok { label = v } else if v, ok := r.Metric["container"]; ok { label = v } else if v, ok := r.Metric["device"]; ok { label = v }
				vals := make([][2]float64, 0, len(r.Values))
				for _, v := range r.Values {
					ts, _ := v[0].(float64)
					val := float64(0)
					if s, ok := v[1].(string); ok {
						val, _ = strconv.ParseFloat(s, 64)
					}
					vals = append(vals, [2]float64{ts, val})
				}
				series = append(series, promMetricSeries{Name: label, Values: vals})
			}
			ch <- queryResult{name: n, series: series}
		}(name, query)
	}

	result := map[string][]promMetricSeries{}
	for i := 0; i < len(queries); i++ {
		qr := <-ch
		if qr.series != nil {
			result[qr.name] = qr.series
		}
	}
	return result
}
