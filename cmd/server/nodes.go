package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// ─── Nodes ───────────────────────────────────────────────────────────

func apiNodes(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.nodes == nil { je(w, "cache not ready", 503); return }

	type nd struct {
		Name         string `json:"name"`
		Ready        bool   `json:"ready"`
		Cordoned     bool   `json:"cordoned"`
		Nodepool     string `json:"nodepool"`
		Age          string `json:"age"`
		CPU          int64  `json:"allocCpuM"`
		Mem          int64  `json:"allocMemMi"`
		UsedCPU      int64  `json:"usedCpuM"`
		UsedMem      int64  `json:"usedMemMi"`
		Pods         int    `json:"pods"`
		PodCapacity  int    `json:"podCapacity"`
		InstanceType string `json:"instanceType"`
		Zone         string `json:"zone"`
		CapacityType string `json:"capacityType"`
		Arch         string `json:"arch"`
		Kubelet      string `json:"kubelet"`
		Runtime      string `json:"runtime"`
		InternalIP   string `json:"internalIp"`
		Taints       int    `json:"taints"`
		Conditions   []string `json:"conditions"`
	}
	podCount := map[string]int{}
	if cache.pods != nil {
		for _, p := range cache.pods.Items { podCount[p.Spec.NodeName]++ }
	}
	metricsMap := map[string][2]int64{}
	if cache.nodeMetrics != nil {
		for _, m := range cache.nodeMetrics.Items {
			metricsMap[m.Name] = [2]int64{m.Usage.Cpu().MilliValue(), m.Usage.Memory().Value() / (1024 * 1024)}
		}
	}
	out := make([]nd, 0, len(cache.nodes.Items))
	for _, n := range cache.nodes.Items {
		ready := false
		var badConditions []string
		for _, cond := range n.Status.Conditions {
			if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue { ready = true }
			if cond.Type == corev1.NodeMemoryPressure && cond.Status == corev1.ConditionTrue { badConditions = append(badConditions, "MemoryPressure") }
			if cond.Type == corev1.NodeDiskPressure && cond.Status == corev1.ConditionTrue { badConditions = append(badConditions, "DiskPressure") }
			if cond.Type == corev1.NodePIDPressure && cond.Status == corev1.ConditionTrue { badConditions = append(badConditions, "PIDPressure") }
			if cond.Type == corev1.NodeNetworkUnavailable && cond.Status == corev1.ConditionTrue { badConditions = append(badConditions, "NetworkUnavailable") }
		}
		m := metricsMap[n.Name]
		nodepool := ""
		if v, ok := n.Labels["karpenter.sh/nodepool"]; ok { nodepool = v }

		instanceType := n.Labels["node.kubernetes.io/instance-type"]
		if instanceType == "" { instanceType = n.Labels["beta.kubernetes.io/instance-type"] }

		zone := n.Labels["topology.kubernetes.io/zone"]
		if zone == "" { zone = n.Labels["failure-domain.beta.kubernetes.io/zone"] }

		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" { capType = strings.ToLower(n.Labels["eks.amazonaws.com/capacityType"]) }

		internalIP := ""
		for _, a := range n.Status.Addresses {
			if a.Type == corev1.NodeInternalIP { internalIP = a.Address; break }
		}

		podCap := 0
		if pc, ok := n.Status.Allocatable["pods"]; ok { podCap = int(pc.Value()) }

		si := n.Status.NodeInfo
		kubelet := si.KubeletVersion
		runtime := si.ContainerRuntimeVersion

		out = append(out, nd{
			Name: n.Name, Ready: ready, Cordoned: n.Spec.Unschedulable,
			Nodepool: nodepool,
			Age: shortDur(time.Since(n.CreationTimestamp.Time)),
			CPU: n.Status.Allocatable.Cpu().MilliValue(), Mem: n.Status.Allocatable.Memory().Value() / (1024 * 1024),
			UsedCPU: m[0], UsedMem: m[1],
			Pods: podCount[n.Name], PodCapacity: podCap,
			InstanceType: instanceType, Zone: zone, CapacityType: capType,
			Arch: si.Architecture, Kubelet: kubelet, Runtime: runtime,
			InternalIP: internalIP, Taints: len(n.Spec.Taints), Conditions: badConditions,
		})
	}
	jGz(w, r, out)
}

func apiNodeAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/nodes/"), "/"), "/")
	if len(parts) < 2 {
		je(w, "use /api/nodes/{name}/{describe|cordon|uncordon|drain}", 400)
		return
	}
	name, action := parts[0], parts[1]

	if action == "describe" {
		c, cancel := ctx()
		defer cancel()

		var node *corev1.Node
		var podList *corev1.PodList
		var evtList *corev1.EventList
		var nodeErr error
		usedCPU, usedMem := int64(0), int64(0)

		var dwg sync.WaitGroup
		dwg.Add(4)
		go func() {
			defer dwg.Done()
			node, nodeErr = clientset.CoreV1().Nodes().Get(c, name, metav1.GetOptions{})
		}()
		go func() {
			defer dwg.Done()
			podList, _ = clientset.CoreV1().Pods("").List(c, metav1.ListOptions{FieldSelector: "spec.nodeName=" + name})
		}()
		go func() {
			defer dwg.Done()
			if metricsCl != nil {
				if nm, err := metricsCl.MetricsV1beta1().NodeMetricses().Get(c, name, metav1.GetOptions{}); err == nil {
					usedCPU = nm.Usage.Cpu().MilliValue()
					usedMem = nm.Usage.Memory().Value() / (1024 * 1024)
				}
			}
		}()
		go func() {
			defer dwg.Done()
			evtList, _ = clientset.CoreV1().Events("").List(c, metav1.ListOptions{
				FieldSelector: "involvedObject.name=" + name + ",involvedObject.kind=Node",
			})
		}()
		dwg.Wait()

		if nodeErr != nil {
			jk8s(w, nodeErr)
			return
		}

		status := "NotReady"
		for _, cnd := range node.Status.Conditions {
			if cnd.Type == corev1.NodeReady && cnd.Status == corev1.ConditionTrue {
				status = "Ready"
			}
		}
		if node.Spec.Unschedulable {
			status += ",SchedulingDisabled"
		}

		role := "<none>"
		for k := range node.Labels {
			if k == "node-role.kubernetes.io/master" || k == "node-role.kubernetes.io/control-plane" {
				role = "control-plane"
			} else if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				r := strings.TrimPrefix(k, "node-role.kubernetes.io/")
				if r != "" {
					role = r
				}
			}
		}

		addresses := make([]map[string]string, 0)
		for _, a := range node.Status.Addresses {
			addresses = append(addresses, map[string]string{"type": string(a.Type), "address": a.Address})
		}

		conditions := make([]map[string]string, 0)
		for _, cnd := range node.Status.Conditions {
			age := ""
			if !cnd.LastTransitionTime.IsZero() {
				age = shortDur(time.Since(cnd.LastTransitionTime.Time))
			}
			conditions = append(conditions, map[string]string{
				"type":    string(cnd.Type),
				"status":  string(cnd.Status),
				"reason":  cnd.Reason,
				"message": cnd.Message,
				"age":     age,
			})
		}

		taints := make([]map[string]string, 0)
		for _, t := range node.Spec.Taints {
			taints = append(taints, map[string]string{
				"key":    t.Key,
				"value":  t.Value,
				"effect": string(t.Effect),
			})
		}

		capacity := map[string]string{
			"cpu":    node.Status.Capacity.Cpu().String(),
			"memory": fmt.Sprintf("%dMi", node.Status.Capacity.Memory().Value()/(1024*1024)),
			"pods":   node.Status.Capacity.Pods().String(),
		}
		allocatable := map[string]string{
			"cpu":    node.Status.Allocatable.Cpu().String(),
			"memory": fmt.Sprintf("%dMi", node.Status.Allocatable.Memory().Value()/(1024*1024)),
			"pods":   node.Status.Allocatable.Pods().String(),
		}

		si := node.Status.NodeInfo
		sysInfo := map[string]string{
			"os":              si.OperatingSystem,
			"arch":            si.Architecture,
			"kernel":          si.KernelVersion,
			"containerRuntime": si.ContainerRuntimeVersion,
			"kubelet":         si.KubeletVersion,
			"kubeProxy":       si.KubeProxyVersion,
			"osImage":         si.OSImage,
		}

		labels := map[string]string{}
		for k, v := range node.Labels {
			labels[k] = v
		}

		images := make([]map[string]interface{}, 0)
		for _, img := range node.Status.Images {
			names := img.Names
			if len(names) > 1 {
				names = names[1:]
			}
			images = append(images, map[string]interface{}{
				"names": names,
				"size":  img.SizeBytes / (1024 * 1024),
			})
		}

		type podSummary struct {
			Name   string `json:"name"`
			NS     string `json:"namespace"`
			Status string `json:"status"`
			Ready  string `json:"ready"`
			Age    string `json:"age"`
		}
		pods := make([]podSummary, 0)
		if podList != nil {
			for _, p := range podList.Items {
				readyCt, totalCt := 0, len(p.Spec.Containers)
				for _, cs := range p.Status.ContainerStatuses {
					if cs.Ready {
						readyCt++
					}
				}
			pods = append(pods, podSummary{
				Name:   p.Name,
				NS:     p.Namespace,
				Status: podDisplayStatus(p),
				Ready:  fmt.Sprintf("%d/%d", readyCt, totalCt),
				Age:    shortDur(time.Since(p.CreationTimestamp.Time)),
			})
			}
		}

		// Aggregate pod requests and limits (matches kubectl describe node logic).
		// For each pod: sum regular containers, then take max(init, regular) per resource.
		var reqCPU, limCPU int64
		var reqMemBytes, limMemBytes int64
		if podList != nil {
			for _, p := range podList.Items {
				if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
					continue
				}
				// Sum regular containers
				var pReqCPU, pLimCPU int64
				var pReqMem, pLimMem int64
				for _, ct := range p.Spec.Containers {
					pReqCPU += ct.Resources.Requests.Cpu().MilliValue()
					pReqMem += ct.Resources.Requests.Memory().Value()
					pLimCPU += ct.Resources.Limits.Cpu().MilliValue()
					pLimMem += ct.Resources.Limits.Memory().Value()
				}
				// Init containers: take max(init, regular) per resource
				for _, ct := range p.Spec.InitContainers {
					if v := ct.Resources.Requests.Cpu().MilliValue(); v > pReqCPU {
						pReqCPU = v
					}
					if v := ct.Resources.Requests.Memory().Value(); v > pReqMem {
						pReqMem = v
					}
					if v := ct.Resources.Limits.Cpu().MilliValue(); v > pLimCPU {
						pLimCPU = v
					}
					if v := ct.Resources.Limits.Memory().Value(); v > pLimMem {
						pLimMem = v
					}
				}
				reqCPU += pReqCPU
				reqMemBytes += pReqMem
				limCPU += pLimCPU
				limMemBytes += pLimMem
			}
		}
		reqMem := reqMemBytes / (1024 * 1024)
		limMem := limMemBytes / (1024 * 1024)

		allocCPU := node.Status.Allocatable.Cpu().MilliValue()
		allocMem := node.Status.Allocatable.Memory().Value() / (1024 * 1024)
		cpuPct, memPct := 0, 0
		if allocCPU > 0 {
			cpuPct = int(usedCPU * 100 / allocCPU)
		}
		if allocMem > 0 {
			memPct = int(usedMem * 100 / allocMem)
		}

		type nodeEvent struct {
			Type    string `json:"type"`
			Reason  string `json:"reason"`
			Age     string `json:"age"`
			From    string `json:"from"`
			Message string `json:"message"`
			Count   int32  `json:"count"`
		}
		nodeEvents := make([]nodeEvent, 0)
		if evtList != nil {
			for _, e := range evtList.Items {
				ts := e.LastTimestamp.Time
				if ts.IsZero() {
					ts = e.EventTime.Time
				}
				if ts.IsZero() {
					ts = e.CreationTimestamp.Time
				}
				nodeEvents = append(nodeEvents, nodeEvent{
					Type:    e.Type,
					Reason:  e.Reason,
					Age:     shortDur(time.Since(ts)),
					From:    e.Source.Component,
					Message: e.Message,
					Count:   e.Count,
				})
			}
		}

		j(w, map[string]interface{}{
			"name":        node.Name,
			"status":      status,
			"role":        role,
			"age":         shortDur(time.Since(node.CreationTimestamp.Time)),
			"version":     si.KubeletVersion,
			"cordoned":    node.Spec.Unschedulable,
			"addresses":   addresses,
			"conditions":  conditions,
			"taints":      taints,
			"capacity":    capacity,
			"allocatable": allocatable,
			"systemInfo":  sysInfo,
			"labels":      labels,
			"images":      images,
			"pods":        pods,
			"events":      nodeEvents,
			"usedCpuM":    usedCPU,
			"usedMemMi":   usedMem,
			"allocCpuM":   allocCPU,
			"allocMemMi":  allocMem,
			"cpuPercent":  cpuPct,
			"memPercent":  memPct,
			"requestsCpuM":  reqCPU,
			"requestsMemMi": reqMem,
			"limitsCpuM":    limCPU,
			"limitsMemMi":   limMem,
		})
		return
	}

	if action == "pod-usage" {
		cache.mu.RLock()
		defer cache.mu.RUnlock()

		var allocCPU, allocMem int64
		if cache.nodes != nil {
			for i := range cache.nodes.Items {
				if cache.nodes.Items[i].Name == name {
					allocCPU = cache.nodes.Items[i].Status.Allocatable.Cpu().MilliValue()
					allocMem = cache.nodes.Items[i].Status.Allocatable.Memory().Value() / (1024 * 1024)
					break
				}
			}
		}
		if allocCPU == 0 {
			je(w, "node not found", 404)
			return
		}

		pmMap := cache.podMetricsMap

		type puPod struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
			CpuUsedM  int64  `json:"cpuUsedM"`
			MemUsedMi int64  `json:"memUsedMi"`
			CpuReqM   int64  `json:"cpuReqM"`
			CpuLimM   int64  `json:"cpuLimM"`
			MemReqMi  int64  `json:"memReqMi"`
			MemLimMi  int64  `json:"memLimMi"`
			Status    string `json:"status"`
			Ready     string `json:"ready"`
			Age       string `json:"age"`
		}

		var pods []puPod
		var totalCPU, totalMem int64
		if cache.pods != nil {
			for _, p := range cache.pods.Items {
				if p.Spec.NodeName != name { continue }
				if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed { continue }

				usage := pmMap[p.Namespace+"/"+p.Name]
				var cpuReq, cpuLim, memReq, memLim int64
				for _, ct := range p.Spec.Containers {
					cpuReq += ct.Resources.Requests.Cpu().MilliValue()
					cpuLim += ct.Resources.Limits.Cpu().MilliValue()
					memReq += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
					memLim += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
				}

				readyCt, totalCt := 0, len(p.Spec.Containers)
				for _, cs := range p.Status.ContainerStatuses {
					if cs.Ready { readyCt++ }
				}

				totalCPU += usage[0]
				totalMem += usage[1]
				pods = append(pods, puPod{
					Name: p.Name, Namespace: p.Namespace,
					CpuUsedM: usage[0], MemUsedMi: usage[1],
					CpuReqM: cpuReq, CpuLimM: cpuLim,
					MemReqMi: memReq, MemLimMi: memLim,
					Status: podDisplayStatus(p),
					Ready: fmt.Sprintf("%d/%d", readyCt, totalCt),
					Age: shortDur(time.Since(p.CreationTimestamp.Time)),
				})
			}
		}

		sort.Slice(pods, func(i, k int) bool { return pods[i].CpuUsedM > pods[k].CpuUsedM })

		cpuPct, memPct := 0, 0
		if allocCPU > 0 { cpuPct = int(totalCPU * 100 / allocCPU) }
		if allocMem > 0 { memPct = int(totalMem * 100 / allocMem) }

		if pods == nil { pods = []puPod{} }
		j(w, map[string]interface{}{
			"node":     map[string]int64{"allocCpuM": allocCPU, "allocMemMi": allocMem},
			"pods":     pods,
			"pressure": map[string]int{"cpuPct": cpuPct, "memPct": memPct},
		})
		return
	}

	if action == "drain-preview" {
		c, cancel := ctx()
		defer cancel()
		pods, err := clientset.CoreV1().Pods("").List(c, metav1.ListOptions{FieldSelector: "spec.nodeName=" + name})
		if err != nil { jk8s(w, err); return }

		cache.mu.RLock()
		pdbList := cache.pdbs
		cache.mu.RUnlock()

		type podEntry struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
			Owner     string `json:"owner"`
			OwnerKind string `json:"ownerKind"`
			Category  string `json:"category"`
			Warning   string `json:"warning,omitempty"`
			PDBName   string `json:"pdbName,omitempty"`
			PDBAllow  int32  `json:"pdbAllow,omitempty"`
		}
		var entries []podEntry
		summary := map[string]int{"total": 0, "evictable": 0, "daemonSet": 0, "standalone": 0, "localStorage": 0, "pdbBlocked": 0}

		for _, p := range pods.Items {
			if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
				continue
			}
			summary["total"]++
			ownerKind, ownerName := "", ""
			for _, ref := range p.OwnerReferences {
				ownerKind = ref.Kind
				ownerName = ref.Name
				break
			}
			if ownerKind == "DaemonSet" {
				entries = append(entries, podEntry{Name: p.Name, Namespace: p.Namespace, Owner: ownerName, OwnerKind: ownerKind, Category: "daemonSet"})
				summary["daemonSet"]++
				continue
			}
			cat := "normal"
			warn := ""
			if ownerKind == "" {
				cat = "standalone"
				warn = "No controller — will NOT be rescheduled"
				summary["standalone"]++
			}
			hasLocal := false
			for _, v := range p.Spec.Volumes {
				if v.EmptyDir != nil { hasLocal = true; break }
			}
			if hasLocal && cat == "normal" {
				cat = "localStorage"
				warn = "emptyDir data will be lost"
				summary["localStorage"]++
			}

			var pdbName string
			var pdbAllow int32
			pdbBlocked := false
			if pdbList != nil {
				for _, pdb := range pdbList.Items {
					if pdb.Namespace != p.Namespace { continue }
					if pdb.Spec.Selector == nil || len(pdb.Spec.Selector.MatchLabels) == 0 { continue }
					match := true
					for k, v := range pdb.Spec.Selector.MatchLabels {
						if p.Labels[k] != v { match = false; break }
					}
					if match {
						pdbName = pdb.Name
						pdbAllow = pdb.Status.DisruptionsAllowed
						if pdbAllow == 0 {
							pdbBlocked = true
						}
						break
					}
				}
			}
			if pdbBlocked && cat == "normal" {
				cat = "pdbBlocked"
				warn = fmt.Sprintf("PDB %s allows 0 disruptions", pdbName)
				summary["pdbBlocked"]++
			}
			if cat == "normal" {
				summary["evictable"]++
			}
			entry := podEntry{Name: p.Name, Namespace: p.Namespace, Owner: ownerName, OwnerKind: ownerKind, Category: cat, Warning: warn}
			if pdbName != "" { entry.PDBName = pdbName; entry.PDBAllow = pdbAllow }
			entries = append(entries, entry)
		}
		if entries == nil { entries = []podEntry{} }
		j(w, map[string]interface{}{"pods": entries, "summary": summary})
		return
	}

	isStreamDrain := action == "drain" && r.URL.Query().Get("stream") == "true"
	if r.Method != "POST" && !isStreamDrain {
		je(w, "POST only", 405)
		return
	}
	if !requireAdmin(w, r) { return }
	c, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	switch action {
	case "cordon":
		err := patchUnschedulable(c, name, true)
		if err != nil {
			jk8s(w, err)
			return
		}
		go cache.refresh()
		j(w, map[string]string{"ok": "cordoned"})
	case "uncordon":
		err := patchUnschedulable(c, name, false)
		if err != nil {
			jk8s(w, err)
			return
		}
		go cache.refresh()
		j(w, map[string]string{"ok": "uncordoned"})
	case "drain":
		stream := r.URL.Query().Get("stream") == "true"
		_ = patchUnschedulable(c, name, true)
		pods, err := clientset.CoreV1().Pods("").List(c, metav1.ListOptions{FieldSelector: "spec.nodeName=" + name})
		if err != nil {
			jk8s(w, err)
			return
		}
		if stream {
			flusher, ok := w.(http.Flusher)
			if !ok { je(w, "streaming not supported", 500); return }
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			evicted, failed := 0, 0
			for _, p := range pods.Items {
				if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed { continue }
				isDaemon := false
				for _, ref := range p.OwnerReferences { if ref.Kind == "DaemonSet" { isDaemon = true; break } }
				if isDaemon { continue }
				ev := &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: p.Namespace}}
				fmt.Fprintf(w, "data: {\"pod\":%q,\"ns\":%q,\"status\":\"evicting\"}\n\n", p.Name, p.Namespace)
				flusher.Flush()
				if err := clientset.CoreV1().Pods(p.Namespace).EvictV1(c, ev); err != nil {
					fmt.Fprintf(w, "data: {\"pod\":%q,\"ns\":%q,\"status\":\"failed\",\"error\":%q}\n\n", p.Name, p.Namespace, err.Error())
					flusher.Flush()
					failed++
				} else {
					fmt.Fprintf(w, "data: {\"pod\":%q,\"ns\":%q,\"status\":\"evicted\"}\n\n", p.Name, p.Namespace)
					flusher.Flush()
					evicted++
				}
			}
			fmt.Fprintf(w, "data: {\"done\":true,\"evicted\":%d,\"failed\":%d}\n\n", evicted, failed)
			flusher.Flush()
			go cache.refresh()
		} else {
			evicted := 0
			for _, p := range pods.Items {
				skip := false
				for _, ref := range p.OwnerReferences { if ref.Kind == "DaemonSet" { skip = true } }
				if skip { continue }
				ev := &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: p.Namespace}}
				if err := clientset.CoreV1().Pods(p.Namespace).EvictV1(c, ev); err == nil { evicted++ }
			}
			go cache.refresh()
			j(w, map[string]interface{}{"ok": "drained", "evicted": evicted})
		}
	default:
		je(w, "unknown action", 400)
	}
}

func patchUnschedulable(c context.Context, name string, val bool) error {
	patch := fmt.Sprintf(`{"spec":{"unschedulable":%t}}`, val)
	_, err := clientset.CoreV1().Nodes().Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
	return err
}
