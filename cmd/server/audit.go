package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	k8serr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── Audit Trail ────────────────────────────────────────────────────

type auditEntry struct {
	Time     time.Time `json:"time"`
	Actor    string    `json:"actor"`
	Role     string    `json:"role"`
	Action   string    `json:"action"`
	Resource string    `json:"resource,omitempty"`
	Detail   string    `json:"detail,omitempty"`
	IP       string    `json:"ip"`
}

var auditTrail struct {
	mu      sync.Mutex
	entries []auditEntry
}

const auditMaxEntries = 1000

// ─── Online Users ───────────────────────────────────────────────────

type onlineUser struct {
	Email    string    `json:"email"`
	Role     string    `json:"role"`
	LastSeen time.Time `json:"lastSeen"`
	IP       string    `json:"ip"`
}

var onlineUsers struct {
	mu    sync.Mutex
	users map[string]*onlineUser
}

func trackUser(email, role, ip string) {
	onlineUsers.mu.Lock()
	if onlineUsers.users == nil {
		onlineUsers.users = make(map[string]*onlineUser)
	}
	onlineUsers.users[email] = &onlineUser{Email: email, Role: role, LastSeen: time.Now(), IP: ip}
	onlineUsers.mu.Unlock()
}

func getOnlineUsers() []onlineUser {
	onlineUsers.mu.Lock()
	defer onlineUsers.mu.Unlock()
	cutoff := time.Now().Add(-5 * time.Minute)
	out := make([]onlineUser, 0)
	for k, u := range onlineUsers.users {
		if u.LastSeen.Before(cutoff) {
			delete(onlineUsers.users, k)
			continue
		}
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

func auditRecord(actor, role, action, resource, detail, ip string) {
	e := auditEntry{
		Time: time.Now(), Actor: actor, Role: role,
		Action: action, Resource: resource, Detail: detail, IP: ip,
	}
	auditTrail.mu.Lock()
	auditTrail.entries = append([]auditEntry{e}, auditTrail.entries...)
	if len(auditTrail.entries) > auditMaxEntries {
		auditTrail.entries = auditTrail.entries[:auditMaxEntries]
	}
	auditDirty = true
	auditTrail.mu.Unlock()
	slog.Info("audit", "actor", actor, "action", action, "resource", resource, "detail", detail, "ip", ip)
}

// ─── Audit ConfigMap Persistence ─────────────────────────────────────

var (
	auditCMName    string
	auditPersistOn bool
	auditDirty     bool
)

func auditInitPersistence() {
	auditCMName = os.Getenv("AUDIT_CONFIGMAP_NAME")
	if auditCMName == "" {
		auditCMName = "kube-argus-audit"
	}
	auditPersistOn = true
	slog.Info("audit: persistence enabled", "configmap", jitCMNamespace+"/"+auditCMName)
}

func auditRestore() {
	if !auditPersistOn {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cm, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Get(ctx, auditCMName, metav1.GetOptions{})
	if err != nil {
		if k8serr.IsNotFound(err) {
			return
		}
		slog.Error("audit: restore failed", "error", err)
		return
	}

	data, ok := cm.Data["audit.json"]
	if !ok || data == "" {
		return
	}

	var loaded []auditEntry
	if err := json.Unmarshal([]byte(data), &loaded); err != nil {
		slog.Error("audit: restore unmarshal failed", "error", err)
		return
	}

	auditTrail.mu.Lock()
	auditTrail.entries = loaded
	auditTrail.mu.Unlock()
	slog.Info("audit: restored entries from configmap", "count", len(loaded))
}

func auditPersist() {
	if !auditPersistOn {
		return
	}

	auditTrail.mu.Lock()
	snapshot := make([]auditEntry, len(auditTrail.entries))
	copy(snapshot, auditTrail.entries)
	auditDirty = false
	auditTrail.mu.Unlock()

	raw, err := json.Marshal(snapshot)
	if err != nil {
		slog.Error("audit: persist marshal failed", "error", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cm, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Get(ctx, auditCMName, metav1.GetOptions{})
	if k8serr.IsNotFound(err) {
		newCM := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      auditCMName,
				Namespace: jitCMNamespace,
				Labels:    map[string]string{"app.kubernetes.io/managed-by": "kube-argus"},
			},
			Data: map[string]string{"audit.json": string(raw)},
		}
		if _, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Create(ctx, newCM, metav1.CreateOptions{}); err != nil {
			slog.Error("audit: persist create failed", "error", err)
		}
		return
	}
	if err != nil {
		slog.Error("audit: persist get failed", "error", err)
		return
	}

	if cm.Data == nil {
		cm.Data = make(map[string]string)
	}
	cm.Data["audit.json"] = string(raw)

	if _, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
		if k8serr.IsConflict(err) {
			slog.Warn("audit: persist conflict, will retry next cycle")
			return
		}
		slog.Error("audit: persist update failed", "error", err)
	}
}

func auditPersistLoop() {
	for {
		time.Sleep(60 * time.Second)
		if auditDirty {
			auditPersist()
		}
	}
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.SplitN(fwd, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	host, _, _ := strings.Cut(r.RemoteAddr, ":")
	return host
}

func apiAudit(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) { return }
	action := r.URL.Query().Get("action")
	auditTrail.mu.Lock()
	src := make([]auditEntry, len(auditTrail.entries))
	copy(src, auditTrail.entries)
	auditTrail.mu.Unlock()
	if action != "" {
		filtered := make([]auditEntry, 0)
		for _, e := range src {
			if e.Action == action { filtered = append(filtered, e) }
		}
		src = filtered
	}
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= auditMaxEntries { limit = n }
	}
	if len(src) > limit { src = src[:limit] }
	j(w, src)
}
