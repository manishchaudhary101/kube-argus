package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// ─── Overview ────────────────────────────────────────────────────────

func apiOverview(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	if cache.nodes == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		json.NewEncoder(w).Encode(map[string]string{"error": "Cache not ready, retrying..."})
		return
	}

	running, pending, failed, succeeded := 0, 0, 0, 0
	podCountByNode := map[string]int{}
	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			switch p.Status.Phase {
			case corev1.PodRunning:
				running++
			case corev1.PodPending:
				pending++
			case corev1.PodSucceeded:
				succeeded++
			default:
				failed++
			}
			podCountByNode[p.Spec.NodeName]++
		}
	}

	nodeMetricsMap := map[string]map[string]int64{}
	if cache.nodeMetrics != nil {
		for _, m := range cache.nodeMetrics.Items {
			nodeMetricsMap[m.Name] = map[string]int64{
				"cpu": m.Usage.Cpu().MilliValue(),
				"mem": m.Usage.Memory().Value() / (1024 * 1024),
			}
		}
	}

	readyNodes, totalNodes := 0, len(cache.nodes.Items)
	nodesInfo := make([]map[string]interface{}, 0, totalNodes)
	for _, n := range cache.nodes.Items {
		ready := false
		for _, cnd := range n.Status.Conditions {
			if cnd.Type == corev1.NodeReady && cnd.Status == corev1.ConditionTrue {
				ready = true
				break
			}
		}
		if ready { readyNodes++ }

		status := "NotReady"
		if ready { status = "Ready" }
		if n.Spec.Unschedulable { status += ",SchedulingDisabled" }

		role := "<none>"
		for k := range n.Labels {
			if k == "node-role.kubernetes.io/master" || k == "node-role.kubernetes.io/control-plane" {
				role = "control-plane"
			} else if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				role = strings.TrimPrefix(k, "node-role.kubernetes.io/")
			}
		}
		nodepool := ""
		if v, ok := n.Labels["karpenter.sh/nodepool"]; ok {
			nodepool = v
		}
		internalIP := ""
		for _, addr := range n.Status.Addresses {
			if addr.Type == corev1.NodeInternalIP { internalIP = addr.Address; break }
		}

		allocCPU := n.Status.Allocatable.Cpu().MilliValue()
		allocMem := n.Status.Allocatable.Memory().Value() / (1024 * 1024)
		usedCPU, usedMem := int64(0), int64(0)
		cpuPct, memPct := 0, 0
		if m, ok := nodeMetricsMap[n.Name]; ok {
			usedCPU, usedMem = m["cpu"], m["mem"]
			if allocCPU > 0 { cpuPct = int(usedCPU * 100 / allocCPU) }
			if allocMem > 0 { memPct = int(usedMem * 100 / allocMem) }
		}
		instanceType := n.Labels["node.kubernetes.io/instance-type"]
		if instanceType == "" {
			instanceType = n.Labels["beta.kubernetes.io/instance-type"]
		}
		nodesInfo = append(nodesInfo, map[string]interface{}{
			"name": n.Name, "ready": ready, "status": status, "role": role,
			"nodepool": nodepool, "instanceType": instanceType,
			"age": shortDur(time.Since(n.CreationTimestamp.Time)), "ageSec": int64(time.Since(n.CreationTimestamp.Time).Seconds()),
			"version": n.Status.NodeInfo.KubeletVersion, "internalIP": internalIP,
			"cordoned": n.Spec.Unschedulable,
			"allocCpuM": allocCPU, "allocMemMi": allocMem,
			"usedCpuM": usedCPU, "usedMemMi": usedMem,
			"cpuPercent": cpuPct, "memPercent": memPct,
			"pods": podCountByNode[n.Name],
		})
	}

	readyDeploys, totalDeploys := 0, 0
	if cache.deployments != nil {
		totalDeploys = len(cache.deployments.Items)
		for _, d := range cache.deployments.Items {
			desired := int32(1)
			if d.Spec.Replicas != nil { desired = *d.Spec.Replicas }
			if d.Status.ReadyReplicas >= desired { readyDeploys++ }
		}
	}

	var totalCpuCapM, totalMemCapMi, totalCpuAllocM, totalMemAllocMi, totalCpuUsedM, totalMemUsedMi int64
	for _, n := range cache.nodes.Items {
		totalCpuCapM += n.Status.Capacity.Cpu().MilliValue()
		totalMemCapMi += n.Status.Capacity.Memory().Value() / (1024 * 1024)
		totalCpuAllocM += n.Status.Allocatable.Cpu().MilliValue()
		totalMemAllocMi += n.Status.Allocatable.Memory().Value() / (1024 * 1024)
		if m, ok := nodeMetricsMap[n.Name]; ok {
			totalCpuUsedM += m["cpu"]
			totalMemUsedMi += m["mem"]
		}
	}

	nsCount := 0
	if cache.namespaces != nil { nsCount = len(cache.namespaces.Items) }
	totalPods := 0
	if cache.pods != nil { totalPods = len(cache.pods.Items) }
	svcCount := 0
	if cache.services != nil { svcCount = len(cache.services.Items) }
	ingCount := 0
	if cache.ingresses != nil { ingCount = len(cache.ingresses.Items) }
	stsCount := 0
	if cache.statefulsets != nil { stsCount = len(cache.statefulsets.Items) }
	dsCount := 0
	if cache.daemonsets != nil { dsCount = len(cache.daemonsets.Items) }
	jobCount := 0
	if cache.jobs != nil { jobCount = len(cache.jobs.Items) }
	cjCount := 0
	if cache.cronjobs != nil { cjCount = len(cache.cronjobs.Items) }

	nsPodCounts := map[string]int{}
	if cache.pods != nil {
		for _, p := range cache.pods.Items { nsPodCounts[p.Namespace]++ }
	}
	type nsPod struct { NS string `json:"ns"`; Pods int `json:"pods"` }
	topNS := make([]nsPod, 0, len(nsPodCounts))
	for ns, c := range nsPodCounts { topNS = append(topNS, nsPod{ns, c}) }
	sort.Slice(topNS, func(i, j int) bool { return topNS[i].Pods > topNS[j].Pods })
	if len(topNS) > 8 { topNS = topNS[:8] }

	type miniEvt struct {
		Type    string `json:"type"`
		Reason  string `json:"reason"`
		Object  string `json:"object"`
		Message string `json:"message"`
		Age     string `json:"age"`
		NS      string `json:"ns"`
	}
	recentEvents := make([]miniEvt, 0)
	if cache.events != nil {
		cutoff := time.Now().Add(-30 * time.Minute)
		for _, e := range cache.events.Items {
			if e.Type != "Warning" { continue }
			ts := e.LastTimestamp.Time
			if ts.IsZero() { ts = e.CreationTimestamp.Time }
			if ts.Before(cutoff) { continue }
			recentEvents = append(recentEvents, miniEvt{e.Type, e.Reason, e.InvolvedObject.Kind + "/" + e.InvolvedObject.Name, e.Message, shortDur(time.Since(ts)), e.Namespace})
		}
		sort.Slice(recentEvents, func(i, j int) bool { return recentEvents[i].Age < recentEvents[j].Age })
		if len(recentEvents) > 15 { recentEvents = recentEvents[:15] }
	}

	jGz(w, r, map[string]interface{}{
		"nodes": nodesInfo, "nodesReady": readyNodes, "nodesTotal": totalNodes,
		"pods":        map[string]int{"running": running, "pending": pending, "failed": failed, "succeeded": succeeded, "total": totalPods},
		"deployments": map[string]int{"ready": readyDeploys, "total": totalDeploys},
		"namespaces":  nsCount,
		"cacheAgeMs":  time.Since(cache.lastRefresh).Milliseconds(),
		"cluster": map[string]int64{
			"cpuCapacityM": totalCpuCapM, "memCapacityMi": totalMemCapMi,
			"cpuAllocatableM": totalCpuAllocM, "memAllocatableMi": totalMemAllocMi,
			"cpuUsedM": totalCpuUsedM, "memUsedMi": totalMemUsedMi,
		},
		"counts": map[string]int{
			"services": svcCount, "ingresses": ingCount, "statefulsets": stsCount,
			"daemonsets": dsCount, "jobs": jobCount, "cronjobs": cjCount,
		},
		"topNamespaces": topNS,
		"warnings": recentEvents,
	})
}
