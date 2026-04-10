package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	autov2 "k8s.io/api/autoscaling/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── PDB Status ─────────────────────────────────────────────────────
func apiPDBs(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.pdbs == nil {
		j(w, []struct{}{})
		return
	}
	type pdbInfo struct {
		Name               string `json:"name"`
		Namespace          string `json:"namespace"`
		MinAvailable       string `json:"minAvailable"`
		MaxUnavailable     string `json:"maxUnavailable"`
		CurrentHealthy     int32  `json:"currentHealthy"`
		DesiredHealthy     int32  `json:"desiredHealthy"`
		DisruptionsAllowed int32  `json:"disruptionsAllowed"`
		ExpectedPods       int32  `json:"expectedPods"`
		Status             string `json:"status"`
		MatchLabels        map[string]string `json:"matchLabels"`
		Age                string `json:"age"`
	}
	out := make([]pdbInfo, 0, len(cache.pdbs.Items))
	for _, p := range cache.pdbs.Items {
		info := pdbInfo{
			Name:               p.Name,
			Namespace:          p.Namespace,
			CurrentHealthy:     p.Status.CurrentHealthy,
			DesiredHealthy:     p.Status.DesiredHealthy,
			DisruptionsAllowed: p.Status.DisruptionsAllowed,
			ExpectedPods:       p.Status.ExpectedPods,
			Age:                time.Since(p.CreationTimestamp.Time).Truncate(time.Second).String(),
		}
		if p.Spec.MinAvailable != nil {
			info.MinAvailable = p.Spec.MinAvailable.String()
		}
		if p.Spec.MaxUnavailable != nil {
			info.MaxUnavailable = p.Spec.MaxUnavailable.String()
		}
		if p.Spec.Selector != nil {
			info.MatchLabels = p.Spec.Selector.MatchLabels
		}
		if p.Status.DisruptionsAllowed == 0 && p.Status.CurrentHealthy <= p.Status.DesiredHealthy {
			info.Status = "blocking"
		} else if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
			info.Status = "degraded"
		} else {
			info.Status = "healthy"
		}
		out = append(out, info)
	}
	j(w, out)
}

// ─── CronJob Execution History ──────────────────────────────────────
func apiCronJobHistory(w http.ResponseWriter, r *http.Request) {
	// Dispatch POST /api/cronjobs/<namespace>/<name>/trigger to trigger handler
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/cronjobs/")
	if r.Method == http.MethodPost && strings.HasSuffix(trimmed, "/trigger") {
		apiCronJobTrigger(w, r)
		return
	}

	name := trimmed
	ns := r.URL.Query().Get("namespace")
	if name == "" || ns == "" {
		je(w, "need name and namespace", 400)
		return
	}
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	var cronJob *batchv1.CronJob
	if cache.cronjobs != nil {
		for i := range cache.cronjobs.Items {
			cj := &cache.cronjobs.Items[i]
			if cj.Name == name && cj.Namespace == ns {
				cronJob = cj
				break
			}
		}
	}
	if cronJob == nil {
		je(w, "cronjob not found", 404)
		return
	}

	type jobRun struct {
		Name       string  `json:"name"`
		StartTime  *string `json:"startTime"`
		EndTime    *string `json:"endTime"`
		DurationS  float64 `json:"durationS"`
		Status     string  `json:"status"`
		Succeeded  int32   `json:"succeeded"`
		Failed     int32   `json:"failed"`
		Active     int32   `json:"active"`
	}
	var runs []jobRun
	if cache.jobs != nil {
		for _, job := range cache.jobs.Items {
			if job.Namespace != ns { continue }
			owned := false
			for _, ref := range job.OwnerReferences {
				if ref.Kind == "CronJob" && ref.Name == name {
					owned = true
					break
				}
			}
			if !owned { continue }
			run := jobRun{
				Name:      job.Name,
				Succeeded: job.Status.Succeeded,
				Failed:    job.Status.Failed,
				Active:    job.Status.Active,
			}
			if job.Status.StartTime != nil {
				s := job.Status.StartTime.Time.Format(time.RFC3339)
				run.StartTime = &s
			}
			if job.Status.CompletionTime != nil {
				e := job.Status.CompletionTime.Time.Format(time.RFC3339)
				run.EndTime = &e
				if job.Status.StartTime != nil {
					run.DurationS = job.Status.CompletionTime.Time.Sub(job.Status.StartTime.Time).Seconds()
				}
			}
			if job.Status.Active > 0 {
				run.Status = "running"
			} else if job.Status.Succeeded > 0 {
				run.Status = "succeeded"
			} else if job.Status.Failed > 0 {
				run.Status = "failed"
			} else {
				run.Status = "unknown"
			}
			runs = append(runs, run)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].StartTime == nil { return false }
		if runs[j].StartTime == nil { return true }
		return *runs[i].StartTime > *runs[j].StartTime
	})

	suspended := false
	if cronJob.Spec.Suspend != nil {
		suspended = *cronJob.Spec.Suspend
	}
	var lastSchedule *string
	if cronJob.Status.LastScheduleTime != nil {
		s := cronJob.Status.LastScheduleTime.Time.Format(time.RFC3339)
		lastSchedule = &s
	}
	j(w, map[string]interface{}{
		"name":         cronJob.Name,
		"namespace":    cronJob.Namespace,
		"schedule":     cronJob.Spec.Schedule,
		"suspended":    suspended,
		"lastSchedule": lastSchedule,
		"activeCount":  len(cronJob.Status.Active),
		"runs":         runs,
	})
}

