package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// ─── Helpers ─────────────────────────────────────────────────────────

func apiNamespaces(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.namespaces == nil { j(w, []string{}); return }
	out := make([]string, 0, len(cache.namespaces.Items))
	for _, n := range cache.namespaces.Items {
		out = append(out, n.Name)
	}
	j(w, out)
}

func shortDur(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func podDisplayStatus(p corev1.Pod) string {
	reason := string(p.Status.Phase)
	if p.Status.Reason != "" {
		reason = p.Status.Reason
	}
	for _, cs := range p.Status.InitContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode == 0 {
			continue
		}
		if cs.State.Terminated != nil {
			if cs.State.Terminated.Reason != "" { return "Init:" + cs.State.Terminated.Reason }
			return fmt.Sprintf("Init:ExitCode:%d", cs.State.Terminated.ExitCode)
		}
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return "Init:" + cs.State.Waiting.Reason
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			reason = cs.State.Waiting.Reason
		} else if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			reason = cs.State.Terminated.Reason
		} else if cs.State.Terminated != nil {
			reason = fmt.Sprintf("ExitCode:%d", cs.State.Terminated.ExitCode)
		}
	}
	if p.DeletionTimestamp != nil { reason = "Terminating" }
	return reason
}

func shortImage(img string) string {
	if i := strings.LastIndex(img, "/"); i >= 0 {
		img = img[i+1:]
	}
	if i := strings.Index(img, "@sha256:"); i >= 0 {
		img = img[:i]
	}
	return img
}
