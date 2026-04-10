package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// ─── JIT Exec Access ─────────────────────────────────────────────────

type jitRequest struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Namespace  string     `json:"namespace"`
	Pod        string     `json:"pod"`
	OwnerKind  string     `json:"ownerKind"`
	OwnerName  string     `json:"ownerName"`
	Reason     string     `json:"reason"`
	Duration   string     `json:"duration"`
	Status     string     `json:"status"` // pending | active | denied | expired | revoked
	CreatedAt  time.Time  `json:"createdAt"`
	ApprovedBy string     `json:"approvedBy,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
}

var jitStore struct {
	mu       sync.Mutex
	requests []jitRequest
}

func jitResourceStr(r *jitRequest) string {
	s := "Namespace " + r.Namespace
	if r.OwnerKind != "" && r.OwnerName != "" {
		s += ", " + r.OwnerKind + " " + r.OwnerName
	} else if r.Pod != "" {
		s += ", Pod " + r.Pod
	}
	return s
}

var errJITNotFound = fmt.Errorf("request not found")

// jitApprove approves a pending JIT request. Returns an error if not found or not pending.
func jitApprove(id, approver, ip string) error {
	jitStore.mu.Lock()
	req := jitFindByID(id)
	if req == nil {
		jitStore.mu.Unlock()
		return errJITNotFound
	}
	if req.Status != "pending" {
		jitStore.mu.Unlock()
		return fmt.Errorf("can only approve pending requests (current: %s)", req.Status)
	}
	dur, err := time.ParseDuration(req.Duration)
	if err != nil {
		jitStore.mu.Unlock()
		return fmt.Errorf("invalid duration")
	}
	exp := time.Now().Add(dur)
	req.Status = "active"
	req.ApprovedBy = approver
	req.ExpiresAt = &exp
	jitStore.mu.Unlock()

	auditRecord(approver, "admin", "jit.approve", jitResourceStr(req), fmt.Sprintf("for %s, duration: %s", req.Email, req.Duration), ip)
	slog.Info("jit: request approved", "id", id, "approved_by", approver, "duration", req.Duration)
	go jitPersist()
	return nil
}

// jitDeny denies a pending JIT request. Returns an error if not found or not pending.
func jitDeny(id, approver, ip string) error {
	jitStore.mu.Lock()
	req := jitFindByID(id)
	if req == nil {
		jitStore.mu.Unlock()
		return errJITNotFound
	}
	if req.Status != "pending" {
		jitStore.mu.Unlock()
		return fmt.Errorf("can only deny pending requests (current: %s)", req.Status)
	}
	req.Status = "denied"
	req.ApprovedBy = approver
	jitStore.mu.Unlock()

	auditRecord(approver, "admin", "jit.deny", jitResourceStr(req), fmt.Sprintf("requester: %s", req.Email), ip)
	slog.Info("jit: request denied", "id", id, "denied_by", approver)
	go jitPersist()
	return nil
}

const jitMaxRequests  = 500
const jitPendingTTL   = 48 * time.Hour

// ─── ConfigMap Persistence ───────────────────────────────────────────

var (
	jitCMName      string
	jitCMNamespace string
	jitPersistOn   bool
	jitRetention   time.Duration
)

func jitInitPersistence() {
	jitCMName = os.Getenv("JIT_CONFIGMAP_NAME")
	if jitCMName == "" {
		jitCMName = "kube-argus-jit"
	}

	jitCMNamespace = os.Getenv("POD_NAMESPACE")
	if jitCMNamespace == "" {
		if ns, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
			jitCMNamespace = strings.TrimSpace(string(ns))
		}
	}
	if jitCMNamespace == "" {
		jitCMNamespace = "default"
	}

	days := 7
	if v := os.Getenv("JIT_RETENTION_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}
	jitRetention = time.Duration(days) * 24 * time.Hour

	jitPersistOn = true
	slog.Info("jit: persistence enabled", "configmap", jitCMNamespace+"/"+jitCMName, "retention_days", days)
}

// jitRestore loads JIT requests from the ConfigMap into the in-memory store.
// Must be called with jitStore.mu NOT held.
func jitRestore() {
	if !jitPersistOn {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cm, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Get(ctx, jitCMName, metav1.GetOptions{})
	if err != nil {
		if k8serr.IsNotFound(err) {
			return
		}
		slog.Error("jit: restore failed", "error", err)
		return
	}

	data, ok := cm.Data["requests.json"]
	if !ok || data == "" {
		return
	}

	var loaded []jitRequest
	if err := json.Unmarshal([]byte(data), &loaded); err != nil {
		slog.Error("jit: restore unmarshal failed", "error", err)
		return
	}

	jitStore.mu.Lock()
	jitStore.requests = loaded
	jitStore.mu.Unlock()
	slog.Debug("jit: restored requests from configmap", "count", len(loaded))
}

// jitPersist writes the current in-memory JIT requests to the ConfigMap.
// Prunes terminal-state requests older than the retention period.
// Must be called with jitStore.mu NOT held.
func jitPersist() {
	if !jitPersistOn {
		return
	}

	jitStore.mu.Lock()
	cutoff := time.Now().Add(-jitRetention)
	kept := make([]jitRequest, 0, len(jitStore.requests))
	for _, r := range jitStore.requests {
		terminal := r.Status == "expired" || r.Status == "denied" || r.Status == "revoked"
		if terminal && r.CreatedAt.Before(cutoff) {
			continue
		}
		kept = append(kept, r)
	}
	jitStore.requests = kept

	snapshot := make([]jitRequest, len(kept))
	copy(snapshot, kept)
	jitStore.mu.Unlock()

	raw, err := json.Marshal(snapshot)
	if err != nil {
		slog.Error("jit: persist marshal failed", "error", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cm, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Get(ctx, jitCMName, metav1.GetOptions{})
	if k8serr.IsNotFound(err) {
		newCM := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      jitCMName,
				Namespace: jitCMNamespace,
				Labels:    map[string]string{"app.kubernetes.io/managed-by": "kube-argus"},
			},
			Data: map[string]string{"requests.json": string(raw)},
		}
		if _, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Create(ctx, newCM, metav1.CreateOptions{}); err != nil {
			slog.Error("jit: persist create failed", "error", err)
		}
		return
	}
	if err != nil {
		slog.Error("jit: persist get failed", "error", err)
		return
	}

	if cm.Data == nil {
		cm.Data = make(map[string]string)
	}
	cm.Data["requests.json"] = string(raw)

	if _, err := clientset.CoreV1().ConfigMaps(jitCMNamespace).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
		if k8serr.IsConflict(err) {
			slog.Warn("jit: persist conflict, will retry next cycle")
			return
		}
		slog.Error("jit: persist update failed", "error", err)
	}
}

func jitID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func jitFindByID(id string) *jitRequest {
	for i := range jitStore.requests {
		if jitStore.requests[i].ID == id {
			return &jitStore.requests[i]
		}
	}
	return nil
}

// hasActiveJIT checks if email has an active (non-expired) grant for a specific workload in a namespace.
func hasActiveJIT(email, namespace, ownerKind, ownerName string) bool {
	jitStore.mu.Lock()
	defer jitStore.mu.Unlock()
	now := time.Now()
	for _, r := range jitStore.requests {
		if r.Status == "active" && r.Email == email && r.Namespace == namespace &&
			r.OwnerKind == ownerKind && r.OwnerName == ownerName {
			if r.ExpiresAt != nil && now.Before(*r.ExpiresAt) {
				return true
			}
		}
	}
	return false
}

// requireAdminOrJIT allows access if user is admin OR has an active JIT grant for the workload.
func requireAdminOrJIT(w http.ResponseWriter, r *http.Request, namespace, ownerKind, ownerName string) bool {
	email := "anonymous"
	role := defaultRole

	if authEnabled {
		sd, ok := r.Context().Value(userCtxKey).(*sessionData)
		if !ok || sd == nil {
			slog.Warn("jit-exec: denied, no session", "namespace", namespace, "owner_kind", ownerKind, "owner_name", ownerName)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(403)
			json.NewEncoder(w).Encode(map[string]string{"error": "forbidden"})
			return false
		}
		email = sd.Email
		role = sd.Role
	}

	if role == "admin" {
		return true
	}

	if hasActiveJIT(email, namespace, ownerKind, ownerName) {
		slog.Info("jit-exec: granted via JIT", "email", email, "namespace", namespace, "owner_kind", ownerKind, "owner_name", ownerName)
		return true
	}

	slog.Warn("jit-exec: denied, no active JIT grant", "email", email, "role", role, "namespace", namespace, "owner_kind", ownerKind, "owner_name", ownerName)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(403)
	json.NewEncoder(w).Encode(map[string]string{"error": "forbidden", "message": "admin access or approved JIT request required"})
	return false
}

// resolvePodOwner resolves the top-level owner of a pod (e.g., Deployment from ReplicaSet).
func resolvePodOwner(ns, podName string) (string, string) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.pods == nil {
		return "Pod", podName
	}
	for _, p := range cache.pods.Items {
		if p.Namespace != ns || p.Name != podName {
			continue
		}
		if len(p.OwnerReferences) == 0 {
			return "Pod", podName
		}
		ownerKind := p.OwnerReferences[0].Kind
		ownerName := p.OwnerReferences[0].Name
		if ownerKind == "ReplicaSet" && cache.replicasets != nil {
			for _, rs := range cache.replicasets.Items {
				if rs.Name == ownerName && rs.Namespace == ns && len(rs.OwnerReferences) > 0 {
					ownerKind = rs.OwnerReferences[0].Kind
					ownerName = rs.OwnerReferences[0].Name
					break
				}
			}
		}
		return ownerKind, ownerName
	}
	return "Pod", podName
}

func jitExpiryLoop() {
	for {
		time.Sleep(30 * time.Second)

		jitRestore()

		now := time.Now()
		changed := false
		jitStore.mu.Lock()
		for i := range jitStore.requests {
			r := &jitStore.requests[i]
			if r.Status == "active" && r.ExpiresAt != nil && now.After(*r.ExpiresAt) {
				r.Status = "expired"
				changed = true
				slog.Info("jit: request expired", "id", r.ID, "email", r.Email, "namespace", r.Namespace)
				auditRecord(r.Email, "viewer", "jit.expired", jitResourceStr(r), "auto-expired", "")
			}
			if r.Status == "pending" && now.Sub(r.CreatedAt) > jitPendingTTL {
				r.Status = "expired"
				changed = true
				slog.Info("jit: pending request timed out", "id", r.ID, "email", r.Email, "namespace", r.Namespace)
				auditRecord(r.Email, "viewer", "jit.expired", jitResourceStr(r), "pending request timed out", "")
			}
		}
		jitStore.mu.Unlock()

		if changed {
			jitPersist()
		}
	}
}

// POST /api/jit/requests — create a new request (any authenticated user)
// GET  /api/jit/requests — list requests (admin sees all, viewer sees own)
func apiJITRequests(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		apiJITCreate(w, r)
	case http.MethodGet:
		apiJITList(w, r)
	default:
		je(w, "method not allowed", 405)
	}
}

func apiJITCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Namespace string `json:"namespace"`
		Pod       string `json:"pod"`
		OwnerKind string `json:"ownerKind"`
		OwnerName string `json:"ownerName"`
		Reason    string `json:"reason"`
		Duration  string `json:"duration"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		je(w, "invalid JSON", 400)
		return
	}
	if body.Namespace == "" || body.Reason == "" || body.Duration == "" {
		je(w, "namespace, reason, and duration required", 400)
		return
	}
	if body.OwnerKind == "" && body.Pod != "" {
		body.OwnerKind, body.OwnerName = resolvePodOwner(body.Namespace, body.Pod)
	}

	validDurations := map[string]bool{"30m": true, "1h": true, "2h": true, "4h": true}
	if !validDurations[body.Duration] {
		// Also accept any valid Go duration up to 7 days
		if d, err := time.ParseDuration(body.Duration); err != nil || d <= 0 || d > 7*24*time.Hour {
			je(w, "duration must be a valid duration up to 7 days (e.g. 30m, 1h, 2h, 4h, 8h, 24h, 48h, 168h)", 400)
			return
		}
	}

	email := "anonymous"
	role := defaultRole
	if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
		email = sd.Email
		role = sd.Role
	}

	req := jitRequest{
		ID:        jitID(),
		Email:     email,
		Namespace: body.Namespace,
		Pod:       body.Pod,
		OwnerKind: body.OwnerKind,
		OwnerName: body.OwnerName,
		Reason:    body.Reason,
		Duration:  body.Duration,
		Status:    "pending",
		CreatedAt: time.Now(),
	}

	jitStore.mu.Lock()
	jitStore.requests = append([]jitRequest{req}, jitStore.requests...)
	if len(jitStore.requests) > jitMaxRequests {
		jitStore.requests = jitStore.requests[:jitMaxRequests]
	}
	jitStore.mu.Unlock()

	go jitPersist()

	resource := fmt.Sprintf("Namespace %s", body.Namespace)
	if body.OwnerKind != "" && body.OwnerName != "" {
		resource += fmt.Sprintf(", %s %s", body.OwnerKind, body.OwnerName)
	} else if body.Pod != "" {
		resource += fmt.Sprintf(", Pod %s", body.Pod)
	}
	auditRecord(email, role, "jit.request", resource, "duration: "+body.Duration+", reason: "+body.Reason, clientIP(r))
	slog.Info("jit: new request", "id", req.ID, "email", email, "namespace", body.Namespace, "pod", body.Pod)
	slackNotifyJIT(req)

	j(w, req)
}