// ─── CronJob Manual Trigger ──────────────────────────────────────────
func apiCronJobTrigger(w http.ResponseWriter, r *http.Request) {
	// Parse /api/cronjobs/<namespace>/<name>/trigger
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/cronjobs/")
	trimmed = strings.TrimSuffix(trimmed, "/trigger")
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "namespace and name required"})
		return
	}
	namespace, name := parts[0], parts[1]

	if !requireAdminOrJIT(w, r, namespace, "CronJob", name) {
		return
	}

	email := "anonymous"
	role := defaultRole
	if authEnabled {
		if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
			email = sd.Email
			role = sd.Role
		}
	}

	c, cancel := ctx()
	defer cancel()

	cronJob, err := clientset.BatchV1().CronJobs(namespace).Get(c, name, metav1.GetOptions{})
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(err.Error(), "not found") {
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(map[string]string{"error": "cronjob not found"})
		} else {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		}
		return
	}

	timestamp := time.Now().Unix()
	jobName := fmt.Sprintf("%s-manual-%d", name, timestamp)

	labels := map[string]string{"triggered-by": "kube-argus"}
	for k, v := range cronJob.Spec.JobTemplate.Labels {
		labels[k] = v
	}

	isController := true
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: namespace,
			Labels:    labels,
			OwnerReferences: []metav1.OwnerReference{
				{
					APIVersion:         "batch/v1",
					Kind:               "CronJob",
					Name:               cronJob.Name,
					UID:                cronJob.UID,
					Controller:         &isController,
					BlockOwnerDeletion: &isController,
				},
			},
		},
		Spec: cronJob.Spec.JobTemplate.Spec,
	}

	created, err := clientset.BatchV1().Jobs(namespace).Create(c, job, metav1.CreateOptions{})
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	auditRecord(email, role, "cronjob.trigger", fmt.Sprintf("CronJob %s/%s", namespace, name), "job: "+created.Name, clientIP(r))

	j(w, map[string]string{"job": created.Name, "namespace": namespace})
}

// ─── Namespace Cost Allocation ──────────────────────────────────────
func apiNamespaceCosts(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	pods := cache.pods
	nodes := cache.nodes
	cache.mu.RUnlock()

	spotCache.mu.RLock()
	spotPrices := spotCache.spotPrices
	spotCache.mu.RUnlock()

	if pods == nil || nodes == nil {
		j(w, []struct{}{})
		return
	}

	nodeCost := map[string]float64{}

	for _, n := range nodes.Items {
		instanceType := n.Labels["node.kubernetes.io/instance-type"]
		isSpot := n.Labels["karpenter.sh/capacity-type"] == "spot" || n.Labels["eks.amazonaws.com/capacityType"] == "SPOT"
		hourly := 0.0
		if isSpot && spotPrices != nil {
			hourly = spotPrices[instanceType]
		}
		if hourly == 0 && instanceType != "" {
			hourly = estimateOnDemandHourly(instanceType)
		}
		if hourly == 0 {
			if isSpot {
				hourly = 0.05
			} else {
				hourly = 0.10
			}
		}
		nodeCost[n.Name] = hourly
	}

	type nsCost struct {
		cpuReq float64
		memReq float64
	}
	nodeNS := map[string]map[string]*nsCost{}
	for _, p := range pods.Items {
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed { continue }
		nn := p.Spec.NodeName
		if nn == "" { continue }
		if _, ok := nodeNS[nn]; !ok {
			nodeNS[nn] = map[string]*nsCost{}
		}
		if _, ok := nodeNS[nn][p.Namespace]; !ok {
			nodeNS[nn][p.Namespace] = &nsCost{}
		}
		for _, c := range p.Spec.Containers {
			nodeNS[nn][p.Namespace].cpuReq += c.Resources.Requests.Cpu().AsApproximateFloat64()
			nodeNS[nn][p.Namespace].memReq += c.Resources.Requests.Memory().AsApproximateFloat64()
		}
	}

	nsTotals := map[string]float64{}
	for nn, nsMap := range nodeNS {
		totalCPUOnNode := 0.0
		totalMemOnNode := 0.0
		for _, c := range nsMap {
			totalCPUOnNode += c.cpuReq
			totalMemOnNode += c.memReq
		}
		if totalCPUOnNode == 0 && totalMemOnNode == 0 { continue }
		hourly := nodeCost[nn]
		for nsName, c := range nsMap {
			cpuShare := 0.0
			memShare := 0.0
			if totalCPUOnNode > 0 { cpuShare = c.cpuReq / totalCPUOnNode }
			if totalMemOnNode > 0 { memShare = c.memReq / totalMemOnNode }
			share := (cpuShare + memShare) / 2
			nsTotals[nsName] += hourly * share
		}
	}

	type nsEntry struct {
		Namespace   string  `json:"namespace"`
		HourlyCost float64 `json:"hourlyCost"`
		MonthlyCost float64 `json:"monthlyCost"`
	}
	nsOut := make([]nsEntry, 0, len(nsTotals))
	for nsName, h := range nsTotals {
		nsOut = append(nsOut, nsEntry{
			Namespace:   nsName,
			HourlyCost:  math.Round(h*10000) / 10000,
			MonthlyCost: math.Round(h*730*100) / 100,
		})
	}
	sort.Slice(nsOut, func(i, k int) bool { return nsOut[i].MonthlyCost > nsOut[k].MonthlyCost })

	npTotals := map[string]float64{}
	npNodes := map[string]int{}
	for _, n := range nodes.Items {
		np := n.Labels["karpenter.sh/nodepool"]
		if np == "" { np = "default" }
		npTotals[np] += nodeCost[n.Name]
		npNodes[np]++
	}
	type npEntry struct {
		Nodepool    string  `json:"nodepool"`
		Nodes       int     `json:"nodes"`
		HourlyCost float64 `json:"hourlyCost"`
		MonthlyCost float64 `json:"monthlyCost"`
	}
	npOut := make([]npEntry, 0, len(npTotals))
	for np, h := range npTotals {
		npOut = append(npOut, npEntry{
			Nodepool:    np,
			Nodes:       npNodes[np],
			HourlyCost:  math.Round(h*10000) / 10000,
			MonthlyCost: math.Round(h*730*100) / 100,
		})
	}
	sort.Slice(npOut, func(i, k int) bool { return npOut[i].MonthlyCost > npOut[k].MonthlyCost })

	j(w, map[string]interface{}{
		"namespaces": nsOut,
		"nodepools":  npOut,
	})
}

