package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── Pods ────────────────────────────────────────────────────────────

func apiPods(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.pods == nil { http.Error(w, "cache not ready", 503); return }

	podMetricsMap := map[string][2]int64{}
	if cache.podMetrics != nil {
		for _, m := range cache.podMetrics.Items {
			var cpu, mem int64
			for _, ct := range m.Containers {
				cpu += ct.Usage.Cpu().MilliValue()
				mem += ct.Usage.Memory().Value() / (1024 * 1024)
			}
			podMetricsMap[m.Namespace+"/"+m.Name] = [2]int64{cpu, mem}
		}
	}

	type ctState struct {
		Name   string `json:"name"`
		State  string `json:"state"`
		Reason string `json:"reason,omitempty"`
	}
	type pd struct {
		Name       string            `json:"name"`
		NS         string            `json:"namespace"`
		Status     string            `json:"status"`
		Restarts   int32             `json:"restarts"`
		Age        string            `json:"age"`
		Node       string            `json:"node"`
		Ready      string            `json:"ready"`
		PodIP      string            `json:"podIP,omitempty"`
		OwnerKind  string            `json:"ownerKind,omitempty"`
		OwnerName  string            `json:"ownerName,omitempty"`
		CpuReq     int64             `json:"cpuReqM"`
		CpuLim     int64             `json:"cpuLimM"`
		CpuUsed    int64             `json:"cpuUsedM"`
		MemReq     int64             `json:"memReqMi"`
		MemLim     int64             `json:"memLimMi"`
		MemUsed    int64             `json:"memUsedMi"`
		CpuSizing  string            `json:"cpuSizing"`
		MemSizing  string            `json:"memSizing"`
		Labels     map[string]string `json:"labels,omitempty"`
		ContStates []ctState         `json:"containerStates,omitempty"`
	}
	out := make([]pd, 0)
	for _, p := range cache.pods.Items {
		if ns != "" && p.Namespace != ns { continue }
		restarts := int32(0)
		readyCt, totalCt := 0, len(p.Spec.Containers)
		var cpuReq, cpuLim, memReq, memLim int64
		for _, ct := range p.Spec.Containers {
			cpuReq += ct.Resources.Requests.Cpu().MilliValue()
			cpuLim += ct.Resources.Limits.Cpu().MilliValue()
			memReq += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
			memLim += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
		}
		for _, cs := range p.Status.ContainerStatuses {
			restarts += cs.RestartCount
			if cs.Ready { readyCt++ }
		}
		usage := podMetricsMap[p.Namespace+"/"+p.Name]
		cpuSizing, memSizing := "unknown", "unknown"
		if usage[0] > 0 {
			if cpuLim > 0 && float64(usage[0]) >= float64(cpuLim)*0.8 {
				cpuSizing = "under"
			} else if cpuReq > 0 && float64(usage[0]) < float64(cpuReq)*0.2 {
				cpuSizing = "over"
			} else if cpuReq > 0 {
				cpuSizing = "ok"
			}
		}
		if usage[1] > 0 {
			if memLim > 0 && float64(usage[1]) >= float64(memLim)*0.8 {
				memSizing = "under"
			} else if memReq > 0 && float64(usage[1]) < float64(memReq)*0.2 {
				memSizing = "over"
			} else if memReq > 0 {
				memSizing = "ok"
			}
		}
		curated := map[string]string{}
		interestingKeys := []string{"app", "app.kubernetes.io/name", "app.kubernetes.io/version", "version", "app.kubernetes.io/component"}
		for _, k := range interestingKeys {
			if v, ok := p.Labels[k]; ok { curated[k] = v }
		}
		var cstates []ctState
		allRunning := true
		for _, cs := range p.Status.ContainerStatuses {
			st := ctState{Name: cs.Name}
			if cs.State.Running != nil {
				st.State = "running"
			} else if cs.State.Waiting != nil {
				st.State = "waiting"
				st.Reason = cs.State.Waiting.Reason
				allRunning = false
			} else if cs.State.Terminated != nil {
				st.State = "terminated"
				st.Reason = cs.State.Terminated.Reason
				allRunning = false
			}
			cstates = append(cstates, st)
		}
		if allRunning && len(cstates) <= 1 {
			cstates = nil
		}
		var ownerKind, ownerName string
		for _, ref := range p.OwnerReferences {
			if ref.Controller != nil && *ref.Controller {
				ownerKind = ref.Kind
				ownerName = ref.Name
				if ownerKind == "ReplicaSet" {
					for _, rs := range cache.replicasets.Items {
						if rs.Name == ownerName && rs.Namespace == p.Namespace {
							for _, rsRef := range rs.OwnerReferences {
								if rsRef.Controller != nil && *rsRef.Controller {
									ownerKind = rsRef.Kind
									ownerName = rsRef.Name
								}
							}
						}
					}
				}
				break
			}
		}
		out = append(out, pd{
			Name: p.Name, NS: p.Namespace, Status: podDisplayStatus(p),
			Restarts: restarts, Age: shortDur(time.Since(p.CreationTimestamp.Time)),
			Node: p.Spec.NodeName, Ready: fmt.Sprintf("%d/%d", readyCt, totalCt),
			PodIP: p.Status.PodIP, OwnerKind: ownerKind, OwnerName: ownerName,
			CpuReq: cpuReq, CpuLim: cpuLim, CpuUsed: usage[0],
			MemReq: memReq, MemLim: memLim, MemUsed: usage[1],
			CpuSizing: cpuSizing, MemSizing: memSizing,
			Labels: curated, ContStates: cstates,
		})
	}
	jGz(w, r, out)
}