func apiJITList(w http.ResponseWriter, r *http.Request) {
	email := ""
	isAdmin := false
	if !authEnabled {
		isAdmin = defaultRole == "admin"
	} else if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
		email = sd.Email
		isAdmin = sd.Role == "admin"
	}

	jitStore.mu.Lock()
	result := make([]jitRequest, 0)
	for _, req := range jitStore.requests {
		if isAdmin || req.Email == email {
			result = append(result, req)
		}
	}
	jitStore.mu.Unlock()

	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	j(w, result)
}

// GET /api/jit/my-grants — viewer's active grants
func apiJITMyGrants(w http.ResponseWriter, r *http.Request) {
	email := "anonymous"
	if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
		email = sd.Email
	}

	now := time.Now()
	jitStore.mu.Lock()
	grants := make([]jitRequest, 0)
	for _, req := range jitStore.requests {
		if req.Email == email && req.Status == "active" && req.ExpiresAt != nil && now.Before(*req.ExpiresAt) {
			grants = append(grants, req)
		}
	}
	jitStore.mu.Unlock()

	j(w, grants)
}

// /api/jit/{id}/approve, /api/jit/{id}/deny, /api/jit/{id}/revoke
func apiJITAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		je(w, "method not allowed", 405)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/jit/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) != 2 {
		je(w, "invalid path", 400)
		return
	}
	id, action := parts[0], parts[1]

	if action != "approve" && action != "deny" && action != "revoke" {
		je(w, "invalid action", 400)
		return
	}

	if !requireAdmin(w, r) {
		return
	}

	adminEmail := "admin"
	if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
		adminEmail = sd.Email
	}

	switch action {
	case "approve":
		if err := jitApprove(id, adminEmail, clientIP(r)); err != nil {
			code := 400
			if err == errJITNotFound { code = 404 }
			je(w, err.Error(), code)
			return
		}
		jitStore.mu.Lock()
		req := jitFindByID(id)
		jitStore.mu.Unlock()
		if req != nil {
			slackNotifyJITResult(req, "approve", adminEmail)
		}

	case "deny":
		if err := jitDeny(id, adminEmail, clientIP(r)); err != nil {
			code := 400
			if err == errJITNotFound { code = 404 }
			je(w, err.Error(), code)
			return
		}
		jitStore.mu.Lock()
		req := jitFindByID(id)
		jitStore.mu.Unlock()
		if req != nil {
			slackNotifyJITResult(req, "deny", adminEmail)
		}

	case "revoke":
		jitStore.mu.Lock()
		req := jitFindByID(id)
		if req == nil {
			jitStore.mu.Unlock()
			je(w, "request not found", 404)
			return
		}
		if req.Status != "active" {
			jitStore.mu.Unlock()
			je(w, "can only revoke active requests", 400)
			return
		}
		req.Status = "revoked"
		jitStore.mu.Unlock()
		auditRecord(adminEmail, "admin", "jit.revoke", jitResourceStr(req), fmt.Sprintf("requester: %s", req.Email), clientIP(r))
		slog.Info("jit: request revoked", "id", id, "revoked_by", adminEmail)
		go jitPersist()
		slackNotifyJITResult(req, "revoke", adminEmail)
	}

	j(w, map[string]string{"status": "ok"})
}