func estimateOnDemandHourly(instanceType string) float64 {
	priceMap := map[string]float64{
		"m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384, "m5.4xlarge": 0.768,
		"m6i.large": 0.096, "m6i.xlarge": 0.192, "m6i.2xlarge": 0.384, "m6i.4xlarge": 0.768,
		"c5.large": 0.085, "c5.xlarge": 0.170, "c5.2xlarge": 0.340, "c5.4xlarge": 0.680,
		"c6i.large": 0.085, "c6i.xlarge": 0.170, "c6i.2xlarge": 0.340, "c6i.4xlarge": 0.680,
		"r5.large": 0.126, "r5.xlarge": 0.252, "r5.2xlarge": 0.504, "r5.4xlarge": 1.008,
		"r6i.large": 0.126, "r6i.xlarge": 0.252, "r6i.2xlarge": 0.504, "r6i.4xlarge": 1.008,
		"t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664,
	}
	if p, ok := priceMap[instanceType]; ok {
		return p
	}
	return 0
}

// ─── Spot Disruption Visibility ─────────────────────────────────────

func apiSpotInterruptions(w http.ResponseWriter, r *http.Request) {
	nsFilter := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	// Build node metadata maps
	nodeCapMap := map[string]string{}   // node -> "spot" / "on-demand" / ""
	nodePoolMap := map[string]string{}  // node -> nodepool
	nodeInstMap := map[string]string{}  // node -> instance type
	nodeZoneMap := map[string]string{}  // node -> zone
	if cache.nodes != nil {
		for _, n := range cache.nodes.Items {
			cap := n.Labels["karpenter.sh/capacity-type"]
			if cap == "" { cap = strings.ToLower(n.Labels["eks.amazonaws.com/capacityType"]) }
			if cap == "" { cap = "unknown" }
			nodeCapMap[n.Name] = cap
			if v := n.Labels["karpenter.sh/nodepool"]; v != "" { nodePoolMap[n.Name] = v }
			inst := n.Labels["node.kubernetes.io/instance-type"]
			if inst == "" { inst = n.Labels["beta.kubernetes.io/instance-type"] }
			nodeInstMap[n.Name] = inst
			zone := n.Labels["topology.kubernetes.io/zone"]
			if zone == "" { zone = n.Labels["failure-domain.beta.kubernetes.io/zone"] }
			nodeZoneMap[n.Name] = zone
		}
	}

	// Count pods per node for affected-pods count
	nodePodCount := map[string]int{}
	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed { continue }
			nodePodCount[p.Spec.NodeName]++
		}
	}

	// --- Spot Interruption Feed ---
	spotReasons := map[string]bool{
		"SpotInterrupted": true, "TerminatingOnInterruption": true,
		"FailedDraining": true, "InstanceTerminating": true,
		"Unconsolidatable": true, "DisruptionBlocked": true,
	}

	activeNodes := map[string]bool{}
	if cache.nodes != nil {
		for _, n := range cache.nodes.Items { activeNodes[n.Name] = true }
	}

	type spotEvt struct {
		Reason       string `json:"reason"`
		Node         string `json:"node"`
		Nodepool     string `json:"nodepool"`
		InstanceType string `json:"instanceType"`
		Zone         string `json:"zone"`
		Message      string `json:"message"`
		Age          string `json:"age"`
		Timestamp    string `json:"timestamp"`
		AffectedPods int    `json:"affectedPods"`
		Active       bool   `json:"active"`
	}
	var events []spotEvt
	if cache.events != nil {
		for _, e := range cache.events.Items {
			if !spotReasons[e.Reason] { continue }
			if e.InvolvedObject.Kind != "Node" && e.InvolvedObject.Kind != "Machine" { continue }
			nodeName := e.InvolvedObject.Name
			if !activeNodes[nodeName] { continue }
			ts := e.LastTimestamp.Time
			if ts.IsZero() { ts = e.EventTime.Time }
			if ts.IsZero() { ts = e.CreationTimestamp.Time }
			events = append(events, spotEvt{
				Reason: e.Reason, Node: nodeName,
				Nodepool: nodePoolMap[nodeName], InstanceType: nodeInstMap[nodeName],
				Zone: nodeZoneMap[nodeName], Message: e.Message,
				Age: shortDur(time.Since(ts)), Timestamp: ts.Format(time.RFC3339),
				AffectedPods: nodePodCount[nodeName], Active: true,
			})
		}
	}
	sort.Slice(events, func(i, k int) bool { return events[i].Timestamp > events[k].Timestamp })
	if events == nil { events = []spotEvt{} }

	// --- Workload Resilience Score ---
	type resEntry struct {
		Name              string `json:"name"`
		Namespace         string `json:"namespace"`
		Kind              string `json:"kind"`
		Replicas          int    `json:"replicas"`
		SpotPods          int    `json:"spotPods"`
		OnDemandPods      int    `json:"onDemandPods"`
		UniqueNodes       int    `json:"uniqueNodes"`
		UniqueZones       int    `json:"uniqueZones"`
		UniqueInstTypes   int    `json:"uniqueInstTypes"`
		RecentDisruptions int    `json:"recentDisruptions"`
		Score             int    `json:"score"`
		Rating            string `json:"rating"`
	}

	labelsMatch := func(selector map[string]string, podLabels map[string]string) bool {
		for k, v := range selector {
			if podLabels[k] != v { return false }
		}
		return true
	}

	var resilience []resEntry

	type wlMeta struct {
		name, ns, kind string
		replicas       int
		selector       map[string]string
	}
	var workloads []wlMeta
	if cache.deployments != nil {
		for _, d := range cache.deployments.Items {
			if nsFilter != "" && d.Namespace != nsFilter { continue }
			r := 1; if d.Spec.Replicas != nil { r = int(*d.Spec.Replicas) }
			sel := map[string]string{}; if d.Spec.Selector != nil { sel = d.Spec.Selector.MatchLabels }
			workloads = append(workloads, wlMeta{d.Name, d.Namespace, "Deployment", r, sel})
		}
	}
	if cache.statefulsets != nil {
		for _, s := range cache.statefulsets.Items {
			if nsFilter != "" && s.Namespace != nsFilter { continue }
			r := 1; if s.Spec.Replicas != nil { r = int(*s.Spec.Replicas) }
			sel := map[string]string{}; if s.Spec.Selector != nil { sel = s.Spec.Selector.MatchLabels }
			workloads = append(workloads, wlMeta{s.Name, s.Namespace, "StatefulSet", r, sel})
		}
	}
	if cache.daemonsets != nil {
		for _, d := range cache.daemonsets.Items {
			if nsFilter != "" && d.Namespace != nsFilter { continue }
			sel := map[string]string{}; if d.Spec.Selector != nil { sel = d.Spec.Selector.MatchLabels }
			workloads = append(workloads, wlMeta{d.Name, d.Namespace, "DaemonSet", int(d.Status.DesiredNumberScheduled), sel})
		}
	}

	for _, wl := range workloads {
		if len(wl.selector) == 0 { continue }
		spotCount, odCount, disrupted := 0, 0, 0
		nodeSet := map[string]bool{}
		instSet := map[string]bool{}
		zoneSet := map[string]bool{}
		if cache.pods != nil {
			for _, p := range cache.pods.Items {
				if p.Namespace != wl.ns { continue }
				if !labelsMatch(wl.selector, p.Labels) { continue }
				nodeName := p.Spec.NodeName
				cap := nodeCapMap[nodeName]
				if cap == "spot" { spotCount++ } else { odCount++ }
				if nodeName != "" {
					nodeSet[nodeName] = true
					if it := nodeInstMap[nodeName]; it != "" { instSet[it] = true }
					if z := nodeZoneMap[nodeName]; z != "" { zoneSet[z] = true }
				}
				st := podDisplayStatus(p)
				if st != "Running" && st != "Succeeded" && st != "Completed" { disrupted++ }
				for _, cs := range p.Status.ContainerStatuses {
					if cs.RestartCount > 3 { disrupted++; break }
				}
			}
		}
		if spotCount == 0 { continue }

		totalPods := spotCount + odCount
		score := 100

		if totalPods <= 1 { score -= 40 } else if totalPods == 2 { score -= 15 }

		if len(nodeSet) <= 1 && totalPods > 1 { score -= 30 } else if len(nodeSet) < totalPods && totalPods > 2 { score -= 10 }

		if len(instSet) <= 1 && totalPods > 1 { score -= 10 }

		if len(zoneSet) <= 1 && totalPods > 1 { score -= 10 }

		score -= disrupted * 20

		rating := "high"
		if score <= 30 { rating = "low" } else if score <= 60 { rating = "medium" }

		if score < 0 { score = 0 }
		resilience = append(resilience, resEntry{
			Name: wl.name, Namespace: wl.ns, Kind: wl.kind,
			Replicas: wl.replicas, SpotPods: spotCount, OnDemandPods: odCount,
			UniqueNodes: len(nodeSet), UniqueZones: len(zoneSet), UniqueInstTypes: len(instSet),
			RecentDisruptions: disrupted, Score: score, Rating: rating,
		})
	}

	ratingOrder := map[string]int{"low": 0, "medium": 1, "high": 2}
	sort.Slice(resilience, func(i, k int) bool { return ratingOrder[resilience[i].Rating] < ratingOrder[resilience[k].Rating] })
	if resilience == nil { resilience = []resEntry{} }

	j(w, map[string]interface{}{"events": events, "resilience": resilience})
}

