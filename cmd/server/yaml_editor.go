package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	autov2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── YAML View/Edit ─────────────────────────────────────────────────

func apiYaml(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/yaml/"), "/"), "/")
	if len(parts) != 3 {
		http.Error(w, "use /api/yaml/{kind}/{ns}/{name}", 400)
		return
	}
	kind, ns, name := parts[0], parts[1], parts[2]
	c, cancel := ctx()
	defer cancel()

	if r.Method == "GET" {
		var obj interface{}
		var err error
		switch kind {
		case "Pod":
			obj, err = clientset.CoreV1().Pods(ns).Get(c, name, metav1.GetOptions{})
		case "Deployment":
			obj, err = clientset.AppsV1().Deployments(ns).Get(c, name, metav1.GetOptions{})
		case "StatefulSet":
			obj, err = clientset.AppsV1().StatefulSets(ns).Get(c, name, metav1.GetOptions{})
		case "DaemonSet":
			obj, err = clientset.AppsV1().DaemonSets(ns).Get(c, name, metav1.GetOptions{})
		case "Job":
			obj, err = clientset.BatchV1().Jobs(ns).Get(c, name, metav1.GetOptions{})
		case "CronJob":
			obj, err = clientset.BatchV1().CronJobs(ns).Get(c, name, metav1.GetOptions{})
		case "Service":
			obj, err = clientset.CoreV1().Services(ns).Get(c, name, metav1.GetOptions{})
		case "Ingress":
			obj, err = clientset.NetworkingV1().Ingresses(ns).Get(c, name, metav1.GetOptions{})
		case "ConfigMap":
			obj, err = clientset.CoreV1().ConfigMaps(ns).Get(c, name, metav1.GetOptions{})
		case "Secret":
			obj, err = clientset.CoreV1().Secrets(ns).Get(c, name, metav1.GetOptions{})
		case "HPA":
			obj, err = clientset.AutoscalingV2().HorizontalPodAutoscalers(ns).Get(c, name, metav1.GetOptions{})
		default:
			http.Error(w, "unsupported kind: "+kind, 400)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		j(w, obj)
		return
	}

	if r.Method == "PUT" {
		if !requireAdmin(w, r) { return }
		body, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024))
		if err != nil {
			http.Error(w, "read body: "+err.Error(), 400)
			return
		}

		var updateErr error
		switch kind {
		case "Deployment":
			var o appsv1.Deployment
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.AppsV1().Deployments(ns).Update(c, &o, metav1.UpdateOptions{})
		case "StatefulSet":
			var o appsv1.StatefulSet
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.AppsV1().StatefulSets(ns).Update(c, &o, metav1.UpdateOptions{})
		case "DaemonSet":
			var o appsv1.DaemonSet
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.AppsV1().DaemonSets(ns).Update(c, &o, metav1.UpdateOptions{})
		case "Service":
			var o corev1.Service
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.CoreV1().Services(ns).Update(c, &o, metav1.UpdateOptions{})
		case "ConfigMap":
			var o corev1.ConfigMap
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.CoreV1().ConfigMaps(ns).Update(c, &o, metav1.UpdateOptions{})
		case "Secret":
			var o corev1.Secret
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.CoreV1().Secrets(ns).Update(c, &o, metav1.UpdateOptions{})
		case "CronJob":
			var o batchv1.CronJob
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.BatchV1().CronJobs(ns).Update(c, &o, metav1.UpdateOptions{})
		case "Job":
			var o batchv1.Job
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.BatchV1().Jobs(ns).Update(c, &o, metav1.UpdateOptions{})
		case "HPA":
			var o autov2.HorizontalPodAutoscaler
			if err := json.Unmarshal(body, &o); err != nil { http.Error(w, "invalid json: "+err.Error(), 400); return }
			_, updateErr = clientset.AutoscalingV2().HorizontalPodAutoscalers(ns).Update(c, &o, metav1.UpdateOptions{})
		default:
			http.Error(w, "edit not supported for: "+kind, 400)
			return
		}
		if updateErr != nil {
			http.Error(w, updateErr.Error(), 500)
			return
		}
		if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
			auditRecord(sd.Email, sd.Role, "resource.edit", fmt.Sprintf("%s %s/%s", kind, ns, name), "", clientIP(r))
		}
		go cache.refresh()
		j(w, map[string]string{"ok": "updated"})
		return
	}

	http.Error(w, "GET or PUT only", 405)
}