// /api/pods/{ns}/{name}/logs?tail=200&container=x
// /api/pods/{ns}/{name}/events
func apiPodDetail(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/pods/"), "/")
	parts := strings.SplitN(path, "/", 3)
	if len(parts) < 3 {
		http.Error(w, "use /api/pods/{ns}/{name}/logs or /events", 400)
		return
	}
	ns, name, action := parts[0], parts[1], parts[2]
	c, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	switch action {
	case "logs":
		tail := int64(300)
		if t := r.URL.Query().Get("tail"); t != "" {
			fmt.Sscanf(t, "%d", &tail)
		}
		follow := r.URL.Query().Get("follow") == "true"
		container := r.URL.Query().Get("container")
		opts := &corev1.PodLogOptions{TailLines: &tail, Follow: follow}
		if container != "" {
			opts.Container = container
		}
		stream, err := clientset.CoreV1().Pods(ns).GetLogs(name, opts).Stream(context.Background())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer stream.Close()
		if follow {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.Header().Set("X-Accel-Buffering", "no")
			flusher, ok := w.(http.Flusher)
			if !ok {
				http.Error(w, "streaming not supported", 500)
				return
			}
			scanner := bufio.NewScanner(stream)
			scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
			for scanner.Scan() {
				fmt.Fprintf(w, "data: %s\n\n", scanner.Text())
				flusher.Flush()
			}
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.Copy(w, stream)
	case "events":
		evts, err := clientset.CoreV1().Events(ns).List(c, metav1.ListOptions{
			FieldSelector: "involvedObject.name=" + name,
		})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		type ev struct {
			Type    string `json:"type"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
			Age     string `json:"age"`
			Count   int32  `json:"count"`
		}
		out := make([]ev, 0)
		for _, e := range evts.Items {
			age := ""
			if !e.LastTimestamp.IsZero() {
				age = shortDur(time.Since(e.LastTimestamp.Time))
			}
			out = append(out, ev{e.Type, e.Reason, e.Message, age, e.Count})
		}
		j(w, out)
	case "previous-logs":
		container := r.URL.Query().Get("container")
		if container == "" {
			http.Error(w, "container param required", 400)
			return
		}
		tail := int64(200)
		prev := true
		opts := &corev1.PodLogOptions{TailLines: &tail, Previous: prev, Container: container}
		stream, err := clientset.CoreV1().Pods(ns).GetLogs(name, opts).Stream(context.Background())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer stream.Close()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.Copy(w, stream)

	case "describe":
		pod, err := clientset.CoreV1().Pods(ns).Get(c, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		type probeInfo struct {
			Type             string `json:"type"`
			Path             string `json:"path,omitempty"`
			Port             string `json:"port,omitempty"`
			Command          string `json:"command,omitempty"`
			PeriodSeconds    int32  `json:"periodSeconds,omitempty"`
			FailureThreshold int32  `json:"failureThreshold,omitempty"`
		}
		type containerInfo struct {
			Name                  string     `json:"name"`
			Image                 string     `json:"image"`
			Ready                 bool       `json:"ready"`
			State                 string     `json:"state"`
			Reason                string     `json:"reason"`
			Message               string     `json:"message"`
			Restarts              int32      `json:"restarts"`
			Started               bool       `json:"started"`
			CpuReq                int64      `json:"cpuReqM"`
			CpuLim                int64      `json:"cpuLimM"`
			CpuUsed               int64      `json:"cpuUsedM"`
			MemReq                int64      `json:"memReqMi"`
			MemLim                int64      `json:"memLimMi"`
			MemUsed               int64      `json:"memUsedMi"`
			LastTermReason        string     `json:"lastTermReason,omitempty"`
			LastTermExitCode      *int32     `json:"lastTermExitCode,omitempty"`
			LastTermMessage       string     `json:"lastTermMessage,omitempty"`
			LastTermAt            string     `json:"lastTermAt,omitempty"`
			LivenessProbe         *probeInfo `json:"livenessProbe,omitempty"`
			ReadinessProbe        *probeInfo `json:"readinessProbe,omitempty"`
			StartupProbe          *probeInfo `json:"startupProbe,omitempty"`
		}

		containerMetrics := map[string][2]int64{}
		cache.mu.RLock()
		if cache.podMetrics != nil {
			for _, pm := range cache.podMetrics.Items {
				if pm.Namespace == ns && pm.Name == name {
					for _, cm := range pm.Containers {
						containerMetrics[cm.Name] = [2]int64{cm.Usage.Cpu().MilliValue(), cm.Usage.Memory().Value() / (1024 * 1024)}
					}
					break
				}
			}
		}
		cache.mu.RUnlock()

		containers := make([]containerInfo, 0)
		initContainers := make([]containerInfo, 0)

		csMap := map[string]corev1.ContainerStatus{}
		for _, cs := range pod.Status.ContainerStatuses {
			csMap[cs.Name] = cs
		}
		icsMap := map[string]corev1.ContainerStatus{}
		for _, cs := range pod.Status.InitContainerStatuses {
			icsMap[cs.Name] = cs
		}

		makeProbe := func(p *corev1.Probe) *probeInfo {
			if p == nil { return nil }
			pi := &probeInfo{PeriodSeconds: p.PeriodSeconds, FailureThreshold: p.FailureThreshold}
			if p.HTTPGet != nil {
				pi.Type = "httpGet"
				pi.Path = p.HTTPGet.Path
				pi.Port = p.HTTPGet.Port.String()
			} else if p.TCPSocket != nil {
				pi.Type = "tcpSocket"
				pi.Port = p.TCPSocket.Port.String()
			} else if p.Exec != nil {
				pi.Type = "exec"
				pi.Command = strings.Join(p.Exec.Command, " ")
			} else if p.GRPC != nil {
				pi.Type = "grpc"
				pi.Port = fmt.Sprintf("%d", p.GRPC.Port)
			}
			return pi
		}

		populateCI := func(ct corev1.Container, statusMap map[string]corev1.ContainerStatus) containerInfo {
			ci := containerInfo{
				Name:   ct.Name,
				Image:  shortImage(ct.Image),
				CpuReq: ct.Resources.Requests.Cpu().MilliValue(),
				CpuLim: ct.Resources.Limits.Cpu().MilliValue(),
				MemReq: ct.Resources.Requests.Memory().Value() / (1024 * 1024),
				MemLim: ct.Resources.Limits.Memory().Value() / (1024 * 1024),
				LivenessProbe:  makeProbe(ct.LivenessProbe),
				ReadinessProbe: makeProbe(ct.ReadinessProbe),
				StartupProbe:   makeProbe(ct.StartupProbe),
			}
			if m, ok := containerMetrics[ct.Name]; ok {
				ci.CpuUsed = m[0]
				ci.MemUsed = m[1]
			}
			if cs, ok := statusMap[ct.Name]; ok {
				ci.Ready = cs.Ready
				ci.Restarts = cs.RestartCount
				if cs.Started != nil {
					ci.Started = *cs.Started
				}
				if cs.State.Running != nil {
					ci.State = "running"
				} else if cs.State.Waiting != nil {
					ci.State = "waiting"
					ci.Reason = cs.State.Waiting.Reason
					ci.Message = cs.State.Waiting.Message
				} else if cs.State.Terminated != nil {
					ci.State = "terminated"
					ci.Reason = cs.State.Terminated.Reason
					ci.Message = cs.State.Terminated.Message
				}
				if cs.LastTerminationState.Terminated != nil {
					lt := cs.LastTerminationState.Terminated
					ci.LastTermReason = lt.Reason
					ec := lt.ExitCode
					ci.LastTermExitCode = &ec
					ci.LastTermMessage = lt.Message
					if !lt.FinishedAt.IsZero() {
						ci.LastTermAt = shortDur(time.Since(lt.FinishedAt.Time)) + " ago"
					}
				}
				if ci.Reason == "" && ci.LastTermReason != "" {
					ci.Reason = "last: " + ci.LastTermReason
				}
			}
			return ci
		}

		for _, ct := range pod.Spec.InitContainers {
			initContainers = append(initContainers, populateCI(ct, icsMap))
		}
		for _, ct := range pod.Spec.Containers {
			containers = append(containers, populateCI(ct, csMap))
		}
		conditions := make([]map[string]string, 0)
		for _, cond := range pod.Status.Conditions {
			conditions = append(conditions, map[string]string{
				"type":    string(cond.Type),
				"status":  string(cond.Status),
				"reason":  cond.Reason,
				"message": cond.Message,
			})
		}
		ownerKind, ownerName := "", ""
		for _, or := range pod.OwnerReferences {
			ownerKind = or.Kind
			ownerName = or.Name
			break
		}
		if ownerKind == "ReplicaSet" && ownerName != "" {
			if rs, err := clientset.AppsV1().ReplicaSets(ns).Get(c, ownerName, metav1.GetOptions{}); err == nil {
				for _, rsOwner := range rs.OwnerReferences {
					if rsOwner.Kind == "Deployment" {
						ownerKind = "Deployment"
						ownerName = rsOwner.Name
						break
					}
				}
			}
		}
		if ownerKind == "Job" && ownerName != "" {
			if jb, err := clientset.BatchV1().Jobs(ns).Get(c, ownerName, metav1.GetOptions{}); err == nil {
				for _, jOwner := range jb.OwnerReferences {
					if jOwner.Kind == "CronJob" {
						ownerKind = "CronJob"
						ownerName = jOwner.Name
						break
					}
				}
			}
		}

		j(w, map[string]interface{}{
			"name":           pod.Name,
			"namespace":      pod.Namespace,
			"node":           pod.Spec.NodeName,
			"status":         podDisplayStatus(*pod),
			"ip":             pod.Status.PodIP,
			"qos":            string(pod.Status.QOSClass),
			"age":            shortDur(time.Since(pod.CreationTimestamp.Time)),
			"containers":     containers,
			"initContainers": initContainers,
			"conditions":     conditions,
			"ownerKind":      ownerKind,
			"ownerName":      ownerName,
		})
	case "delete":
		if r.Method != "POST" {
			http.Error(w, "POST only", 405)
			return
		}
		if !requireAdmin(w, r) { return }
		err := clientset.CoreV1().Pods(ns).Delete(c, name, metav1.DeleteOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		go cache.refresh()
		if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
			auditRecord(sd.Email, sd.Role, "pod.delete", fmt.Sprintf("Pod %s/%s", ns, name), "", clientIP(r))
		}
		j(w, map[string]string{"ok": "deleted"})
	default:
		http.Error(w, "use /logs, /events, /describe, or /delete", 400)
	}
}