// ─── Topology Spread Violations ─────────────────────────────────────

func apiTopologySpread(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	if cache.pods == nil || cache.nodes == nil {
		jGz(w, r, map[string]interface{}{"workloads": []interface{}{}})
		return
	}

	nodeTopology := map[string]map[string]string{} // nodeName -> topologyKey -> value
	for _, n := range cache.nodes.Items {
		labels := map[string]string{}
		for k, v := range n.Labels {
			labels[k] = v
		}
		nodeTopology[n.Name] = labels
	}

	// Index pods by owner (deployment/statefulset name in namespace)
	type podPlacement struct {
		Name string
		NS   string
		Node string
	}
	ownerPods := map[string][]podPlacement{} // "ns/ownerKind/ownerName" -> pods
	for _, p := range cache.pods.Items {
		if p.Status.Phase != corev1.PodRunning && p.Status.Phase != corev1.PodPending {
			continue
		}
		for _, ref := range p.OwnerReferences {
			if ref.Kind == "ReplicaSet" || ref.Kind == "StatefulSet" {
				ownerKey := ""
				if ref.Kind == "ReplicaSet" {
					// Derive deployment name from ReplicaSet name (name-<hash>)
					rsName := ref.Name
					lastDash := strings.LastIndex(rsName, "-")
					if lastDash > 0 {
						ownerKey = p.Namespace + "/Deployment/" + rsName[:lastDash]
					}
				} else {
					ownerKey = p.Namespace + "/" + ref.Kind + "/" + ref.Name
				}
				if ownerKey != "" {
					ownerPods[ownerKey] = append(ownerPods[ownerKey], podPlacement{
						Name: p.Name, NS: p.Namespace, Node: p.Spec.NodeName,
					})
				}
			}
		}
	}

	type tscInfo struct {
		TopologyKey       string `json:"topologyKey"`
		TopologyLabel     string `json:"topologyLabel"`
		MaxSkew           int32  `json:"maxSkew"`
		WhenUnsatisfiable string `json:"whenUnsatisfiable"`
		Enforcement       string `json:"enforcement"`
		Description       string `json:"description"`
		LabelSelector     string `json:"labelSelector"`
	}
	type domainCount struct {
		Domain string `json:"domain"`
		Count  int    `json:"count"`
	}
	type violationInfo struct {
		Kind            string        `json:"kind"`
		Name            string        `json:"name"`
		Namespace       string        `json:"namespace"`
		Replicas        int           `json:"replicas"`
		Constraint      tscInfo       `json:"constraint"`
		ActualSkew      int           `json:"actualSkew"`
		Distribution    []domainCount `json:"distribution"`
		EmptyDomains    int           `json:"emptyDomains"`
		TotalDomains    int           `json:"totalDomains"`
		Status          string        `json:"status"`
	}

	topologyKeyLabel := func(key string) string {
		switch key {
		case "kubernetes.io/hostname":
			return "Node"
		case "topology.kubernetes.io/zone":
			return "Zone"
		case "topology.kubernetes.io/region":
			return "Region"
		case "node.kubernetes.io/instance-type":
			return "Instance Type"
		case "kubernetes.io/arch":
			return "Architecture"
		case "kubernetes.io/os":
			return "OS"
		default:
			parts := strings.Split(key, "/")
			return parts[len(parts)-1]
		}
	}

	topologyDescription := func(key string, maxSkew int32, policy string) string {
		label := topologyKeyLabel(key)
		spread := "spread across"
		if maxSkew == 1 {
			spread = "evenly distributed across"
		}
		enforcement := "must be"
		if policy == "ScheduleAnyway" {
			enforcement = "should preferably be"
		}
		switch key {
		case "kubernetes.io/hostname":
			if maxSkew == 1 {
				return fmt.Sprintf("Pods %s no more than 1 apart per node (avoid co-location on same node)", enforcement)
			}
			return fmt.Sprintf("Pods %s %s nodes (max %d skew per node)", enforcement, spread, maxSkew)
		case "topology.kubernetes.io/zone":
			return fmt.Sprintf("Pods %s %s availability zones (max %d skew)", enforcement, spread, maxSkew)
		case "node.kubernetes.io/instance-type":
			return fmt.Sprintf("Pods %s %s instance types (max %d skew)", enforcement, spread, maxSkew)
		default:
			return fmt.Sprintf("Pods %s %s %s domains (max %d skew)", enforcement, spread, label, maxSkew)
		}
	}

	labelSelectorStr := func(ls *metav1.LabelSelector) string {
		if ls == nil {
			return ""
		}
		parts := []string{}
		for k, v := range ls.MatchLabels {
			parts = append(parts, k+"="+v)
		}
		sort.Strings(parts)
		for _, expr := range ls.MatchExpressions {
			parts = append(parts, fmt.Sprintf("%s %s [%s]", expr.Key, expr.Operator, strings.Join(expr.Values, ",")))
		}
		return strings.Join(parts, ", ")
	}

	results := []violationInfo{}

	checkWorkload := func(kind, name, ns string, tsc []corev1.TopologySpreadConstraint, replicas int) {
		key := ns + "/" + kind + "/" + name
		pods := ownerPods[key]
		if len(pods) == 0 { return }

		for _, constraint := range tsc {
			topKey := constraint.TopologyKey
			domainCounts := map[string]int{}

			knownDomains := map[string]bool{}
			for _, labels := range nodeTopology {
				if v, ok := labels[topKey]; ok {
					knownDomains[v] = true
				}
			}

			for _, p := range pods {
				if p.Node == "" { continue }
				if labels, ok := nodeTopology[p.Node]; ok {
					if domain, ok := labels[topKey]; ok {
						domainCounts[domain]++
					}
				}
			}

			for d := range knownDomains {
				if _, ok := domainCounts[d]; !ok {
					domainCounts[d] = 0
				}
			}

			totalDomains := len(domainCounts)

			if totalDomains < 2 {
				policy := "DoNotSchedule"
				if constraint.WhenUnsatisfiable == corev1.ScheduleAnyway {
					policy = "ScheduleAnyway"
				}
				enforcement := "Hard"
				if policy == "ScheduleAnyway" { enforcement = "Soft" }
				singleDist := make([]domainCount, 0, len(domainCounts))
				for d, c := range domainCounts {
					singleDist = append(singleDist, domainCount{Domain: d, Count: c})
				}
				results = append(results, violationInfo{
					Kind: kind, Name: name, Namespace: ns, Replicas: len(pods),
					Constraint: tscInfo{
						TopologyKey: topKey, TopologyLabel: topologyKeyLabel(topKey),
						MaxSkew: constraint.MaxSkew, WhenUnsatisfiable: policy,
						Enforcement: enforcement,
						Description: topologyDescription(topKey, constraint.MaxSkew, policy),
						LabelSelector: labelSelectorStr(constraint.LabelSelector),
					},
					ActualSkew: 0, Distribution: singleDist,
					TotalDomains: totalDomains, Status: "single-domain",
				})
				continue
			}

			maxCount, minCount := 0, int(^uint(0)>>1)
			for _, c := range domainCounts {
				if c > maxCount { maxCount = c }
				if c < minCount { minCount = c }
			}
			actualSkew := maxCount - minCount

			dist := make([]domainCount, 0)
			emptyDomains := 0
			for d, c := range domainCounts {
				if c > 0 {
					dist = append(dist, domainCount{Domain: d, Count: c})
				} else {
					emptyDomains++
				}
			}
			sort.Slice(dist, func(i, j int) bool {
				if dist[i].Count != dist[j].Count { return dist[i].Count > dist[j].Count }
				return dist[i].Domain < dist[j].Domain
			})

			status := "satisfied"
			if int32(actualSkew) > constraint.MaxSkew {
				status = "violated"
			} else if actualSkew > 0 && int32(actualSkew) == constraint.MaxSkew {
				status = "at-limit"
			}

			policy := "DoNotSchedule"
			if constraint.WhenUnsatisfiable == corev1.ScheduleAnyway {
				policy = "ScheduleAnyway"
			}

			enforcement := "Hard"
			if policy == "ScheduleAnyway" {
				enforcement = "Soft"
			}

			results = append(results, violationInfo{
				Kind:      kind,
				Name:      name,
				Namespace: ns,
				Replicas:  len(pods),
				Constraint: tscInfo{
					TopologyKey:       topKey,
					TopologyLabel:     topologyKeyLabel(topKey),
					MaxSkew:           constraint.MaxSkew,
					WhenUnsatisfiable: policy,
					Enforcement:       enforcement,
					Description:       topologyDescription(topKey, constraint.MaxSkew, policy),
					LabelSelector:     labelSelectorStr(constraint.LabelSelector),
				},
				ActualSkew:   actualSkew,
				Distribution: dist,
				EmptyDomains: emptyDomains,
				TotalDomains: totalDomains,
				Status:       status,
			})
		}
	}

	if cache.deployments != nil {
		for _, d := range cache.deployments.Items {
			tsc := d.Spec.Template.Spec.TopologySpreadConstraints
			if len(tsc) == 0 { continue }
			desired := 1
			if d.Spec.Replicas != nil { desired = int(*d.Spec.Replicas) }
			checkWorkload("Deployment", d.Name, d.Namespace, tsc, desired)
		}
	}
	if cache.statefulsets != nil {
		for _, s := range cache.statefulsets.Items {
			tsc := s.Spec.Template.Spec.TopologySpreadConstraints
			if len(tsc) == 0 { continue }
			desired := 1
			if s.Spec.Replicas != nil { desired = int(*s.Spec.Replicas) }
			checkWorkload("StatefulSet", s.Name, s.Namespace, tsc, desired)
		}
	}

	statusOrder := map[string]int{"violated": 0, "at-limit": 1, "satisfied": 2}
	sort.Slice(results, func(i, j int) bool {
		oi, oj := statusOrder[results[i].Status], statusOrder[results[j].Status]
		if oi != oj { return oi < oj }
		return results[i].Namespace+results[i].Name < results[j].Namespace+results[j].Name
	})

	jGz(w, r, map[string]interface{}{"workloads": results})
}

