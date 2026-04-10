package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── Ingresses ──────────────────────────────────────────────────────

func apiIngresses(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.ingresses == nil { j(w, []interface{}{}); return }

	type rule struct {
		Host    string `json:"host"`
		Path    string `json:"path"`
		Backend string `json:"backend"`
		Port    string `json:"port"`
	}
	type ing struct {
		Name      string   `json:"name"`
		NS        string   `json:"namespace"`
		Class     string   `json:"class"`
		Hosts     []string `json:"hosts"`
		Addresses []string `json:"addresses"`
		TLS       bool     `json:"tls"`
		Rules     []rule   `json:"rules"`
		Age       string   `json:"age"`
	}

	out := make([]ing, 0)
	for _, i := range cache.ingresses.Items {
		if ns != "" && i.Namespace != ns { continue }

		class := ""
		if i.Spec.IngressClassName != nil { class = *i.Spec.IngressClassName }
		if class == "" {
			if v, ok := i.Annotations["kubernetes.io/ingress.class"]; ok { class = v }
		}

		hasTLS := len(i.Spec.TLS) > 0

		hosts := make([]string, 0)
		rules := make([]rule, 0)
		for _, r := range i.Spec.Rules {
			h := r.Host
			if h == "" { h = "*" }
			found := false
			for _, existing := range hosts { if existing == h { found = true; break } }
			if !found { hosts = append(hosts, h) }

			if r.HTTP != nil {
				for _, p := range r.HTTP.Paths {
					backend := ""
					port := ""
					if p.Backend.Service != nil {
						backend = p.Backend.Service.Name
						if p.Backend.Service.Port.Name != "" {
							port = p.Backend.Service.Port.Name
						} else {
							port = fmt.Sprintf("%d", p.Backend.Service.Port.Number)
						}
					}
					path := "/"
					if p.Path != "" { path = p.Path }
					rules = append(rules, rule{Host: h, Path: path, Backend: backend, Port: port})
				}
			}
		}

		addresses := make([]string, 0)
		for _, lb := range i.Status.LoadBalancer.Ingress {
			if lb.Hostname != "" { addresses = append(addresses, lb.Hostname) }
			if lb.IP != "" { addresses = append(addresses, lb.IP) }
		}

		out = append(out, ing{
			Name: i.Name, NS: i.Namespace, Class: class,
			Hosts: hosts, Addresses: addresses, TLS: hasTLS,
			Rules: rules, Age: shortDur(time.Since(i.CreationTimestamp.Time)),
		})
	}
	jGz(w, r, out)
}

