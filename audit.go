package main

import (
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
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
	auditTrail.mu.Unlock()
	log.Printf("audit: %s %s %s %s %s", actor, action, resource, detail, ip)
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