func apiEvents(w http.ResponseWriter, r *http.Request) {
	filterType := r.URL.Query().Get("type")
	filterNS := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.events == nil { j(w, []interface{}{}); return }

	type ev struct {
		Type    string `json:"type"`
		Reason  string `json:"reason"`
		Object  string `json:"object"`
		Kind    string `json:"kind"`
		Message string `json:"message"`
		Age     string `json:"age"`
		Count   int32  `json:"count"`
		NS      string `json:"namespace"`
	}
	out := make([]ev, 0)
	for _, e := range cache.events.Items {
		if filterType != "" && e.Type != filterType { continue }
		if filterNS != "" && e.Namespace != filterNS { continue }
		ts := e.LastTimestamp.Time
		if ts.IsZero() { ts = e.CreationTimestamp.Time }
		out = append(out, ev{
			Type: e.Type, Reason: e.Reason, Kind: e.InvolvedObject.Kind,
			Object: e.InvolvedObject.Kind + "/" + e.InvolvedObject.Name,
			Message: e.Message, Age: shortDur(time.Since(ts)), Count: e.Count, NS: e.Namespace,
		})
	}
	jGz(w, r, out)
}

// ─── Search ──────────────────────────────────────────────────────────

func apiSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if q == "" { j(w, []interface{}{}); return }
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	type result struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		NS   string `json:"namespace"`
	}
	out := make([]result, 0, 50)

	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			if strings.Contains(strings.ToLower(p.Name), q) || strings.Contains(strings.ToLower(p.Namespace), q) {
				out = append(out, result{"Pod", p.Name, p.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.deployments != nil {
		for _, d := range cache.deployments.Items {
			if strings.Contains(strings.ToLower(d.Name), q) || strings.Contains(strings.ToLower(d.Namespace), q) {
				out = append(out, result{"Deployment", d.Name, d.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.nodes != nil {
		for _, n := range cache.nodes.Items {
			if strings.Contains(strings.ToLower(n.Name), q) {
				out = append(out, result{"Node", n.Name, ""})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.ingresses != nil {
		for _, i := range cache.ingresses.Items {
			if strings.Contains(strings.ToLower(i.Name), q) || strings.Contains(strings.ToLower(i.Namespace), q) {
				out = append(out, result{"Ingress", i.Name, i.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.statefulsets != nil {
		for _, s := range cache.statefulsets.Items {
			if strings.Contains(strings.ToLower(s.Name), q) || strings.Contains(strings.ToLower(s.Namespace), q) {
				out = append(out, result{"StatefulSet", s.Name, s.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.daemonsets != nil {
		for _, d := range cache.daemonsets.Items {
			if strings.Contains(strings.ToLower(d.Name), q) || strings.Contains(strings.ToLower(d.Namespace), q) {
				out = append(out, result{"DaemonSet", d.Name, d.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.jobs != nil {
		for _, jb := range cache.jobs.Items {
			if strings.Contains(strings.ToLower(jb.Name), q) || strings.Contains(strings.ToLower(jb.Namespace), q) {
				out = append(out, result{"Job", jb.Name, jb.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.cronjobs != nil {
		for _, cj := range cache.cronjobs.Items {
			if strings.Contains(strings.ToLower(cj.Name), q) || strings.Contains(strings.ToLower(cj.Namespace), q) {
				out = append(out, result{"CronJob", cj.Name, cj.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	if len(out) < 50 && cache.services != nil {
		for _, s := range cache.services.Items {
			if strings.Contains(strings.ToLower(s.Name), q) || strings.Contains(strings.ToLower(s.Namespace), q) {
				out = append(out, result{"Service", s.Name, s.Namespace})
				if len(out) >= 50 { break }
			}
		}
	}
	j(w, out)
}

// ─── HPA ──────────────────────────────────────────────────────────────

func apiHPA(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.hpas == nil { jGz(w, r, []interface{}{}); return }

	type metric struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Current string `json:"current"`
		Target  string `json:"target"`
	}
	type hpa struct {
		Name       string   `json:"name"`
		Namespace  string   `json:"namespace"`
		Reference  string   `json:"reference"`
		MinReplicas int32   `json:"minReplicas"`
		MaxReplicas int32   `json:"maxReplicas"`
		Current    int32    `json:"currentReplicas"`
		Desired    int32    `json:"desiredReplicas"`
		Metrics    []metric `json:"metrics"`
		Conditions []struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"conditions"`
		Age string `json:"age"`
	}

	out := make([]hpa, 0)
	for _, h := range cache.hpas.Items {
		if ns != "" && h.Namespace != ns { continue }
		min := int32(1)
		if h.Spec.MinReplicas != nil { min = *h.Spec.MinReplicas }

		metrics := make([]metric, 0)
		for i, m := range h.Spec.Metrics {
			me := metric{}
			switch m.Type {
			case autov2.ResourceMetricSourceType:
				if m.Resource != nil {
					me.Name = string(m.Resource.Name)
					me.Type = "Resource"
					if m.Resource.Target.AverageUtilization != nil {
						me.Target = fmt.Sprintf("%d%%", *m.Resource.Target.AverageUtilization)
					} else if !m.Resource.Target.AverageValue.IsZero() {
						me.Target = m.Resource.Target.AverageValue.String()
					}
				}
			case autov2.PodsMetricSourceType:
				if m.Pods != nil {
					me.Name = m.Pods.Metric.Name
					me.Type = "Pods"
					me.Target = m.Pods.Target.AverageValue.String()
				}
			case autov2.ObjectMetricSourceType:
				if m.Object != nil {
					me.Name = m.Object.Metric.Name
					me.Type = "Object"
					me.Target = m.Object.Target.Value.String()
				}
			default:
				me.Name = string(m.Type)
				me.Type = string(m.Type)
			}
			if h.Status.CurrentMetrics != nil && i < len(h.Status.CurrentMetrics) {
				cm := h.Status.CurrentMetrics[i]
				switch cm.Type {
				case autov2.ResourceMetricSourceType:
					if cm.Resource != nil {
						if cm.Resource.Current.AverageUtilization != nil {
							me.Current = fmt.Sprintf("%d%%", *cm.Resource.Current.AverageUtilization)
						} else {
							me.Current = cm.Resource.Current.AverageValue.String()
						}
					}
				case autov2.PodsMetricSourceType:
					if cm.Pods != nil { me.Current = cm.Pods.Current.AverageValue.String() }
				case autov2.ObjectMetricSourceType:
					if cm.Object != nil { me.Current = cm.Object.Current.Value.String() }
				}
			}
			metrics = append(metrics, me)
		}

		conds := make([]struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		}, 0)
		for _, c := range h.Status.Conditions {
			conds = append(conds, struct {
				Type    string `json:"type"`
				Status  string `json:"status"`
				Reason  string `json:"reason"`
				Message string `json:"message"`
			}{string(c.Type), string(c.Status), c.Reason, c.Message})
		}

		out = append(out, hpa{
			Name: h.Name, Namespace: h.Namespace,
			Reference: h.Spec.ScaleTargetRef.Kind + "/" + h.Spec.ScaleTargetRef.Name,
			MinReplicas: min, MaxReplicas: h.Spec.MaxReplicas,
			Current: h.Status.CurrentReplicas, Desired: h.Status.DesiredReplicas,
			Metrics: metrics, Conditions: conds,
			Age: shortDur(time.Since(h.CreationTimestamp.Time)),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Namespace+out[i].Name < out[j].Namespace+out[j].Name })
	jGz(w, r, out)
}

// ─── HPA Detail ─────────────────────────────────────────────────────

func apiHPADetail(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/hpa/"), "/"), "/")
	if len(parts) < 2 {
		je(w, "use /api/hpa/{namespace}/{name}", 400)
		return
	}
	ns, name := parts[0], parts[1]

	c, cancel := ctx()
	defer cancel()
	h, err := clientset.AutoscalingV2().HorizontalPodAutoscalers(ns).Get(c, name, metav1.GetOptions{})
	if err != nil {
		jk8s(w, err)
		return
	}

	minReplicas := int32(1)
	if h.Spec.MinReplicas != nil {
		minReplicas = *h.Spec.MinReplicas
	}

	type metricEntry struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Current string `json:"current"`
		Target  string `json:"target"`
	}
	metrics := make([]metricEntry, 0)
	for i, m := range h.Spec.Metrics {
		me := metricEntry{}
		switch m.Type {
		case autov2.ResourceMetricSourceType:
			if m.Resource != nil {
				me.Name = string(m.Resource.Name)
				me.Type = "Resource"
				if m.Resource.Target.AverageUtilization != nil {
					me.Target = fmt.Sprintf("%d%%", *m.Resource.Target.AverageUtilization)
				} else if !m.Resource.Target.AverageValue.IsZero() {
					me.Target = m.Resource.Target.AverageValue.String()
				}
			}
		case autov2.PodsMetricSourceType:
			if m.Pods != nil {
				me.Name = m.Pods.Metric.Name
				me.Type = "Pods"
				me.Target = m.Pods.Target.AverageValue.String()
			}
		case autov2.ObjectMetricSourceType:
			if m.Object != nil {
				me.Name = m.Object.Metric.Name
				me.Type = "Object"
				me.Target = m.Object.Target.Value.String()
			}
		default:
			me.Name = string(m.Type)
			me.Type = string(m.Type)
		}
		if h.Status.CurrentMetrics != nil && i < len(h.Status.CurrentMetrics) {
			cm := h.Status.CurrentMetrics[i]
			switch cm.Type {
			case autov2.ResourceMetricSourceType:
				if cm.Resource != nil {
					if cm.Resource.Current.AverageUtilization != nil {
						me.Current = fmt.Sprintf("%d%%", *cm.Resource.Current.AverageUtilization)
					} else {
						me.Current = cm.Resource.Current.AverageValue.String()
					}
				}
			case autov2.PodsMetricSourceType:
				if cm.Pods != nil {
					me.Current = cm.Pods.Current.AverageValue.String()
				}
			case autov2.ObjectMetricSourceType:
				if cm.Object != nil {
					me.Current = cm.Object.Current.Value.String()
				}
			}
		}
		metrics = append(metrics, me)
	}

	type condEntry struct {
		Type    string `json:"type"`
		Status  string `json:"status"`
		Reason  string `json:"reason"`
		Message string `json:"message"`
		Age     string `json:"age"`
	}
	conditions := make([]condEntry, 0)
	for _, c := range h.Status.Conditions {
		age := ""
		if !c.LastTransitionTime.IsZero() {
			age = shortDur(time.Since(c.LastTransitionTime.Time))
		}
		conditions = append(conditions, condEntry{
			Type:    string(c.Type),
			Status:  string(c.Status),
			Reason:  c.Reason,
			Message: c.Message,
			Age:     age,
		})
	}

	labels := make(map[string]string)
	for k, v := range h.Labels {
		labels[k] = v
	}
	annotations := make(map[string]string)
	for k, v := range h.Annotations {
		annotations[k] = v
	}

	j(w, map[string]interface{}{
		"name":      h.Name,
		"namespace": h.Namespace,
		"scaleTargetRef": map[string]string{
			"kind": h.Spec.ScaleTargetRef.Kind,
			"name": h.Spec.ScaleTargetRef.Name,
		},
		"minReplicas":     minReplicas,
		"maxReplicas":     h.Spec.MaxReplicas,
		"currentReplicas": h.Status.CurrentReplicas,
		"desiredReplicas": h.Status.DesiredReplicas,
		"metrics":         metrics,
		"conditions":      conditions,
		"labels":          labels,
		"annotations":     annotations,
		"age":             shortDur(time.Since(h.CreationTimestamp.Time)),
	})
}