func apiIngressDescribe(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/ingresses/"), "/"), "/")
	if len(parts) < 2 {
		je(w, "use /api/ingresses/{namespace}/{name}", 400)
		return
	}
	ns, name := parts[0], parts[1]

	c, cancel := ctx()
	defer cancel()
	ing, err := clientset.NetworkingV1().Ingresses(ns).Get(c, name, metav1.GetOptions{})
	if err != nil {
		jk8s(w, err)
		return
	}

	class := ""
	if ing.Spec.IngressClassName != nil { class = *ing.Spec.IngressClassName }
	if class == "" {
		if v, ok := ing.Annotations["kubernetes.io/ingress.class"]; ok { class = v }
	}

	type tlsEntry struct {
		Hosts      []string `json:"hosts"`
		SecretName string   `json:"secretName"`
	}
	type ruleEntry struct {
		Host     string `json:"host"`
		Path     string `json:"path"`
		PathType string `json:"pathType"`
		Backend  string `json:"backend"`
		Port     string `json:"port"`
	}

	tlsList := make([]tlsEntry, 0)
	for _, t := range ing.Spec.TLS {
		tlsList = append(tlsList, tlsEntry{Hosts: t.Hosts, SecretName: t.SecretName})
	}

	rules := make([]ruleEntry, 0)
	for _, rule := range ing.Spec.Rules {
		h := rule.Host
		if h == "" { h = "*" }
		if rule.HTTP != nil {
			for _, p := range rule.HTTP.Paths {
				backend := ""
				port := ""
				if p.Backend.Service != nil {
					backend = p.Backend.Service.Name
					if p.Backend.Service.Port.Name != "" {
						port = p.Backend.Service.Port.Name
					} else {
						port = fmt.Sprintf("%d", p.Backend.Service.Port.Number)
					}
				}
				pt := ""
				if p.PathType != nil { pt = string(*p.PathType) }
				path := "/"
				if p.Path != "" { path = p.Path }
				rules = append(rules, ruleEntry{Host: h, Path: path, PathType: pt, Backend: backend, Port: port})
			}
		}
	}

	defaultBackend := ""
	if ing.Spec.DefaultBackend != nil {
		if ing.Spec.DefaultBackend.Service != nil {
			defaultBackend = ing.Spec.DefaultBackend.Service.Name
			if ing.Spec.DefaultBackend.Service.Port.Name != "" {
				defaultBackend += ":" + ing.Spec.DefaultBackend.Service.Port.Name
			} else {
				defaultBackend += ":" + fmt.Sprintf("%d", ing.Spec.DefaultBackend.Service.Port.Number)
			}
		}
	}

	addresses := make([]string, 0)
	for _, lb := range ing.Status.LoadBalancer.Ingress {
		if lb.Hostname != "" { addresses = append(addresses, lb.Hostname) }
		if lb.IP != "" { addresses = append(addresses, lb.IP) }
	}

	annotations := make(map[string]string)
	for k, v := range ing.Annotations { annotations[k] = v }
	labels := make(map[string]string)
	for k, v := range ing.Labels { labels[k] = v }

	// Fetch related events
	cache.mu.RLock()
	evts := make([]map[string]interface{}, 0)
	if cache.events != nil {
		for _, e := range cache.events.Items {
			if e.InvolvedObject.Kind == "Ingress" && e.InvolvedObject.Name == name && e.InvolvedObject.Namespace == ns {
				evts = append(evts, map[string]interface{}{
					"type": e.Type, "reason": e.Reason, "message": e.Message,
					"age": shortDur(time.Since(e.LastTimestamp.Time)), "count": e.Count,
				})
			}
		}
	}
	cache.mu.RUnlock()

	j(w, map[string]interface{}{
		"name": ing.Name, "namespace": ing.Namespace, "class": class,
		"age": shortDur(time.Since(ing.CreationTimestamp.Time)),
		"defaultBackend": defaultBackend,
		"tls": tlsList, "rules": rules, "addresses": addresses,
		"annotations": annotations, "labels": labels, "events": evts,
	})
}

// ─── Services ────────────────────────────────────────────────────────

func apiServices(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.services == nil { j(w, []interface{}{}); return }

	type svc struct {
		Name       string   `json:"name"`
		NS         string   `json:"namespace"`
		Type       string   `json:"type"`
		ClusterIP  string   `json:"clusterIP"`
		ExternalIP string   `json:"externalIP"`
		Ports      string   `json:"ports"`
		Age        string   `json:"age"`
		Selector   string   `json:"selector"`
	}
	out := make([]svc, 0)
	for _, s := range cache.services.Items {
		if ns != "" && s.Namespace != ns { continue }
		ports := make([]string, 0, len(s.Spec.Ports))
		for _, p := range s.Spec.Ports {
			ps := fmt.Sprintf("%d", p.Port)
			if p.TargetPort.IntValue() > 0 { ps += ":" + fmt.Sprintf("%d", p.TargetPort.IntValue()) }
			if p.NodePort > 0 { ps += ":" + fmt.Sprintf("%d", p.NodePort) }
			ps += "/" + string(p.Protocol)
			if p.Name != "" { ps = p.Name + " " + ps }
			ports = append(ports, ps)
		}
		extIP := ""
		if len(s.Spec.ExternalIPs) > 0 { extIP = strings.Join(s.Spec.ExternalIPs, ",") }
		if len(s.Status.LoadBalancer.Ingress) > 0 {
			lbs := make([]string, 0)
			for _, lb := range s.Status.LoadBalancer.Ingress {
				if lb.Hostname != "" { lbs = append(lbs, lb.Hostname) }
				if lb.IP != "" { lbs = append(lbs, lb.IP) }
			}
			if len(lbs) > 0 { extIP = strings.Join(lbs, ",") }
		}
		sel := make([]string, 0, len(s.Spec.Selector))
		for k, v := range s.Spec.Selector { sel = append(sel, k + "=" + v) }

		out = append(out, svc{
			Name: s.Name, NS: s.Namespace, Type: string(s.Spec.Type),
			ClusterIP: s.Spec.ClusterIP, ExternalIP: extIP,
			Ports: strings.Join(ports, ", "), Age: shortDur(time.Since(s.CreationTimestamp.Time)),
			Selector: strings.Join(sel, ", "),
		})
	}
	jGz(w, r, out)
}

// ─── Service Detail ──────────────────────────────────────────────────

func apiServiceDetail(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/services/"), "/"), "/")
	if len(parts) < 2 {
		je(w, "use /api/services/{namespace}/{name}", 400)
		return
	}
	ns, name := parts[0], parts[1]

	c, cancel := ctx()
	defer cancel()
	svc, err := clientset.CoreV1().Services(ns).Get(c, name, metav1.GetOptions{})
	if err != nil {
		jk8s(w, err)
		return
	}

	type portEntry struct {
		Name       string `json:"name"`
		Port       int32  `json:"port"`
		TargetPort string `json:"targetPort"`
		NodePort   int32  `json:"nodePort"`
		Protocol   string `json:"protocol"`
	}
	ports := make([]portEntry, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		ports = append(ports, portEntry{
			Name:       p.Name,
			Port:       p.Port,
			TargetPort: p.TargetPort.String(),
			NodePort:   p.NodePort,
			Protocol:   string(p.Protocol),
		})
	}

	externalIPs := make([]string, 0)
	externalIPs = append(externalIPs, svc.Spec.ExternalIPs...)
	for _, lb := range svc.Status.LoadBalancer.Ingress {
		if lb.Hostname != "" {
			externalIPs = append(externalIPs, lb.Hostname)
		}
		if lb.IP != "" {
			externalIPs = append(externalIPs, lb.IP)
		}
	}

	selector := make(map[string]string)
	for k, v := range svc.Spec.Selector {
		selector[k] = v
	}
	labels := make(map[string]string)
	for k, v := range svc.Labels {
		labels[k] = v
	}
	annotations := make(map[string]string)
	for k, v := range svc.Annotations {
		annotations[k] = v
	}

	// Fetch endpoints
	type endpointAddr struct {
		IP       string `json:"ip"`
		Hostname string `json:"hostname"`
		NodeName string `json:"nodeName"`
		Ready    bool   `json:"ready"`
	}
	type endpointPort struct {
		Name     string `json:"name"`
		Port     int32  `json:"port"`
		Protocol string `json:"protocol"`
	}
	type endpointSubset struct {
		Addresses []endpointAddr `json:"addresses"`
		Ports     []endpointPort `json:"ports"`
	}
	endpoints := make([]endpointSubset, 0)
	ep, epErr := clientset.CoreV1().Endpoints(ns).Get(c, name, metav1.GetOptions{})
	if epErr == nil && ep != nil {
		for _, sub := range ep.Subsets {
			es := endpointSubset{}
			for _, addr := range sub.Addresses {
				ea := endpointAddr{IP: addr.IP, Ready: true}
				if addr.Hostname != "" {
					ea.Hostname = addr.Hostname
				}
				if addr.NodeName != nil {
					ea.NodeName = *addr.NodeName
				}
				es.Addresses = append(es.Addresses, ea)
			}
			for _, addr := range sub.NotReadyAddresses {
				ea := endpointAddr{IP: addr.IP, Ready: false}
				if addr.Hostname != "" {
					ea.Hostname = addr.Hostname
				}
				if addr.NodeName != nil {
					ea.NodeName = *addr.NodeName
				}
				es.Addresses = append(es.Addresses, ea)
			}
			for _, p := range sub.Ports {
				es.Ports = append(es.Ports, endpointPort{
					Name: p.Name, Port: p.Port, Protocol: string(p.Protocol),
				})
			}
			endpoints = append(endpoints, es)
		}
	}

	// Fetch related events
	cache.mu.RLock()
	evts := make([]map[string]interface{}, 0)
	if cache.events != nil {
		for _, e := range cache.events.Items {
			if e.InvolvedObject.Kind == "Service" && e.InvolvedObject.Name == name && e.InvolvedObject.Namespace == ns {
				ts := e.LastTimestamp.Time
				if ts.IsZero() {
					ts = e.CreationTimestamp.Time
				}
				evts = append(evts, map[string]interface{}{
					"type": e.Type, "reason": e.Reason, "message": e.Message,
					"age": shortDur(time.Since(ts)), "count": e.Count,
				})
			}
		}
	}
	cache.mu.RUnlock()

	j(w, map[string]interface{}{
		"name":        svc.Name,
		"namespace":   svc.Namespace,
		"type":        string(svc.Spec.Type),
		"clusterIP":   svc.Spec.ClusterIP,
		"externalIPs": externalIPs,
		"ports":       ports,
		"selector":    selector,
		"labels":      labels,
		"annotations": annotations,
		"endpoints":   endpoints,
		"events":      evts,
		"age":         shortDur(time.Since(svc.CreationTimestamp.Time)),
	})
}
