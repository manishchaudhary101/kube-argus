package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"compress/gzip"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"math"
	"regexp"
	"strconv"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/ec2"
	"github.com/aws/aws-sdk-go/service/secretsmanager"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gorilla/websocket"
	"golang.org/x/oauth2"

	appsv1 "k8s.io/api/apps/v1"
	autov2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	"sort"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/client-go/util/retry"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
	metricsapi "k8s.io/metrics/pkg/apis/metrics/v1beta1"
)

var (
	clientset   *kubernetes.Clientset
	metricsCl   *metricsv.Clientset
	restCfg     *rest.Config
	clusterName string
)

// ─── Auth (OIDC / Google / None) ────────────────────────────────────

var (
	oauthConfig    *oauth2.Config
	oidcProvider   *oidc.Provider
	oidcVerifier   *oidc.IDTokenVerifier
	sessionKey     []byte
	oidcAdminGroup string
	oidcIssuer     string
	authEnabled    bool
	authMode       string // "google", "oidc", or "none"
	adminEmails    map[string]bool
	defaultRole    string
	sessionTTL     time.Duration
	corsOrigin     string
)

type sessionData struct {
	Email string `json:"email"`
	Role  string `json:"role"`
	Exp   int64  `json:"exp"`
}

type ctxKey string

const userCtxKey ctxKey = "user"

// envWithFallback reads primary env var, falls back to legacy name if empty.
func envWithFallback(primary, legacy string) string {
	if v := os.Getenv(primary); v != "" {
		return v
	}
	return os.Getenv(legacy)
}

func loadSecretsFromAWS() {
	secretName := os.Getenv("AWS_SECRET_NAME")
	if secretName == "" {
		log.Println("AWS_SECRET_NAME not set — skipping Secrets Manager")
		return
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}

	sess, err := session.NewSession(&aws.Config{Region: aws.String(region)})
	if err != nil {
		log.Printf("AWS session init failed (secrets won't load from SM): %v", err)
		return
	}
	svc := secretsmanager.New(sess)
	result, err := svc.GetSecretValue(&secretsmanager.GetSecretValueInput{
		SecretId: aws.String(secretName),
	})
	if err != nil {
		log.Printf("Failed to fetch secret %q: %v", secretName, err)
		return
	}
	if result.SecretString == nil {
		log.Printf("Secret %q has no string value", secretName)
		return
	}

	var secrets map[string]string
	if err := json.Unmarshal([]byte(*result.SecretString), &secrets); err != nil {
		log.Printf("Failed to parse secret JSON: %v", err)
		return
	}

	envKeys := []string{"OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_SECRET", "OIDC_ADMIN_GROUP", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAILS", "DEFAULT_ROLE", "CLUSTER_NAME", "LLM_GATEWAY_URL", "LLM_GATEWAY_KEY", "LLM_GATEWAY_MODEL", "PROMETHEUS_URL", "PROMETHEUS_USER", "PROMETHEUS_KEY"}
	loaded := 0
	for _, k := range envKeys {
		if v, ok := secrets[k]; ok && v != "" && os.Getenv(k) == "" {
			os.Setenv(k, v)
			loaded++
		}
	}
	log.Printf("Loaded %d auth secrets from AWS Secrets Manager (%s)", loaded, secretName)
}

func initAuth() {
	loadSecretsFromAWS()

	// ── Provider-independent settings ───────────────────────────────
	sessionTTL = 8 * time.Hour
	if ttl := os.Getenv("SESSION_TTL"); ttl != "" {
		if d, err := time.ParseDuration(ttl); err == nil && d > 0 {
			sessionTTL = d
		}
	}

	corsOrigin = os.Getenv("CORS_ORIGIN")

	defaultRole = os.Getenv("DEFAULT_ROLE")
	if defaultRole != "admin" && defaultRole != "viewer" {
		defaultRole = "viewer"
	}

	adminEmails = map[string]bool{}
	if raw := os.Getenv("ADMIN_EMAILS"); raw != "" {
		for _, e := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(strings.ToLower(e)); trimmed != "" {
				adminEmails[trimmed] = true
			}
		}
	}

	oidcAdminGroup = envWithFallback("OIDC_ADMIN_GROUP", "OKTA_ADMIN_GROUP")
	if oidcAdminGroup == "" {
		oidcAdminGroup = "admin"
	}

	// ── Detect auth mode ────────────────────────────────────────────
	googleClientID := os.Getenv("GOOGLE_CLIENT_ID")
	googleClientSecret := os.Getenv("GOOGLE_CLIENT_SECRET")
	oidcClientID := envWithFallback("OIDC_CLIENT_ID", "OKTA_CLIENT_ID")
	oidcClientSecret := envWithFallback("OIDC_CLIENT_SECRET", "OKTA_CLIENT_SECRET")
	oidcIssuerEnv := envWithFallback("OIDC_ISSUER", "OKTA_ISSUER")

	var issuer, clientID, clientSecret string
	var scopes []string

	switch {
	case googleClientID != "" && googleClientSecret != "":
		authMode = "google"
		issuer = "https://accounts.google.com"
		clientID = googleClientID
		clientSecret = googleClientSecret
		scopes = []string{oidc.ScopeOpenID, "profile", "email"}

	case oidcIssuerEnv != "" && oidcClientID != "" && oidcClientSecret != "":
		authMode = "oidc"
		issuer = oidcIssuerEnv
		clientID = oidcClientID
		clientSecret = oidcClientSecret
		scopes = []string{oidc.ScopeOpenID, "profile", "email", "groups"}

	default:
		authMode = "none"
		authEnabled = false
		log.Printf("Auth mode: none (no login required, default role: %s)", defaultRole)
		return
	}

	oidcIssuer = issuer

	// ── Session signing key ─────────────────────────────────────────
	secret := os.Getenv("SESSION_SECRET")
	if secret == "" {
		b := make([]byte, 32)
		rand.Read(b)
		sessionKey = b
		log.Println("SESSION_SECRET not set, generated random key (sessions won't survive restarts)")
	} else {
		var err error
		sessionKey, err = hex.DecodeString(secret)
		if err != nil {
			sessionKey = []byte(secret)
		}
	}

	// ── OIDC provider discovery ─────────────────────────────────────
	ctx := context.Background()
	var err error
	oidcProvider, err = oidc.NewProvider(ctx, issuer)
	if err != nil {
		log.Fatalf("OIDC provider init failed: %v", err)
	}

	oauthConfig = &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Endpoint:     oidcProvider.Endpoint(),
		Scopes:       scopes,
	}

	oidcVerifier = oidcProvider.Verifier(&oidc.Config{ClientID: clientID})
	authEnabled = true
	log.Printf("Auth mode: %s (issuer=%s)", authMode, issuer)
}

func signSession(sd sessionData) (string, error) {
	payload, _ := json.Marshal(sd)
	b64 := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, sessionKey)
	mac.Write([]byte(b64))
	sig := hex.EncodeToString(mac.Sum(nil))
	return b64 + "." + sig, nil
}

func verifySession(cookie string) (*sessionData, error) {
	parts := strings.SplitN(cookie, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid session format")
	}
	mac := hmac.New(sha256.New, sessionKey)
	mac.Write([]byte(parts[0]))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[1]), []byte(expected)) {
		return nil, fmt.Errorf("invalid signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var sd sessionData
	if err := json.Unmarshal(payload, &sd); err != nil {
		return nil, err
	}
	if time.Now().Unix() > sd.Exp {
		return nil, fmt.Errorf("session expired")
	}
	return &sd, nil
}

func setSessionCookie(w http.ResponseWriter, sd sessionData) {
	val, err := signSession(sd)
	if err != nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "k8sdash_session",
		Value:    val,
		Path:     "/",
		HttpOnly: true,
		Secure:   os.Getenv("INSECURE_COOKIE") != "true",
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "k8sdash_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
}

func callbackURL(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil {
		if fwd := r.Header.Get("X-Forwarded-Proto"); fwd != "" {
			scheme = fwd
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	return scheme + "://" + host + "/auth/callback"
}

func authLogin(w http.ResponseWriter, r *http.Request) {
	oauthConfig.RedirectURL = callbackURL(r)
	state := fmt.Sprintf("%d", time.Now().UnixNano())
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: state, Path: "/", HttpOnly: true, MaxAge: 600, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"})
	http.Redirect(w, r, oauthConfig.AuthCodeURL(state), http.StatusFound)
}

func authCallback(w http.ResponseWriter, r *http.Request) {
	// IdP-initiated flow (e.g. clicking an app tile in the IdP portal): no code/state params.
	// Redirect to /auth/login to start the proper OIDC authorization flow.
	if r.URL.Query().Get("code") == "" {
		http.Redirect(w, r, "/auth/login", http.StatusFound)
		return
	}

	stateCookie, err := r.Cookie("oauth_state")
	if err != nil || r.URL.Query().Get("state") != stateCookie.Value {
		http.Redirect(w, r, "/auth/login", http.StatusFound)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: "", Path: "/", MaxAge: -1})

	oauthConfig.RedirectURL = callbackURL(r)
	token, err := oauthConfig.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed: "+err.Error(), 500)
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token in response", 500)
		return
	}

	idToken, err := oidcVerifier.Verify(r.Context(), rawIDToken)
	if err != nil {
		http.Error(w, "token verify failed: "+err.Error(), 500)
		return
	}

	var claims struct {
		Email  string   `json:"email"`
		Groups []string `json:"groups"`
	}
	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "claims parse failed: "+err.Error(), 500)
		return
	}

	role := "viewer"
	if adminEmails[strings.ToLower(claims.Email)] {
		role = "admin"
	} else {
		for _, g := range claims.Groups {
			if g == oidcAdminGroup {
				role = "admin"
				break
			}
		}
	}

	sd := sessionData{Email: claims.Email, Role: role, Exp: time.Now().Add(sessionTTL).Unix()}
	setSessionCookie(w, sd)
	log.Printf("auth: %s logged in as %s", claims.Email, role)

	redirectTo := "/"
	if rc, err := r.Cookie("k8sdash_return"); err == nil && rc.Value != "" && strings.HasPrefix(rc.Value, "/") {
		redirectTo = rc.Value
		http.SetCookie(w, &http.Cookie{Name: "k8sdash_return", Value: "", Path: "/", MaxAge: -1})
	}
	http.Redirect(w, r, redirectTo, http.StatusFound)
}

func authLogout(w http.ResponseWriter, r *http.Request) {
	clearSessionCookie(w)
	if oidcIssuer != "" && oidcProvider != nil && oauthConfig != nil {
		scheme := "https"
		if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") == "" {
			scheme = "http"
		}
		postRedirect := scheme + "://" + r.Host + "/"

		// Use OIDC discovery to find end_session_endpoint (works with any provider).
		var claims struct {
			EndSessionEndpoint string `json:"end_session_endpoint"`
		}
		if err := oidcProvider.Claims(&claims); err == nil && claims.EndSessionEndpoint != "" {
			logoutURL := claims.EndSessionEndpoint +
				"?client_id=" + oauthConfig.ClientID +
				"&post_logout_redirect_uri=" + postRedirect
			http.Redirect(w, r, logoutURL, http.StatusFound)
			return
		}

		// Fallback: redirect to issuer root (session cookie is already cleared).
		http.Redirect(w, r, postRedirect, http.StatusFound)
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

func apiMe(w http.ResponseWriter, r *http.Request) {
	if !authEnabled {
		j(w, map[string]string{"email": "anonymous", "role": defaultRole, "authMode": authMode})
		return
	}
	sd, ok := r.Context().Value(userCtxKey).(*sessionData)
	if !ok || sd == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized", "authMode": authMode})
		return
	}
	j(w, map[string]string{"email": sd.Email, "role": sd.Role, "authMode": authMode})
}

// ─── Auth Middleware ──────────────────────────────────────────────────

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authEnabled {
			next.ServeHTTP(w, r)
			return
		}

		path := r.URL.Path
		if path == "/health" || strings.HasPrefix(path, "/auth/") {
			next.ServeHTTP(w, r)
			return
		}

		cookie, err := r.Cookie("k8sdash_session")
		if err != nil {
			if strings.HasPrefix(path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(401)
				json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			} else {
				returnTo := r.URL.RequestURI()
				if returnTo != "" && returnTo != "/" {
					http.SetCookie(w, &http.Cookie{Name: "k8sdash_return", Value: returnTo, Path: "/", HttpOnly: true, MaxAge: 300, SameSite: http.SameSiteLaxMode})
				}
				http.Redirect(w, r, "/auth/login", http.StatusFound)
			}
			return
		}

		sd, err := verifySession(cookie.Value)
		if err != nil {
			clearSessionCookie(w)
			if strings.HasPrefix(path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(401)
				json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			} else {
				returnTo := r.URL.RequestURI()
				if returnTo != "" && returnTo != "/" {
					http.SetCookie(w, &http.Cookie{Name: "k8sdash_return", Value: returnTo, Path: "/", HttpOnly: true, MaxAge: 300, SameSite: http.SameSiteLaxMode})
				}
				http.Redirect(w, r, "/auth/login", http.StatusFound)
			}
			return
		}

		ctx := context.WithValue(r.Context(), userCtxKey, sd)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !authEnabled {
		if defaultRole == "admin" {
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		json.NewEncoder(w).Encode(map[string]string{"error": "forbidden", "message": "admin access required — set DEFAULT_ROLE=admin or sign in with an admin account"})
		return false
	}
	sd, ok := r.Context().Value(userCtxKey).(*sessionData)
	if !ok || sd == nil || sd.Role != "admin" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		json.NewEncoder(w).Encode(map[string]string{"error": "forbidden", "message": "admin access required"})
		return false
	}
	return true
}

// ─── Background Cache ────────────────────────────────────────────────

type clusterCache struct {
	mu             sync.RWMutex
	nodes          *corev1.NodeList
	pods           *corev1.PodList
	deployments    *appsv1.DeploymentList
	statefulsets   *appsv1.StatefulSetList
	daemonsets     *appsv1.DaemonSetList
	services       *corev1.ServiceList
	jobs           *batchv1.JobList
	cronjobs       *batchv1.CronJobList
	namespaces     *corev1.NamespaceList
	events         *corev1.EventList
	ingresses      *netv1.IngressList
	hpas           *autov2.HorizontalPodAutoscalerList
	configMeta     []configMeta
	secretMeta     []configMeta
	nodeMetrics    *metricsapi.NodeMetricsList
	podMetrics     *metricsapi.PodMetricsList
	pdbs           *policyv1.PodDisruptionBudgetList
	replicasets    *appsv1.ReplicaSetList
	lastRefresh    time.Time
}

type configMeta struct {
	Name         string
	Namespace    string
	Keys         []string
	Type         string
	CreatedAt    time.Time
	LastModified time.Time
	Version      string
}

var cache = &clusterCache{}

func (c *clusterCache) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	var nodes *corev1.NodeList
	var pods *corev1.PodList
	var deps *appsv1.DeploymentList
	var sts *appsv1.StatefulSetList
	var ds *appsv1.DaemonSetList
	var svcs *corev1.ServiceList
	var jobs *batchv1.JobList
	var cjobs *batchv1.CronJobList
	var nsList *corev1.NamespaceList
	var events *corev1.EventList
	var ings *netv1.IngressList
	var hpas *autov2.HorizontalPodAutoscalerList
	var cmMeta []configMeta
	var secMeta []configMeta
	var nodeMetrics *metricsapi.NodeMetricsList
	var podMetrics *metricsapi.PodMetricsList
	var pdbs *policyv1.PodDisruptionBudgetList
	var rsList *appsv1.ReplicaSetList

	wg.Add(15)
	go func() { defer wg.Done(); nodes, _ = clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); pods, _ = clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{}) }()
	go func() {
		defer wg.Done()
		deps, _ = clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
		sts, _ = clientset.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
		ds, _ = clientset.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		svcs, _ = clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		jobs, _ = clientset.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
		cjobs, _ = clientset.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
	}()
	go func() { defer wg.Done(); nsList, _ = clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); events, _ = clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); ings, _ = clientset.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); hpas, _ = clientset.AutoscalingV2().HorizontalPodAutoscalers("").List(ctx, metav1.ListOptions{}) }()
	go func() {
		defer wg.Done()
		if result, err := clientset.CoreV1().ConfigMaps("").List(ctx, metav1.ListOptions{}); err == nil {
			meta := make([]configMeta, 0, len(result.Items))
			for _, cm := range result.Items {
				keys := make([]string, 0, len(cm.Data)+len(cm.BinaryData))
				for k := range cm.Data { keys = append(keys, k) }
				for k := range cm.BinaryData { keys = append(keys, k+" (binary)") }
				sort.Strings(keys)
				lastMod := cm.CreationTimestamp.Time
			if lm, ok := cm.Annotations["kubectl.kubernetes.io/last-applied-configuration"]; ok && len(lm) > 0 {
				lastMod = cm.CreationTimestamp.Time
			}
			if cm.ManagedFields != nil {
				for _, mf := range cm.ManagedFields {
					if mf.Time != nil && mf.Time.Time.After(lastMod) { lastMod = mf.Time.Time }
				}
			}
			meta = append(meta, configMeta{Name: cm.Name, Namespace: cm.Namespace, Keys: keys, CreatedAt: cm.CreationTimestamp.Time, LastModified: lastMod, Version: cm.ResourceVersion})
			}
			cmMeta = meta
		}
	}()
	go func() {
		defer wg.Done()
		if result, err := clientset.CoreV1().Secrets("").List(ctx, metav1.ListOptions{}); err == nil {
			meta := make([]configMeta, 0, len(result.Items))
			for _, s := range result.Items {
				if s.Type == corev1.SecretTypeServiceAccountToken { continue }
				keys := make([]string, 0, len(s.Data)+len(s.StringData))
				for k := range s.Data { keys = append(keys, k) }
				for k := range s.StringData { keys = append(keys, k) }
				sort.Strings(keys)
				lastMod := s.CreationTimestamp.Time
			if s.ManagedFields != nil {
				for _, mf := range s.ManagedFields {
					if mf.Time != nil && mf.Time.Time.After(lastMod) { lastMod = mf.Time.Time }
				}
			}
			meta = append(meta, configMeta{Name: s.Name, Namespace: s.Namespace, Keys: keys, Type: string(s.Type), CreatedAt: s.CreationTimestamp.Time, LastModified: lastMod, Version: s.ResourceVersion})
			}
			secMeta = meta
		}
	}()
	go func() {
		defer wg.Done()
		if metricsCl != nil {
			nodeMetrics, _ = metricsCl.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		if metricsCl != nil {
			podMetrics, _ = metricsCl.MetricsV1beta1().PodMetricses("").List(ctx, metav1.ListOptions{})
		}
	}()
	go func() { defer wg.Done(); pdbs, _ = clientset.PolicyV1().PodDisruptionBudgets("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); rsList, _ = clientset.AppsV1().ReplicaSets("").List(ctx, metav1.ListOptions{}) }()
	wg.Wait()

	c.mu.Lock()
	defer c.mu.Unlock()
	if nodes != nil { c.nodes = nodes }
	if pods != nil { c.pods = pods }
	if deps != nil { c.deployments = deps }
	if sts != nil { c.statefulsets = sts }
	if ds != nil { c.daemonsets = ds }
	if svcs != nil { c.services = svcs }
	if jobs != nil { c.jobs = jobs }
	if cjobs != nil { c.cronjobs = cjobs }
	if nsList != nil { c.namespaces = nsList }
	if events != nil { c.events = events }
	if ings != nil { c.ingresses = ings }
	if hpas != nil { c.hpas = hpas }
	if cmMeta != nil { c.configMeta = cmMeta }
	if secMeta != nil { c.secretMeta = secMeta }
	if nodeMetrics != nil { c.nodeMetrics = nodeMetrics }
	if podMetrics != nil { c.podMetrics = podMetrics }
	if pdbs != nil { c.pdbs = pdbs }
	if rsList != nil { c.replicasets = rsList }
	c.lastRefresh = time.Now()
}

func startCacheLoop() {
	cache.refresh()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		for range ticker.C {
			cache.refresh()
		}
	}()
}

// ─── Spot Advisor Cache ─────────────────────────────────────────────

type spotAdvisorEntry struct {
	R int     `json:"r"` // interruption range: 0=<5%, 1=5-10%, 2=10-15%, 3=15-20%, 4=>20%
	S int     `json:"s"` // savings % vs on-demand
}

type spotInstanceTypeInfo struct {
	Cores  int     `json:"cores"`
	RamGB  float64 `json:"ram_gb"`
	EMR    bool    `json:"emr"`
}

type spotAdvisorData struct {
	mu           sync.RWMutex
	entries      map[string]spotAdvisorEntry   // instanceType -> advisor entry (for detected region)
	typeSpecs    map[string]spotInstanceTypeInfo // instanceType -> specs
	spotPrices   map[string]float64             // instanceType -> current spot price/hr
	region       string
	lastRefresh  time.Time
}

var spotCache = &spotAdvisorData{}

func detectRegion() string {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.nodes == nil { return "" }
	for _, n := range cache.nodes.Items {
		if z, ok := n.Labels["topology.kubernetes.io/zone"]; ok && len(z) > 1 {
			return z[:len(z)-1]
		}
		if z, ok := n.Labels["failure-domain.beta.kubernetes.io/zone"]; ok && len(z) > 1 {
			return z[:len(z)-1]
		}
	}
	return ""
}

func (s *spotAdvisorData) refresh() {
	region := detectRegion()
	if region == "" {
		log.Println("spot-advisor: could not detect region, skipping")
		return
	}

	resp, err := http.Get("https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json")
	if err != nil {
		log.Printf("spot-advisor: fetch failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		log.Printf("spot-advisor: HTTP %d", resp.StatusCode)
		return
	}

	var raw struct {
		InstanceTypes map[string]spotInstanceTypeInfo            `json:"instance_types"`
		SpotAdvisor   map[string]map[string]map[string]spotAdvisorEntry `json:"spot_advisor"` // region -> OS -> type -> entry
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		log.Printf("spot-advisor: decode failed: %v", err)
		return
	}

	entries := make(map[string]spotAdvisorEntry)
	if regionData, ok := raw.SpotAdvisor[region]; ok {
		if linuxData, ok := regionData["Linux"]; ok {
			entries = linuxData
		}
	}

	// Fetch current spot prices for instance types we're actually using
	spotPrices := map[string]float64{}
	cache.mu.RLock()
	usedTypes := map[string]bool{}
	if cache.nodes != nil {
		for _, n := range cache.nodes.Items {
			if t, ok := n.Labels["node.kubernetes.io/instance-type"]; ok {
				usedTypes[t] = true
			}
		}
	}
	cache.mu.RUnlock()

	// Also include alternatives and consolidation options for pricing
	baseTypes := make([]string, 0, len(usedTypes))
	for t := range usedTypes { baseTypes = append(baseTypes, t) }
	for _, t := range baseTypes {
		for _, alt := range generateAlternatives(t) {
			usedTypes[alt] = true
		}
		for _, alt := range generateConsolidationAlternatives(t) {
			usedTypes[alt] = true
		}
	}

	if len(usedTypes) > 0 {
		func() {
			defer func() { recover() }() // graceful if no EC2 permissions
			sess, err := session.NewSession(&aws.Config{Region: aws.String(region)})
			if err != nil { return }
			ec2Client := ec2.New(sess)
			typeNames := make([]*string, 0, len(usedTypes))
			for t := range usedTypes { typeNames = append(typeNames, aws.String(t)) }

			// Batch in groups of 50 to avoid API limits
			for i := 0; i < len(typeNames); i += 50 {
				end := i + 50
				if end > len(typeNames) { end = len(typeNames) }
				batch := typeNames[i:end]
				input := &ec2.DescribeSpotPriceHistoryInput{
					InstanceTypes:       batch,
					ProductDescriptions: []*string{aws.String("Linux/UNIX")},
					StartTime:           aws.Time(time.Now()),
				}
				out, err := ec2Client.DescribeSpotPriceHistory(input)
				if err != nil {
					log.Printf("spot-advisor: price fetch failed: %v", err)
					return
				}
				for _, sp := range out.SpotPriceHistory {
					if sp.InstanceType != nil && sp.SpotPrice != nil {
						if price, err := strconv.ParseFloat(*sp.SpotPrice, 64); err == nil {
							key := *sp.InstanceType
							if existing, ok := spotPrices[key]; !ok || price < existing {
								spotPrices[key] = price
							}
						}
					}
				}
			}
		}()
	}

	s.mu.Lock()
	s.entries = entries
	s.typeSpecs = raw.InstanceTypes
	s.spotPrices = spotPrices
	s.region = region
	s.lastRefresh = time.Now()
	s.mu.Unlock()
	log.Printf("spot-advisor: loaded %d entries for %s, %d prices", len(entries), region, len(spotPrices))
}

func parseInstanceType(instanceType string) (baseChar string, gen int, suffix string, size string) {
	parts := strings.SplitN(instanceType, ".", 2)
	if len(parts) != 2 { return }
	family := parts[0]
	size = parts[1]
	baseChar = string(family[0])
	genStr := ""
	for i := 1; i < len(family); i++ {
		c := family[i]
		if c >= '0' && c <= '9' {
			genStr += string(c)
		} else {
			suffix += string(c)
		}
	}
	fmt.Sscanf(genStr, "%d", &gen)
	return
}

func isGraviton(suffix string) bool {
	return strings.Contains(suffix, "g")
}

func generateAlternatives(instanceType string) []string {
	baseChar, gen, suffix, size := parseInstanceType(instanceType)
	if size == "" { return nil }

	graviton := isGraviton(suffix)

	// Only suggest variants matching the same CPU architecture
	var variants []string
	if graviton {
		variants = []string{"g", "gd"}
	} else {
		variants = []string{"", "i", "a", "ad", "id", "n"}
	}

	alternatives := []string{}
	for g := gen; g <= gen+3 && g <= 8; g++ {
		for _, v := range variants {
			candidate := fmt.Sprintf("%s%d%s.%s", baseChar, g, v, size)
			if candidate != instanceType {
				alternatives = append(alternatives, candidate)
			}
		}
	}

	crossFamilies := map[string][]string{
		"m": {"c", "r"},
		"c": {"m"},
		"r": {"m"},
	}
	if related, ok := crossFamilies[baseChar]; ok {
		for _, rf := range related {
			for g := gen - 1; g <= gen+2 && g <= 8; g++ {
				if g < 5 { continue }
				for _, v := range variants {
					candidate := fmt.Sprintf("%s%d%s.%s", rf, g, v, size)
					alternatives = append(alternatives, candidate)
				}
			}
		}
	}

	return alternatives
}

var sizeOrder = []string{"large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge", "metal"}

func sizeIndex(s string) int {
	for i, v := range sizeOrder {
		if v == s { return i }
	}
	return -1
}

func generateConsolidationAlternatives(instanceType string) []string {
	baseChar, gen, suffix, size := parseInstanceType(instanceType)
	if size == "" { return nil }

	idx := sizeIndex(size)
	if idx < 0 { return nil }

	graviton := isGraviton(suffix)
	var variants []string
	if graviton {
		variants = []string{"g", "gd"}
	} else {
		variants = []string{"", "i", "a", "ad", "n"}
	}

	alternatives := []string{}
	for si := idx + 1; si < len(sizeOrder); si++ {
		upSize := sizeOrder[si]
		for g := gen - 1; g <= gen+2 && g <= 8; g++ {
			if g < 5 { continue }
			for _, v := range variants {
				candidate := fmt.Sprintf("%s%d%s.%s", baseChar, g, v, upSize)
				if candidate != instanceType {
					alternatives = append(alternatives, candidate)
				}
			}
		}
		crossFamilies := map[string][]string{
			"m": {"c", "r"},
			"c": {"m"},
			"r": {"m"},
		}
		if related, ok := crossFamilies[baseChar]; ok {
			for _, rf := range related {
				for g := gen - 1; g <= gen+2 && g <= 8; g++ {
					if g < 5 { continue }
					for _, v := range variants {
						candidate := fmt.Sprintf("%s%d%s.%s", rf, g, v, upSize)
						alternatives = append(alternatives, candidate)
					}
				}
			}
		}
	}
	return alternatives
}

func interruptLabel(r int) string {
	switch r {
	case 0: return "<5%"
	case 1: return "5-10%"
	case 2: return "10-15%"
	case 3: return "15-20%"
	default: return ">20%"
	}
}

func startSpotAdvisorLoop() {
	go func() {
		time.Sleep(15 * time.Second) // let main cache warm up first
		spotCache.refresh()
		ticker := time.NewTicker(10 * time.Minute)
		for range ticker.C {
			spotCache.refresh()
		}
	}()
}

func apiSpotAdvisor(w http.ResponseWriter, r *http.Request) {
	spotCache.mu.RLock()
	defer spotCache.mu.RUnlock()

	if spotCache.entries == nil || len(spotCache.entries) == 0 {
		jGz(w, r, map[string]interface{}{"ready": false, "message": "Spot advisor data loading..."})
		return
	}

	cache.mu.RLock()
	defer cache.mu.RUnlock()

	if cache.nodes == nil {
		jGz(w, r, map[string]interface{}{"ready": false, "message": "Cluster cache not ready"})
		return
	}

	// Build per-node metrics lookup
	nodeUsage := map[string][2]int64{} // name -> {cpuMilli, memMiB}
	if cache.nodeMetrics != nil {
		for _, m := range cache.nodeMetrics.Items {
			nodeUsage[m.Name] = [2]int64{m.Usage.Cpu().MilliValue(), m.Usage.Memory().Value() / (1024 * 1024)}
		}
	}

	// Build per-node pod request sums
	nodeRequests := map[string][2]int64{} // name -> {cpuMilli, memMiB}
	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			if p.Status.Phase != corev1.PodRunning { continue }
			nn := p.Spec.NodeName
			if nn == "" { continue }
			cur := nodeRequests[nn]
			for _, c := range p.Spec.Containers {
				if r, ok := c.Resources.Requests[corev1.ResourceCPU]; ok { cur[0] += r.MilliValue() }
				if r, ok := c.Resources.Requests[corev1.ResourceMemory]; ok { cur[1] += r.Value() / (1024 * 1024) }
			}
			nodeRequests[nn] = cur
		}
	}

	type instanceSummary struct {
		InstanceType      string   `json:"instanceType"`
		Count             int      `json:"count"`
		VCPUs             int64    `json:"vcpus"`
		MemoryGiB         float64  `json:"memoryGiB"`
		InterruptRange    int      `json:"interruptRange"`
		InterruptLabel    string   `json:"interruptLabel"`
		SavingsPct        int      `json:"savingsPct"`
		SpotPrice         float64  `json:"spotPrice,omitempty"`
		MonthlyCost       float64  `json:"monthlyCost,omitempty"`
		TotalMonthlyCost  float64  `json:"totalMonthlyCost,omitempty"`
		Nodepools         []string `json:"nodepools"`
		TotalUsedCpuM     int64    `json:"totalUsedCpuM"`
		TotalUsedMemMi    int64    `json:"totalUsedMemMi"`
		TotalReqCpuM      int64    `json:"totalReqCpuM"`
		TotalReqMemMi     int64    `json:"totalReqMemMi"`
		TotalAllocCpuM    int64    `json:"totalAllocCpuM"`
		TotalAllocMemMi   int64    `json:"totalAllocMemMi"`
		AvgCpuPct         int      `json:"avgCpuPct"`
		AvgMemPct         int      `json:"avgMemPct"`
		EffectiveCpuM     int64    `json:"effectiveCpuM"`
		EffectiveMemMi    int64    `json:"effectiveMemMi"`
	}

	type alternative struct {
		InstanceType    string  `json:"instanceType"`
		VCPUs           int     `json:"vcpus"`
		MemoryGB        float64 `json:"memoryGB"`
		InterruptRange  int     `json:"interruptRange"`
		InterruptLabel  string  `json:"interruptLabel"`
		SavingsPct      int     `json:"savingsPct"`
		SpotPrice       float64 `json:"spotPrice,omitempty"`
		NodesNeeded     int     `json:"nodesNeeded"`
		TotalMonthlyCost float64 `json:"totalMonthlyCost,omitempty"`
		MonthlySaving   float64 `json:"monthlySaving"`
		FitNote         string  `json:"fitNote"`
		Score           float64 `json:"score"`
	}

	type recommendation struct {
		Current      instanceSummary `json:"current"`
		Alternatives []alternative   `json:"alternatives"`
	}

	// Collect current spot nodes with workload data
	typeMap := map[string]*instanceSummary{}
	totalSpotNodes := 0

	for _, n := range cache.nodes.Items {
		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" {
			if _, ok := n.Labels["eks.amazonaws.com/capacityType"]; ok {
				capType = strings.ToLower(n.Labels["eks.amazonaws.com/capacityType"])
			}
		}
		if capType != "spot" { continue }
		totalSpotNodes++

		itype := n.Labels["node.kubernetes.io/instance-type"]
		if itype == "" { itype = n.Labels["beta.kubernetes.io/instance-type"] }
		if itype == "" { continue }

		allocCpuM := n.Status.Allocatable.Cpu().MilliValue()
		allocMemMi := n.Status.Allocatable.Memory().Value() / (1024 * 1024)
		vcpus := allocCpuM / 1000
		memGiB := float64(allocMemMi) / 1024
		nodepool := n.Labels["karpenter.sh/nodepool"]

		usage := nodeUsage[n.Name]
		reqs := nodeRequests[n.Name]

		// Effective load = max(usage, requests) per resource
		effCpu := usage[0]
		if reqs[0] > effCpu { effCpu = reqs[0] }
		effMem := usage[1]
		if reqs[1] > effMem { effMem = reqs[1] }

		if _, ok := typeMap[itype]; !ok {
			entry := spotCache.entries[itype]
			price := spotCache.spotPrices[itype]
			typeMap[itype] = &instanceSummary{
				InstanceType:   itype,
				VCPUs:          vcpus,
				MemoryGiB:      math.Round(memGiB*10) / 10,
				InterruptRange: entry.R,
				InterruptLabel: interruptLabel(entry.R),
				SavingsPct:     entry.S,
				SpotPrice:      price,
				Nodepools:      []string{},
			}
		}
		s := typeMap[itype]
		s.Count++
		s.TotalUsedCpuM += usage[0]
		s.TotalUsedMemMi += usage[1]
		s.TotalReqCpuM += reqs[0]
		s.TotalReqMemMi += reqs[1]
		s.TotalAllocCpuM += allocCpuM
		s.TotalAllocMemMi += allocMemMi
		s.EffectiveCpuM += effCpu
		s.EffectiveMemMi += effMem

		found := false
		for _, np := range s.Nodepools {
			if np == nodepool { found = true; break }
		}
		if !found && nodepool != "" { s.Nodepools = append(s.Nodepools, nodepool) }
	}

	// Finalize per-type aggregates
	for _, s := range typeMap {
		s.MonthlyCost = s.SpotPrice * 730
		s.TotalMonthlyCost = s.SpotPrice * 730 * float64(s.Count)
		if s.TotalAllocCpuM > 0 { s.AvgCpuPct = int(s.TotalUsedCpuM * 100 / s.TotalAllocCpuM) }
		if s.TotalAllocMemMi > 0 { s.AvgMemPct = int(s.TotalUsedMemMi * 100 / s.TotalAllocMemMi) }
	}

	const packingFactor = 0.85

	// Build workload-aware recommendations
	recs := make([]recommendation, 0)
	for _, summary := range typeMap {
		alts := generateAlternatives(summary.InstanceType)
		altList := make([]alternative, 0)
		currentTotalCost := summary.TotalMonthlyCost

		for _, altType := range alts {
			entry, ok := spotCache.entries[altType]
			if !ok { continue }
			spec, hasSpec := spotCache.typeSpecs[altType]
			if !hasSpec { continue }

			price := spotCache.spotPrices[altType]

			// Calculate usable capacity per node of this alternative type
			altCpuCapM := float64(spec.Cores) * 1000 * packingFactor
			altMemCapMi := spec.RamGB * 1024 * packingFactor

			// How many alternative nodes needed to fit the effective workload?
			nodesByCpu := 1
			if altCpuCapM > 0 && summary.EffectiveCpuM > 0 {
				nodesByCpu = int(math.Ceil(float64(summary.EffectiveCpuM) / altCpuCapM))
			}
			nodesByMem := 1
			if altMemCapMi > 0 && summary.EffectiveMemMi > 0 {
				nodesByMem = int(math.Ceil(float64(summary.EffectiveMemMi) / altMemCapMi))
			}
			nodesNeeded := nodesByCpu
			if nodesByMem > nodesNeeded { nodesNeeded = nodesByMem }
			if nodesNeeded < 1 { nodesNeeded = 1 }

			totalCost := float64(0)
			if price > 0 { totalCost = price * 730 * float64(nodesNeeded) }

			// Only include if: cheaper total cost, OR same/fewer nodes with lower interruption
			isCheaper := totalCost > 0 && currentTotalCost > 0 && totalCost < currentTotalCost
			isBetterAvailability := entry.R < summary.InterruptRange && nodesNeeded <= summary.Count
			if !isCheaper && !isBetterAvailability { continue }

			saving := currentTotalCost - totalCost

			fitNote := ""
			if nodesNeeded < summary.Count {
				fitNote = fmt.Sprintf("%d nodes replace %d", nodesNeeded, summary.Count)
			} else if nodesNeeded == summary.Count {
				fitNote = "same node count"
			} else {
				fitNote = fmt.Sprintf("needs %d nodes (vs %d)", nodesNeeded, summary.Count)
			}
			if isBetterAvailability && !isCheaper {
				fitNote += ", lower interruptions"
			}

			// Score: lower is better; balance total cost and availability
			score := float64(0)
			if totalCost > 0 { score = totalCost / 100 }
			score += float64(entry.R) * 20
			score -= saving / 50

			altList = append(altList, alternative{
				InstanceType:     altType,
				VCPUs:            spec.Cores,
				MemoryGB:         spec.RamGB,
				InterruptRange:   entry.R,
				InterruptLabel:   interruptLabel(entry.R),
				SavingsPct:       entry.S,
				SpotPrice:        price,
				NodesNeeded:      nodesNeeded,
				TotalMonthlyCost: math.Round(totalCost*100) / 100,
				MonthlySaving:    math.Round(saving*100) / 100,
				FitNote:          fitNote,
				Score:            math.Round(score*100) / 100,
			})
		}
		sort.Slice(altList, func(i, j int) bool { return altList[i].Score < altList[j].Score })
		if len(altList) > 8 { altList = altList[:8] }
		recs = append(recs, recommendation{Current: *summary, Alternatives: altList})
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Current.TotalMonthlyCost > recs[j].Current.TotalMonthlyCost })

	// Consolidation: suggest fewer, larger nodes across all instance types
	type consolidation struct {
		InstanceType     string  `json:"instanceType"`
		VCPUs            int     `json:"vcpus"`
		MemoryGB         float64 `json:"memoryGB"`
		InterruptRange   int     `json:"interruptRange"`
		InterruptLabel   string  `json:"interruptLabel"`
		SpotPrice        float64 `json:"spotPrice,omitempty"`
		NodesNeeded      int     `json:"nodesNeeded"`
		ReplacesNodes    int     `json:"replacesNodes"`
		ReplacesTypes    []string `json:"replacesTypes"`
		TotalMonthlyCost float64 `json:"totalMonthlyCost,omitempty"`
		MonthlySaving    float64 `json:"monthlySaving"`
		Reason           string  `json:"reason"`
		Score            float64 `json:"score"`
	}

	totalEffCpu := int64(0)
	totalEffMem := int64(0)
	totalCurrentCost := float64(0)
	allTypes := []string{}
	for _, s := range typeMap {
		totalEffCpu += s.EffectiveCpuM
		totalEffMem += s.EffectiveMemMi
		totalCurrentCost += s.TotalMonthlyCost
		allTypes = append(allTypes, s.InstanceType)
	}

	consols := make([]consolidation, 0)
	if totalSpotNodes >= 3 && totalEffCpu > 0 {
		seen := map[string]bool{}
		for _, itype := range allTypes {
			for _, altType := range generateConsolidationAlternatives(itype) {
				if seen[altType] { continue }
				seen[altType] = true

				entry, ok := spotCache.entries[altType]
				if !ok { continue }
				spec, hasSpec := spotCache.typeSpecs[altType]
				if !hasSpec { continue }
				price := spotCache.spotPrices[altType]

				altCpuCapM := float64(spec.Cores) * 1000 * packingFactor
				altMemCapMi := spec.RamGB * 1024 * packingFactor
				if altCpuCapM == 0 || altMemCapMi == 0 { continue }

				nodesByCpu := int(math.Ceil(float64(totalEffCpu) / altCpuCapM))
				nodesByMem := int(math.Ceil(float64(totalEffMem) / altMemCapMi))
				nodesNeeded := nodesByCpu
				if nodesByMem > nodesNeeded { nodesNeeded = nodesByMem }
				if nodesNeeded < 1 { nodesNeeded = 1 }

				if nodesNeeded >= totalSpotNodes { continue }

				totalCost := float64(0)
				if price > 0 { totalCost = price * 730 * float64(nodesNeeded) }
				saving := totalCurrentCost - totalCost

				reason := fmt.Sprintf("Consolidate %d nodes (%s) → %d x %s", totalSpotNodes, strings.Join(allTypes, ", "), nodesNeeded, altType)

				score := float64(nodesNeeded) * 10
				score += float64(entry.R) * 25
				if saving > 0 { score -= saving / 30 }

				consols = append(consols, consolidation{
					InstanceType:     altType,
					VCPUs:            spec.Cores,
					MemoryGB:         spec.RamGB,
					InterruptRange:   entry.R,
					InterruptLabel:   interruptLabel(entry.R),
					SpotPrice:        price,
					NodesNeeded:      nodesNeeded,
					ReplacesNodes:    totalSpotNodes,
					ReplacesTypes:    allTypes,
					TotalMonthlyCost: math.Round(totalCost*100) / 100,
					MonthlySaving:    math.Round(saving*100) / 100,
					Reason:           reason,
					Score:            math.Round(score*100) / 100,
				})
			}
		}
		sort.Slice(consols, func(i, j int) bool { return consols[i].Score < consols[j].Score })
		if len(consols) > 10 { consols = consols[:10] }
	}

	// Compute total cluster cost: spot + on-demand
	totalClusterNodes := 0
	totalOnDemandNodes := 0
	totalSpotMonthlyCost := totalCurrentCost
	totalOnDemandMonthlyCost := float64(0)
	onDemandByType := map[string]int{} // instanceType -> count

	for _, n := range cache.nodes.Items {
		totalClusterNodes++
		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" {
			if v, ok := n.Labels["eks.amazonaws.com/capacityType"]; ok {
				capType = strings.ToLower(v)
			}
		}
		if capType == "spot" { continue }
		totalOnDemandNodes++

		itype := n.Labels["node.kubernetes.io/instance-type"]
		if itype == "" { itype = n.Labels["beta.kubernetes.io/instance-type"] }
		if itype == "" { continue }
		onDemandByType[itype]++

		// Derive on-demand price from spot price + savings %
		if spotPrice, ok := spotCache.spotPrices[itype]; ok && spotPrice > 0 {
			if entry, ok2 := spotCache.entries[itype]; ok2 && entry.S > 0 && entry.S < 100 {
				odPrice := spotPrice / (1 - float64(entry.S)/100)
				totalOnDemandMonthlyCost += odPrice * 730
				continue
			}
		}
		// Fallback: estimate based on vCPU count (~$0.04/hr per vCPU for on-demand as rough average)
		allocCpuM := n.Status.Allocatable.Cpu().MilliValue()
		if allocCpuM > 0 {
			totalOnDemandMonthlyCost += (float64(allocCpuM) / 1000) * 0.04 * 730
		}
	}

	type onDemandSummary struct {
		InstanceType string `json:"instanceType"`
		Count        int    `json:"count"`
	}
	odList := make([]onDemandSummary, 0, len(onDemandByType))
	for itype, count := range onDemandByType {
		odList = append(odList, onDemandSummary{InstanceType: itype, Count: count})
	}
	sort.Slice(odList, func(i, j int) bool { return odList[i].Count > odList[j].Count })

	jGz(w, r, map[string]interface{}{
		"ready":           true,
		"region":          spotCache.region,
		"totalSpotNodes":  totalSpotNodes,
		"recommendations": recs,
		"consolidations":  consols,
		"totalEffectiveCpuM":  totalEffCpu,
		"totalEffectiveMemMi": totalEffMem,
		"lastRefresh":     spotCache.lastRefresh.Format(time.RFC3339),
		"clusterCost": map[string]interface{}{
			"totalNodes":            totalClusterNodes,
			"spotNodes":             totalSpotNodes,
			"onDemandNodes":         totalOnDemandNodes,
			"spotMonthlyCost":       math.Round(totalSpotMonthlyCost*100) / 100,
			"onDemandMonthlyCost":   math.Round(totalOnDemandMonthlyCost*100) / 100,
			"totalMonthlyCost":      math.Round((totalSpotMonthlyCost+totalOnDemandMonthlyCost)*100) / 100,
			"onDemandByType":        odList,
		},
	})
}

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
	name := strings.TrimPrefix(r.URL.Path, "/api/cronjobs/")
	ns := r.URL.Query().Get("namespace")
	if name == "" || ns == "" {
		http.Error(w, "need name and namespace", 400)
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
		http.Error(w, "cronjob not found", 404)
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

func main() {
	cfg, err := kubeConfig()
	if err != nil {
		log.Fatalf("kubeconfig: %v", err)
	}
	restCfg = cfg
	clientset, err = kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("clientset: %v", err)
	}
	metricsCl, _ = metricsv.NewForConfig(cfg)

	log.Println("warming cache...")
	startCacheLoop()
	log.Println("cache ready")

	startSpotAdvisorLoop()
	initLLM()
	initPrometheus()

	initAuth()

	mux := http.NewServeMux()

	mux.HandleFunc("/auth/login", authLogin)
	mux.HandleFunc("/auth/callback", authCallback)
	mux.HandleFunc("/auth/logout", authLogout)

	mux.HandleFunc("/api/me", apiMe)
	mux.HandleFunc("/api/overview", apiOverview)
	mux.HandleFunc("/api/nodes", apiNodes)
	mux.HandleFunc("/api/nodes/", apiNodeAction)
	mux.HandleFunc("/api/workloads", apiWorkloads)
	mux.HandleFunc("/api/workloads/", apiWorkloadAction)
	mux.HandleFunc("/api/search", apiSearch)
	mux.HandleFunc("/api/pods", apiPods)
	mux.HandleFunc("/api/pods/", apiPodDetail)
	mux.HandleFunc("/api/ingresses", apiIngresses)
	mux.HandleFunc("/api/ingresses/", apiIngressDescribe)
	mux.HandleFunc("/api/services", apiServices)
	mux.HandleFunc("/api/events", apiEvents)
	mux.HandleFunc("/api/hpa", apiHPA)
	mux.HandleFunc("/api/configs", apiConfigs)
	mux.HandleFunc("/api/configs/", apiConfigData)
	mux.HandleFunc("/api/exec", apiExec)
	mux.HandleFunc("/api/spot-advisor", apiSpotAdvisor)
	mux.HandleFunc("/api/topology-spread", apiTopologySpread)
	mux.HandleFunc("/api/metrics/node", apiMetricsNode)
	mux.HandleFunc("/api/metrics/pod", apiMetricsPod)
	mux.HandleFunc("/api/metrics/workload", apiMetricsWorkload)
	mux.HandleFunc("/api/pdbs", apiPDBs)
	mux.HandleFunc("/api/cronjobs/", apiCronJobHistory)
	mux.HandleFunc("/api/namespace-costs", apiNamespaceCosts)
	mux.HandleFunc("/api/workload-sizing", apiWorkloadSizing)
	mux.HandleFunc("/api/alerts", apiAlerts)
	mux.HandleFunc("/api/ai/diagnose", apiAIDiagnose)
	mux.HandleFunc("/api/ai/spot-analysis", apiAISpotAnalysis)
	mux.HandleFunc("/api/namespaces", apiNamespaces)
	mux.HandleFunc("/api/cluster-info", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]string{"name": clusterName})
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{"status":"ok"}`))
	})

	webRoot := "web/dist"
	if _, err := os.Stat(webRoot); err == nil {
		fs := http.FileServer(http.Dir(webRoot))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api") || strings.HasPrefix(r.URL.Path, "/auth") {
				http.NotFound(w, r)
				return
			}
			p := filepath.Join(webRoot, filepath.Clean(r.URL.Path))
			if fi, e := os.Stat(p); e == nil && !fi.IsDir() {
				if strings.HasPrefix(r.URL.Path, "/assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fs.ServeHTTP(w, r)
				return
			}
			// Real file not found: for asset paths return 404 (never serve HTML for JS/CSS)
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				http.NotFound(w, r)
				return
			}
			// SPA fallback — serve index.html for all other routes
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(webRoot, "index.html"))
		})
	}

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	log.Printf("k8s-dash listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, authMiddleware(corsWrap(mux))))
}

func kubeConfig() (*rest.Config, error) {
	if name := os.Getenv("CLUSTER_NAME"); name != "" {
		clusterName = name
	}
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		if clusterName == "" {
			clusterName = "in-cluster"
		}
		return rest.InClusterConfig()
	}
	kc := os.Getenv("KUBECONFIG")
	if kc == "" {
		kc = filepath.Join(os.Getenv("HOME"), ".kube", "config")
	}
	if clusterName == "" {
		if raw, err := clientcmd.NewDefaultClientConfigLoadingRules().Load(); err == nil {
			ctx := raw.CurrentContext
			if i := strings.LastIndex(ctx, "/"); i >= 0 {
				ctx = ctx[i+1:]
			}
			clusterName = ctx
		}
	}
	if clusterName == "" {
		clusterName = "unknown"
	}
	return clientcmd.BuildConfigFromFlags("", kc)
}


func corsWrap(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := corsOrigin
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			return
		}
		h.ServeHTTP(w, r)
	})
}

func j(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func jGz(w http.ResponseWriter, r *http.Request, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		json.NewEncoder(gz).Encode(v)
		return
	}
	json.NewEncoder(w).Encode(v)
}

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}

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

// ─── Nodes ───────────────────────────────────────────────────────────

func apiNodes(w http.ResponseWriter, r *http.Request) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.nodes == nil { http.Error(w, "cache not ready", 503); return }

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
		http.Error(w, "use /api/nodes/{name}/{describe|cordon|uncordon|drain}", 400)
		return
	}
	name, action := parts[0], parts[1]

	if action == "describe" {
		c, cancel := ctx()
		defer cancel()
		node, err := clientset.CoreV1().Nodes().Get(c, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
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

		// pods on this node
		podList, _ := clientset.CoreV1().Pods("").List(c, metav1.ListOptions{FieldSelector: "spec.nodeName=" + name})
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
					Status: string(p.Status.Phase),
					Ready:  fmt.Sprintf("%d/%d", readyCt, totalCt),
					Age:    shortDur(time.Since(p.CreationTimestamp.Time)),
				})
			}
		}

		usedCPU, usedMem := int64(0), int64(0)
		if metricsCl != nil {
			if nm, err := metricsCl.MetricsV1beta1().NodeMetricses().Get(c, name, metav1.GetOptions{}); err == nil {
				usedCPU = nm.Usage.Cpu().MilliValue()
				usedMem = nm.Usage.Memory().Value() / (1024 * 1024)
			}
		}
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
		evtList, _ := clientset.CoreV1().Events("").List(c, metav1.ListOptions{
			FieldSelector: "involvedObject.name=" + name + ",involvedObject.kind=Node",
		})
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
		})
		return
	}

	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	if !requireAdmin(w, r) { return }
	c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	switch action {
	case "cordon":
		err := patchUnschedulable(c, name, true)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		go cache.refresh()
		j(w, map[string]string{"ok": "cordoned"})
	case "uncordon":
		err := patchUnschedulable(c, name, false)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		go cache.refresh()
		j(w, map[string]string{"ok": "uncordoned"})
	case "drain":
		_ = patchUnschedulable(c, name, true)
		pods, err := clientset.CoreV1().Pods("").List(c, metav1.ListOptions{FieldSelector: "spec.nodeName=" + name})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		evicted := 0
		for _, p := range pods.Items {
			skip := false
			for _, ref := range p.OwnerReferences {
				if ref.Kind == "DaemonSet" {
					skip = true
				}
			}
			if skip {
				continue
			}
			ev := &policyv1.Eviction{
				ObjectMeta: metav1.ObjectMeta{Name: p.Name, Namespace: p.Namespace},
			}
			if err := clientset.CoreV1().Pods(p.Namespace).EvictV1(c, ev); err == nil {
				evicted++
			}
		}
		go cache.refresh()
		j(w, map[string]interface{}{"ok": "drained", "evicted": evicted})
	default:
		http.Error(w, "unknown action", 400)
	}
}

func patchUnschedulable(c context.Context, name string, val bool) error {
	patch := fmt.Sprintf(`{"spec":{"unschedulable":%t}}`, val)
	_, err := clientset.CoreV1().Nodes().Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
	return err
}

// ─── Workloads ───────────────────────────────────────────────────────

func apiWorkloads(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	type pdbStatus struct {
		Name               string `json:"name"`
		Status             string `json:"status"`
		DisruptionsAllowed int32  `json:"disruptionsAllowed"`
	}
	type wl struct {
		Kind      string      `json:"kind"`
		Name      string      `json:"name"`
		NS        string      `json:"namespace"`
		Ready     int32       `json:"ready"`
		Desired   int32       `json:"desired"`
		Age       string      `json:"age"`
		Images    string      `json:"images"`
		PDB       *pdbStatus  `json:"pdb,omitempty"`
		CpuReqM   int64       `json:"cpuReqM"`
		CpuLimM   int64       `json:"cpuLimM"`
		CpuUsedM  int64       `json:"cpuUsedM"`
		MemReqMi  int64       `json:"memReqMi"`
		MemLimMi  int64       `json:"memLimMi"`
		MemUsedMi int64       `json:"memUsedMi"`
	}

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

	sumPodUsage := func(namespace string, selector map[string]string) (int64, int64) {
		if cache.pods == nil || len(selector) == 0 { return 0, 0 }
		var cpuTotal, memTotal int64
		for _, p := range cache.pods.Items {
			if p.Namespace != namespace { continue }
			if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed { continue }
			match := true
			for k, v := range selector { if p.Labels[k] != v { match = false; break } }
			if !match { continue }
			usage := podMetricsMap[p.Namespace+"/"+p.Name]
			cpuTotal += usage[0]
			memTotal += usage[1]
		}
		return cpuTotal, memTotal
	}

	matchPDB := func(namespace string, podLabels map[string]string) *pdbStatus {
		if cache.pdbs == nil || len(podLabels) == 0 { return nil }
		for _, p := range cache.pdbs.Items {
			if p.Namespace != namespace { continue }
			if p.Spec.Selector == nil || len(p.Spec.Selector.MatchLabels) == 0 { continue }
			match := true
			for k, v := range p.Spec.Selector.MatchLabels {
				if podLabels[k] != v { match = false; break }
			}
			if !match { continue }
			status := "healthy"
			if p.Status.DisruptionsAllowed == 0 && p.Status.CurrentHealthy <= p.Status.DesiredHealthy {
				status = "blocking"
			} else if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
				status = "degraded"
			}
			return &pdbStatus{Name: p.Name, Status: status, DisruptionsAllowed: p.Status.DisruptionsAllowed}
		}
		return nil
	}

	var out []wl
	if cache.deployments != nil {
		for _, d := range cache.deployments.Items {
			if ns != "" && d.Namespace != ns { continue }
			desired := int32(1)
			if d.Spec.Replicas != nil { desired = *d.Spec.Replicas }
			imgs := []string{}
			var cpuReq, cpuLim, memReq, memLim int64
			for _, c := range d.Spec.Template.Spec.Containers {
				imgs = append(imgs, shortImage(c.Image))
				cpuReq += c.Resources.Requests.Cpu().MilliValue()
				cpuLim += c.Resources.Limits.Cpu().MilliValue()
				memReq += c.Resources.Requests.Memory().Value() / (1024 * 1024)
				memLim += c.Resources.Limits.Memory().Value() / (1024 * 1024)
			}
			cpuUsed, memUsed := sumPodUsage(d.Namespace, d.Spec.Selector.MatchLabels)
			entry := wl{Kind: "Deployment", Name: d.Name, NS: d.Namespace, Ready: d.Status.ReadyReplicas, Desired: desired, Age: shortDur(time.Since(d.CreationTimestamp.Time)), Images: strings.Join(imgs, ", "), CpuReqM: cpuReq, CpuLimM: cpuLim, CpuUsedM: cpuUsed, MemReqMi: memReq, MemLimMi: memLim, MemUsedMi: memUsed}
			entry.PDB = matchPDB(d.Namespace, d.Spec.Template.Labels)
			out = append(out, entry)
		}
	}
	if cache.statefulsets != nil {
		for _, s := range cache.statefulsets.Items {
			if ns != "" && s.Namespace != ns { continue }
			desired := int32(1)
			if s.Spec.Replicas != nil { desired = *s.Spec.Replicas }
			imgs := []string{}
			var cpuReq, cpuLim, memReq, memLim int64
			for _, c := range s.Spec.Template.Spec.Containers {
				imgs = append(imgs, shortImage(c.Image))
				cpuReq += c.Resources.Requests.Cpu().MilliValue()
				cpuLim += c.Resources.Limits.Cpu().MilliValue()
				memReq += c.Resources.Requests.Memory().Value() / (1024 * 1024)
				memLim += c.Resources.Limits.Memory().Value() / (1024 * 1024)
			}
			cpuUsed, memUsed := sumPodUsage(s.Namespace, s.Spec.Selector.MatchLabels)
			entry := wl{Kind: "StatefulSet", Name: s.Name, NS: s.Namespace, Ready: s.Status.ReadyReplicas, Desired: desired, Age: shortDur(time.Since(s.CreationTimestamp.Time)), Images: strings.Join(imgs, ", "), CpuReqM: cpuReq, CpuLimM: cpuLim, CpuUsedM: cpuUsed, MemReqMi: memReq, MemLimMi: memLim, MemUsedMi: memUsed}
			entry.PDB = matchPDB(s.Namespace, s.Spec.Template.Labels)
			out = append(out, entry)
		}
	}
	if cache.daemonsets != nil {
		for _, d := range cache.daemonsets.Items {
			if ns != "" && d.Namespace != ns { continue }
			imgs := []string{}
			var cpuReq, cpuLim, memReq, memLim int64
			for _, c := range d.Spec.Template.Spec.Containers {
				imgs = append(imgs, shortImage(c.Image))
				cpuReq += c.Resources.Requests.Cpu().MilliValue()
				cpuLim += c.Resources.Limits.Cpu().MilliValue()
				memReq += c.Resources.Requests.Memory().Value() / (1024 * 1024)
				memLim += c.Resources.Limits.Memory().Value() / (1024 * 1024)
			}
			cpuUsed, memUsed := sumPodUsage(d.Namespace, d.Spec.Selector.MatchLabels)
			entry := wl{Kind: "DaemonSet", Name: d.Name, NS: d.Namespace, Ready: d.Status.NumberReady, Desired: d.Status.DesiredNumberScheduled, Age: shortDur(time.Since(d.CreationTimestamp.Time)), Images: strings.Join(imgs, ", "), CpuReqM: cpuReq, CpuLimM: cpuLim, CpuUsedM: cpuUsed, MemReqMi: memReq, MemLimMi: memLim, MemUsedMi: memUsed}
			entry.PDB = matchPDB(d.Namespace, d.Spec.Template.Labels)
			out = append(out, entry)
		}
	}
	if cache.jobs != nil {
		for _, jb := range cache.jobs.Items {
			if ns != "" && jb.Namespace != ns { continue }
			imgs := []string{}
			for _, c := range jb.Spec.Template.Spec.Containers { imgs = append(imgs, shortImage(c.Image)) }
			desired := int32(1)
			if jb.Spec.Completions != nil { desired = *jb.Spec.Completions }
			out = append(out, wl{Kind: "Job", Name: jb.Name, NS: jb.Namespace, Ready: jb.Status.Succeeded, Desired: desired, Age: shortDur(time.Since(jb.CreationTimestamp.Time)), Images: strings.Join(imgs, ", ")})
		}
	}
	if cache.cronjobs != nil {
		for _, cj := range cache.cronjobs.Items {
			if ns != "" && cj.Namespace != ns { continue }
			imgs := []string{}
			for _, c := range cj.Spec.JobTemplate.Spec.Template.Spec.Containers { imgs = append(imgs, shortImage(c.Image)) }
			active := int32(len(cj.Status.Active))
			out = append(out, wl{Kind: "CronJob", Name: cj.Name, NS: cj.Namespace, Ready: active, Desired: 0, Age: shortDur(time.Since(cj.CreationTimestamp.Time)), Images: strings.Join(imgs, ", ")})
		}
	}
	jGz(w, r, out)
}

// /api/workloads/{ns}/{name}/restart or /api/workloads/{ns}/{name}/scale?replicas=N
func apiWorkloadAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/workloads/"), "/"), "/")
	if len(parts) != 3 {
		http.Error(w, "use /api/workloads/{ns}/{name}/{describe|restart|scale}", 400)
		return
	}
	ns, name, action := parts[0], parts[1], parts[2]
	c, cancel := ctx()
	defer cancel()

	if action == "describe" {
		kind := r.URL.Query().Get("kind")
		result := map[string]interface{}{"name": name, "namespace": ns, "kind": kind}

		switch kind {
		case "Deployment":
			d, err := clientset.AppsV1().Deployments(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { http.Error(w, err.Error(), 500); return }
			replicas := int32(1)
			if d.Spec.Replicas != nil { replicas = *d.Spec.Replicas }
			result["replicas"] = replicas
			result["readyReplicas"] = d.Status.ReadyReplicas
			result["updatedReplicas"] = d.Status.UpdatedReplicas
			result["availableReplicas"] = d.Status.AvailableReplicas
			result["strategy"] = string(d.Spec.Strategy.Type)
			result["selector"] = d.Spec.Selector.MatchLabels
			result["labels"] = d.Labels
			result["annotations"] = d.Annotations
			result["age"] = shortDur(time.Since(d.CreationTimestamp.Time))
			containers := []map[string]interface{}{}
			for _, ct := range d.Spec.Template.Spec.Containers {
				cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
				if ct.Resources.Requests != nil {
					cm["cpuReq"] = ct.Resources.Requests.Cpu().String()
					cm["memReq"] = ct.Resources.Requests.Memory().String()
				}
				if ct.Resources.Limits != nil {
					cm["cpuLim"] = ct.Resources.Limits.Cpu().String()
					cm["memLim"] = ct.Resources.Limits.Memory().String()
				}
				ports := []string{}
				for _, p := range ct.Ports { ports = append(ports, fmt.Sprintf("%d/%s", p.ContainerPort, p.Protocol)) }
				cm["ports"] = ports
				envCount := len(ct.Env) + len(ct.EnvFrom)
				cm["envCount"] = envCount
				containers = append(containers, cm)
			}
			result["containers"] = containers
			conds := []map[string]string{}
			for _, cnd := range d.Status.Conditions {
				conds = append(conds, map[string]string{"type": string(cnd.Type), "status": string(cnd.Status), "reason": cnd.Reason, "message": cnd.Message, "age": shortDur(time.Since(cnd.LastTransitionTime.Time))})
			}
			result["conditions"] = conds
			// Attach owned ReplicaSets
			cache.mu.RLock()
			type rsSummary struct {
				Name      string `json:"name"`
				Desired   int32  `json:"desired"`
				Ready     int32  `json:"ready"`
				Available int32  `json:"available"`
				Age       string `json:"age"`
				Revision  string `json:"revision"`
				Current   bool   `json:"current"`
			}
			var replicaSets []rsSummary
			if cache.replicasets != nil {
				for _, rs := range cache.replicasets.Items {
					if rs.Namespace != ns { continue }
					owned := false
					for _, ref := range rs.OwnerReferences {
						if ref.Kind == "Deployment" && ref.Name == name { owned = true; break }
					}
					if !owned { continue }
					desired := int32(0)
					if rs.Spec.Replicas != nil { desired = *rs.Spec.Replicas }
					rev := rs.Annotations["deployment.kubernetes.io/revision"]
					replicaSets = append(replicaSets, rsSummary{
						Name: rs.Name, Desired: desired, Ready: rs.Status.ReadyReplicas,
						Available: rs.Status.AvailableReplicas, Age: shortDur(time.Since(rs.CreationTimestamp.Time)),
						Revision: rev, Current: desired > 0,
					})
				}
			}
			cache.mu.RUnlock()
			sort.Slice(replicaSets, func(i, j int) bool { return replicaSets[i].Revision > replicaSets[j].Revision })
			if len(replicaSets) > 5 { replicaSets = replicaSets[:5] }
			result["replicaSets"] = replicaSets
		case "StatefulSet":
			s, err := clientset.AppsV1().StatefulSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { http.Error(w, err.Error(), 500); return }
			replicas := int32(1)
			if s.Spec.Replicas != nil { replicas = *s.Spec.Replicas }
			result["replicas"] = replicas
			result["readyReplicas"] = s.Status.ReadyReplicas
			result["selector"] = s.Spec.Selector.MatchLabels
			result["labels"] = s.Labels
			result["annotations"] = s.Annotations
			result["age"] = shortDur(time.Since(s.CreationTimestamp.Time))
			result["serviceName"] = s.Spec.ServiceName
			containers := []map[string]interface{}{}
			for _, ct := range s.Spec.Template.Spec.Containers {
				cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
				containers = append(containers, cm)
			}
			result["containers"] = containers
		case "DaemonSet":
			d, err := clientset.AppsV1().DaemonSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { http.Error(w, err.Error(), 500); return }
			result["desiredNumberScheduled"] = d.Status.DesiredNumberScheduled
			result["currentNumberScheduled"] = d.Status.CurrentNumberScheduled
			result["numberReady"] = d.Status.NumberReady
			result["selector"] = d.Spec.Selector.MatchLabels
			result["labels"] = d.Labels
			result["annotations"] = d.Annotations
			result["age"] = shortDur(time.Since(d.CreationTimestamp.Time))
			containers := []map[string]interface{}{}
			for _, ct := range d.Spec.Template.Spec.Containers {
				cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
				containers = append(containers, cm)
			}
			result["containers"] = containers
		case "CronJob":
			cj, err := clientset.BatchV1().CronJobs(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { http.Error(w, err.Error(), 500); return }
			result["schedule"] = cj.Spec.Schedule
			result["suspend"] = cj.Spec.Suspend != nil && *cj.Spec.Suspend
			result["activeJobs"] = len(cj.Status.Active)
			result["labels"] = cj.Labels
			result["annotations"] = cj.Annotations
			result["age"] = shortDur(time.Since(cj.CreationTimestamp.Time))
			if cj.Status.LastScheduleTime != nil { result["lastSchedule"] = shortDur(time.Since(cj.Status.LastScheduleTime.Time)) + " ago" }
			if cj.Status.LastSuccessfulTime != nil { result["lastSuccess"] = shortDur(time.Since(cj.Status.LastSuccessfulTime.Time)) + " ago" }
			containers := []map[string]interface{}{}
			for _, ct := range cj.Spec.JobTemplate.Spec.Template.Spec.Containers {
				cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
				containers = append(containers, cm)
			}
			result["containers"] = containers
			result["ownerKind"] = "CronJob"
			result["ownerName"] = name
		case "Job":
			jb, err := clientset.BatchV1().Jobs(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { http.Error(w, err.Error(), 500); return }
			result["completions"] = jb.Status.Succeeded
			result["active"] = jb.Status.Active
			result["failed"] = jb.Status.Failed
			if jb.Spec.Selector != nil { result["selector"] = jb.Spec.Selector.MatchLabels }
			result["labels"] = jb.Labels
			result["annotations"] = jb.Annotations
			result["age"] = shortDur(time.Since(jb.CreationTimestamp.Time))
			conds := []map[string]string{}
			for _, cnd := range jb.Status.Conditions {
				conds = append(conds, map[string]string{"type": string(cnd.Type), "status": string(cnd.Status), "reason": cnd.Reason, "message": cnd.Message})
			}
			result["conditions"] = conds
			containers := []map[string]interface{}{}
			for _, ct := range jb.Spec.Template.Spec.Containers {
				cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
				containers = append(containers, cm)
			}
			result["containers"] = containers
		case "ReplicaSet":
			rs, err := clientset.AppsV1().ReplicaSets(ns).Get(c, name, metav1.GetOptions{})
			if err != nil { http.Error(w, err.Error(), 500); return }
			replicas := int32(0)
			if rs.Spec.Replicas != nil { replicas = *rs.Spec.Replicas }
			result["replicas"] = replicas
			result["readyReplicas"] = rs.Status.ReadyReplicas
			result["availableReplicas"] = rs.Status.AvailableReplicas
			result["fullyLabeledReplicas"] = rs.Status.FullyLabeledReplicas
			if rs.Spec.Selector != nil { result["selector"] = rs.Spec.Selector.MatchLabels }
			result["labels"] = rs.Labels
			result["annotations"] = rs.Annotations
			result["age"] = shortDur(time.Since(rs.CreationTimestamp.Time))
			containers := []map[string]interface{}{}
			for _, ct := range rs.Spec.Template.Spec.Containers {
				cm := map[string]interface{}{"name": ct.Name, "image": ct.Image}
				if ct.Resources.Requests != nil {
					cm["cpuReq"] = ct.Resources.Requests.Cpu().String()
					cm["memReq"] = ct.Resources.Requests.Memory().String()
				}
				if ct.Resources.Limits != nil {
					cm["cpuLim"] = ct.Resources.Limits.Cpu().String()
					cm["memLim"] = ct.Resources.Limits.Memory().String()
				}
				ports := []string{}
				for _, p := range ct.Ports { ports = append(ports, fmt.Sprintf("%d/%s", p.ContainerPort, p.Protocol)) }
				cm["ports"] = ports
				containers = append(containers, cm)
			}
			result["containers"] = containers
			conds := []map[string]string{}
			for _, cnd := range rs.Status.Conditions {
				conds = append(conds, map[string]string{"type": string(cnd.Type), "status": string(cnd.Status), "reason": cnd.Reason, "message": cnd.Message})
			}
			result["conditions"] = conds
		default:
			http.Error(w, "unsupported kind", 400); return
		}

		// Fetch related events
		events, _ := clientset.CoreV1().Events(ns).List(c, metav1.ListOptions{})
		evts := []map[string]string{}
		if events != nil {
			for _, e := range events.Items {
				if e.InvolvedObject.Name != name { continue }
				ts := e.LastTimestamp.Time
				if ts.IsZero() { ts = e.CreationTimestamp.Time }
				evts = append(evts, map[string]string{"type": e.Type, "reason": e.Reason, "message": e.Message, "age": shortDur(time.Since(ts))})
			}
		}
		if len(evts) > 30 { evts = evts[len(evts)-30:] }
		result["events"] = evts

		// Collect pods matching this workload from cache
		cache.mu.RLock()
		type podSummary struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
			Status    string `json:"status"`
			Ready     string `json:"ready"`
			Restarts  int    `json:"restarts"`
			Age       string `json:"age"`
			Node      string `json:"node"`
		}
		pods := []podSummary{}
		sel, hasSel := result["selector"].(map[string]string)
		ownerKind, _ := result["ownerKind"].(string)
		ownerName, _ := result["ownerName"].(string)

		if cache.pods != nil {
			// For CronJobs, collect job names owned by this CronJob first
			cronJobNames := map[string]bool{}
			if ownerKind == "CronJob" && cache.jobs != nil {
				for _, jb := range cache.jobs.Items {
					for _, ref := range jb.OwnerReferences {
						if ref.Kind == "CronJob" && ref.Name == ownerName { cronJobNames[jb.Name] = true }
					}
				}
			}

			for _, p := range cache.pods.Items {
				if p.Namespace != ns { continue }

				matched := false
				if hasSel && len(sel) > 0 {
					matched = true
					for k, v := range sel {
						if p.Labels[k] != v { matched = false; break }
					}
				}
				if !matched && ownerKind == "CronJob" {
					for _, ref := range p.OwnerReferences {
						if ref.Kind == "Job" && cronJobNames[ref.Name] { matched = true; break }
					}
				}
				if !matched { continue }

				status := string(p.Status.Phase)
				for _, cs := range p.Status.ContainerStatuses {
					if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" { status = cs.State.Waiting.Reason; break }
					if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" { status = cs.State.Terminated.Reason }
				}
				readyCount, totalCount := 0, len(p.Status.ContainerStatuses)
				var restarts int32
				for _, cs := range p.Status.ContainerStatuses {
					if cs.Ready { readyCount++ }
					restarts += cs.RestartCount
				}
				pods = append(pods, podSummary{
					Name: p.Name, Namespace: p.Namespace, Status: status,
					Ready: fmt.Sprintf("%d/%d", readyCount, totalCount),
					Restarts: int(restarts), Age: shortDur(time.Since(p.CreationTimestamp.Time)), Node: p.Spec.NodeName,
				})
			}
		}
		cache.mu.RUnlock()
		sort.Slice(pods, func(i, j int) bool { return pods[i].Name < pods[j].Name })
		result["pods"] = pods

		jGz(w, r, result)
		return
	}

	if action == "dependencies" {
		kind := r.URL.Query().Get("kind")
		cache.mu.RLock()
		defer cache.mu.RUnlock()

		var podLabels map[string]string
		var podSpec *corev1.PodSpec
		switch kind {
		case "Deployment":
			if cache.deployments != nil {
				for _, d := range cache.deployments.Items {
					if d.Name == name && d.Namespace == ns {
						podLabels = d.Spec.Template.Labels
						podSpec = &d.Spec.Template.Spec
						break
					}
				}
			}
		case "StatefulSet":
			if cache.statefulsets != nil {
				for _, s := range cache.statefulsets.Items {
					if s.Name == name && s.Namespace == ns {
						podLabels = s.Spec.Template.Labels
						podSpec = &s.Spec.Template.Spec
						break
					}
				}
			}
		case "DaemonSet":
			if cache.daemonsets != nil {
				for _, d := range cache.daemonsets.Items {
					if d.Name == name && d.Namespace == ns {
						podLabels = d.Spec.Template.Labels
						podSpec = &d.Spec.Template.Spec
						break
					}
				}
			}
		}

		type svcDep struct {
			Name      string `json:"name"`
			Type      string `json:"type"`
			ClusterIP string `json:"clusterIP"`
			Ports     string `json:"ports"`
		}
		type ingDep struct {
			Name        string `json:"name"`
			Host        string `json:"host"`
			Path        string `json:"path"`
			TLS         bool   `json:"tls"`
			ServiceName string `json:"serviceName"`
		}
		type hpaDep struct {
			Name     string `json:"name"`
			Min      int32  `json:"minReplicas"`
			Max      int32  `json:"maxReplicas"`
			Current  int32  `json:"currentReplicas"`
			Desired  int32  `json:"desiredReplicas"`
			Metrics  string `json:"metrics"`
		}
		type cfgRef struct {
			Kind   string `json:"kind"`
			Name   string `json:"name"`
			Source string `json:"source"`
		}
		type pdbDep struct {
			Name               string `json:"name"`
			Status             string `json:"status"`
			DisruptionsAllowed int32  `json:"disruptionsAllowed"`
			MinAvailable       string `json:"minAvailable"`
			MaxUnavailable     string `json:"maxUnavailable"`
		}

		var svcs []svcDep
		var ings []ingDep
		var hpas []hpaDep
		var cfgs []cfgRef
		var pdb *pdbDep

		svcNames := map[string]bool{}
		if podLabels != nil && cache.services != nil {
			for _, s := range cache.services.Items {
				if s.Namespace != ns || len(s.Spec.Selector) == 0 { continue }
				match := true
				for k, v := range s.Spec.Selector {
					if podLabels[k] != v { match = false; break }
				}
				if !match { continue }
				ports := []string{}
				for _, p := range s.Spec.Ports {
					ports = append(ports, fmt.Sprintf("%d/%s", p.Port, p.Protocol))
				}
				svcs = append(svcs, svcDep{Name: s.Name, Type: string(s.Spec.Type), ClusterIP: s.Spec.ClusterIP, Ports: strings.Join(ports, ", ")})
				svcNames[s.Name] = true
			}
		}

		if len(svcNames) > 0 && cache.ingresses != nil {
			tlsHosts := map[string]bool{}
			for _, ing := range cache.ingresses.Items {
				if ing.Namespace != ns { continue }
				for _, t := range ing.Spec.TLS {
					for _, h := range t.Hosts { tlsHosts[h] = true }
				}
				for _, rule := range ing.Spec.Rules {
					if rule.HTTP == nil { continue }
					for _, p := range rule.HTTP.Paths {
						if p.Backend.Service != nil && svcNames[p.Backend.Service.Name] {
							path := "/"
							if p.Path != "" { path = p.Path }
							ings = append(ings, ingDep{Name: ing.Name, Host: rule.Host, Path: path, TLS: tlsHosts[rule.Host], ServiceName: p.Backend.Service.Name})
						}
					}
				}
			}
		}

		if cache.hpas != nil {
			for _, h := range cache.hpas.Items {
				if h.Namespace != ns { continue }
				if h.Spec.ScaleTargetRef.Kind != kind || h.Spec.ScaleTargetRef.Name != name { continue }
				metricStrs := []string{}
				for _, m := range h.Status.CurrentMetrics {
					switch m.Type {
					case autov2.ResourceMetricSourceType:
						if m.Resource != nil {
							if m.Resource.Current.AverageUtilization != nil {
							metricStrs = append(metricStrs, fmt.Sprintf("%s: %d%%", m.Resource.Name, *m.Resource.Current.AverageUtilization))
						}
						}
					}
				}
				min := int32(1)
				if h.Spec.MinReplicas != nil { min = *h.Spec.MinReplicas }
				hpas = append(hpas, hpaDep{Name: h.Name, Min: min, Max: h.Spec.MaxReplicas, Current: h.Status.CurrentReplicas, Desired: h.Status.DesiredReplicas, Metrics: strings.Join(metricStrs, ", ")})
			}
		}

		seen := map[string]bool{}
		if podSpec != nil {
			for _, v := range podSpec.Volumes {
				if v.ConfigMap != nil && !seen["cm:"+v.ConfigMap.Name] {
					cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: v.ConfigMap.Name, Source: "volume"})
					seen["cm:"+v.ConfigMap.Name] = true
				}
				if v.Secret != nil && !seen["sec:"+v.Secret.SecretName] {
					cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: v.Secret.SecretName, Source: "volume"})
					seen["sec:"+v.Secret.SecretName] = true
				}
				if v.Projected != nil {
					for _, src := range v.Projected.Sources {
						if src.ConfigMap != nil && !seen["cm:"+src.ConfigMap.Name] {
							cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: src.ConfigMap.Name, Source: "volume"})
							seen["cm:"+src.ConfigMap.Name] = true
						}
						if src.Secret != nil && !seen["sec:"+src.Secret.Name] {
							cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: src.Secret.Name, Source: "volume"})
							seen["sec:"+src.Secret.Name] = true
						}
					}
				}
			}
			for _, ct := range podSpec.Containers {
				for _, ef := range ct.EnvFrom {
					if ef.ConfigMapRef != nil && !seen["cm:"+ef.ConfigMapRef.Name] {
						cfgs = append(cfgs, cfgRef{Kind: "ConfigMap", Name: ef.ConfigMapRef.Name, Source: "envFrom"})
						seen["cm:"+ef.ConfigMapRef.Name] = true
					}
					if ef.SecretRef != nil && !seen["sec:"+ef.SecretRef.Name] {
						cfgs = append(cfgs, cfgRef{Kind: "Secret", Name: ef.SecretRef.Name, Source: "envFrom"})
						seen["sec:"+ef.SecretRef.Name] = true
					}
				}
			}
		}

		if podLabels != nil && cache.pdbs != nil {
			for _, p := range cache.pdbs.Items {
				if p.Namespace != ns || p.Spec.Selector == nil { continue }
				match := true
				for k, v := range p.Spec.Selector.MatchLabels {
					if podLabels[k] != v { match = false; break }
				}
				if !match { continue }
				status := "healthy"
				if p.Status.DisruptionsAllowed == 0 && p.Status.CurrentHealthy <= p.Status.DesiredHealthy {
					status = "blocking"
				} else if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
					status = "degraded"
				}
				dep := pdbDep{Name: p.Name, Status: status, DisruptionsAllowed: p.Status.DisruptionsAllowed}
				if p.Spec.MinAvailable != nil { dep.MinAvailable = p.Spec.MinAvailable.String() }
				if p.Spec.MaxUnavailable != nil { dep.MaxUnavailable = p.Spec.MaxUnavailable.String() }
				pdb = &dep
				break
			}
		}

		j(w, map[string]interface{}{
			"services":   svcs,
			"ingresses":  ings,
			"hpas":       hpas,
			"configRefs": cfgs,
			"pdb":        pdb,
		})
		return
	}

	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	if !requireAdmin(w, r) { return }

	switch action {
	case "restart":
		ts := time.Now().UTC().Format(time.RFC3339)
		patch := fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"%s"}}}}}`, ts)
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			_, e := clientset.AppsV1().Deployments(ns).Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
			return e
		})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		go cache.refresh()
		j(w, map[string]string{"ok": "restarting"})
	case "scale":
		replicaStr := r.URL.Query().Get("replicas")
		var replicas int32
		if _, err := fmt.Sscanf(replicaStr, "%d", &replicas); err != nil || replicas < 0 || replicas > 100 {
			http.Error(w, "replicas must be 0-100", 400)
			return
		}
		patch := fmt.Sprintf(`{"spec":{"replicas":%d}}`, replicas)
		_, err := clientset.AppsV1().Deployments(ns).Patch(c, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		go cache.refresh()
		j(w, map[string]interface{}{"ok": "scaled", "replicas": replicas})
	default:
		http.Error(w, "use restart or scale", 400)
	}
}

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

	type pd struct {
		Name       string `json:"name"`
		NS         string `json:"namespace"`
		Status     string `json:"status"`
		Restarts   int32  `json:"restarts"`
		Age        string `json:"age"`
		Node       string `json:"node"`
		Ready      string `json:"ready"`
		CpuReq     int64  `json:"cpuReqM"`
		CpuLim     int64  `json:"cpuLimM"`
		CpuUsed    int64  `json:"cpuUsedM"`
		MemReq     int64  `json:"memReqMi"`
		MemLim     int64  `json:"memLimMi"`
		MemUsed    int64  `json:"memUsedMi"`
		CpuSizing  string `json:"cpuSizing"`
		MemSizing  string `json:"memSizing"`
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
		if usage[0] > 0 && cpuReq > 0 {
			ratio := float64(usage[0]) / float64(cpuReq)
			if ratio > 0.9 { cpuSizing = "under" } else if ratio < 0.2 { cpuSizing = "over" } else { cpuSizing = "ok" }
		}
		if usage[1] > 0 && memReq > 0 {
			ratio := float64(usage[1]) / float64(memReq)
			if ratio > 0.9 { memSizing = "under" } else if ratio < 0.2 { memSizing = "over" } else { memSizing = "ok" }
		}
		out = append(out, pd{
			Name: p.Name, NS: p.Namespace, Status: podDisplayStatus(p),
			Restarts: restarts, Age: shortDur(time.Since(p.CreationTimestamp.Time)),
			Node: p.Spec.NodeName, Ready: fmt.Sprintf("%d/%d", readyCt, totalCt),
			CpuReq: cpuReq, CpuLim: cpuLim, CpuUsed: usage[0],
			MemReq: memReq, MemLim: memLim, MemUsed: usage[1],
			CpuSizing: cpuSizing, MemSizing: memSizing,
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
	case "describe":
		pod, err := clientset.CoreV1().Pods(ns).Get(c, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		type containerInfo struct {
			Name     string `json:"name"`
			Image    string `json:"image"`
			Ready    bool   `json:"ready"`
			State    string `json:"state"`
			Reason   string `json:"reason"`
			Message  string `json:"message"`
			Restarts int32  `json:"restarts"`
			Started  bool   `json:"started"`
			CpuReq   int64  `json:"cpuReqM"`
			CpuLim   int64  `json:"cpuLimM"`
			CpuUsed  int64  `json:"cpuUsedM"`
			MemReq   int64  `json:"memReqMi"`
			MemLim   int64  `json:"memLimMi"`
			MemUsed  int64  `json:"memUsedMi"`
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

		populateCI := func(ct corev1.Container, statusMap map[string]corev1.ContainerStatus) containerInfo {
			ci := containerInfo{
				Name:   ct.Name,
				Image:  shortImage(ct.Image),
				CpuReq: ct.Resources.Requests.Cpu().MilliValue(),
				CpuLim: ct.Resources.Limits.Cpu().MilliValue(),
				MemReq: ct.Resources.Requests.Memory().Value() / (1024 * 1024),
				MemLim: ct.Resources.Limits.Memory().Value() / (1024 * 1024),
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
				if ci.Reason == "" && cs.LastTerminationState.Terminated != nil {
					ci.Reason = "last: " + cs.LastTerminationState.Terminated.Reason
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
		j(w, map[string]interface{}{
			"name":           pod.Name,
			"namespace":      pod.Namespace,
			"node":           pod.Spec.NodeName,
			"status":         string(pod.Status.Phase),
			"ip":             pod.Status.PodIP,
			"qos":            string(pod.Status.QOSClass),
			"age":            shortDur(time.Since(pod.CreationTimestamp.Time)),
			"containers":     containers,
			"initContainers": initContainers,
			"conditions":     conditions,
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
		j(w, map[string]string{"ok": "deleted"})
	default:
		http.Error(w, "use /logs, /events, /describe, or /delete", 400)
	}
}

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
		http.Error(w, "use /api/ingresses/{namespace}/{name}", 400)
		return
	}
	ns, name := parts[0], parts[1]

	c, cancel := ctx()
	defer cancel()
	ing, err := clientset.NetworkingV1().Ingresses(ns).Get(c, name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), 500)
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

// ─── Events (cluster-wide recent) ───────────────────────────────────

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

// ─── Events (cluster-wide) ──────────────────────────────────────────

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

			// Single-domain or zero-domain: still report the constraint but mark as n/a
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

			// Only include domains where pods are actually placed
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

	// Sort: violations first, then at-limit, then satisfied
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

// ─── ConfigMaps & Secrets ──────────────────────────────────────────────

func apiConfigs(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	kind := r.URL.Query().Get("kind") // "configmap" or "secret"
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	type configItem struct {
		Kind         string   `json:"kind"`
		Name         string   `json:"name"`
		Namespace    string   `json:"namespace"`
		Keys         []string `json:"keys"`
		KeyCount     int      `json:"keyCount"`
		Type         string   `json:"type,omitempty"`
		Age          string   `json:"age"`
		LastModified string   `json:"lastModified"`
		ModifiedAgo  string   `json:"modifiedAgo"`
		RecentChange bool     `json:"recentChange"`
	}

	out := make([]configItem, 0)
	recentThreshold := 24 * time.Hour

	if kind == "" || kind == "configmap" {
		for _, cm := range cache.configMeta {
			if ns != "" && cm.Namespace != ns { continue }
			modAgo := time.Since(cm.LastModified)
			out = append(out, configItem{
				Kind: "ConfigMap", Name: cm.Name, Namespace: cm.Namespace,
				Keys: cm.Keys, KeyCount: len(cm.Keys),
				Age: shortDur(time.Since(cm.CreatedAt)),
				LastModified: cm.LastModified.Format(time.RFC3339),
				ModifiedAgo: shortDur(modAgo),
				RecentChange: modAgo < recentThreshold && cm.LastModified.After(cm.CreatedAt.Add(time.Minute)),
			})
		}
	}

	if kind == "" || kind == "secret" {
		for _, s := range cache.secretMeta {
			if ns != "" && s.Namespace != ns { continue }
			modAgo := time.Since(s.LastModified)
			out = append(out, configItem{
				Kind: "Secret", Name: s.Name, Namespace: s.Namespace,
				Keys: s.Keys, KeyCount: len(s.Keys), Type: s.Type,
				Age: shortDur(time.Since(s.CreatedAt)),
				LastModified: s.LastModified.Format(time.RFC3339),
				ModifiedAgo: shortDur(modAgo),
				RecentChange: modAgo < recentThreshold && s.LastModified.After(s.CreatedAt.Add(time.Minute)),
			})
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Namespace+out[i].Kind+out[i].Name < out[j].Namespace+out[j].Kind+out[j].Name })
	jGz(w, r, out)
}

// /api/configs/{ns}/{name}?kind=configmap|secret
func apiConfigData(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/configs/"), "/")
	if len(parts) != 2 {
		http.Error(w, "usage: /api/configs/{namespace}/{name}?kind=configmap|secret", 400)
		return
	}
	ns, name := parts[0], parts[1]
	kind := r.URL.Query().Get("kind")
	if kind == "" { kind = "configmap" }

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	isAdmin := false
	if authEnabled {
		sd, ok := r.Context().Value(userCtxKey).(*sessionData)
		isAdmin = ok && sd != nil && sd.Role == "admin"
	} else {
		isAdmin = true
	}

	type entry struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}

	entries := []entry{}

	if kind == "secret" {
		sec, err := clientset.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		keys := make([]string, 0, len(sec.Data)+len(sec.StringData))
		for k := range sec.Data { keys = append(keys, k) }
		for k := range sec.StringData { keys = append(keys, k) }
		sort.Strings(keys)
		for _, k := range keys {
			val := ""
			if isAdmin {
				if v, ok := sec.Data[k]; ok {
					val = string(v)
				} else if v, ok := sec.StringData[k]; ok {
					val = v
				}
			} else {
				val = "••••••••"
			}
			entries = append(entries, entry{Key: k, Value: val})
		}
	} else {
		cm, err := clientset.CoreV1().ConfigMaps(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		keys := make([]string, 0, len(cm.Data)+len(cm.BinaryData))
		for k := range cm.Data { keys = append(keys, k) }
		for k := range cm.BinaryData { keys = append(keys, k) }
		sort.Strings(keys)
		for _, k := range keys {
			val := ""
			if v, ok := cm.Data[k]; ok {
				val = v
			} else if v, ok := cm.BinaryData[k]; ok {
				val = fmt.Sprintf("<binary %d bytes>", len(v))
			}
			entries = append(entries, entry{Key: k, Value: val})
		}
	}

	jGz(w, r, map[string]interface{}{
		"kind":      kind,
		"name":      name,
		"namespace": ns,
		"entries":   entries,
		"masked":    kind == "secret" && !isAdmin,
	})
}

// ─── Pod Shell (WebSocket exec) ──────────────────────────────────────

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type wsTerminal struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (t *wsTerminal) Read(p []byte) (int, error) {
	_, msg, err := t.conn.ReadMessage()
	if err != nil {
		return 0, err
	}
	return copy(p, msg), nil
}

func (t *wsTerminal) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(p), t.conn.WriteMessage(websocket.TextMessage, p)
}

func apiExec(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) { return }

	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("pod")
	container := r.URL.Query().Get("container")
	if ns == "" || name == "" {
		http.Error(w, "namespace and pod required", 400)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(30 * time.Minute))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(30 * time.Minute))
		return nil
	})

	cmd := []string{"/bin/sh", "-c", "TERM=xterm exec sh"}

	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(name).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   cmd,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec)

	exec, err := remotecommand.NewSPDYExecutor(restCfg, "POST", req.URL())
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\nError: %v\r\n", err)))
		return
	}

	term := &wsTerminal{conn: conn}
	err = exec.StreamWithContext(context.Background(), remotecommand.StreamOptions{
		Stdin:  term,
		Stdout: term,
		Stderr: term,
		Tty:    true,
	})
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\nSession ended: %v\r\n", err)))
	}
}

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

// ─── Prometheus Metrics ──────────────────────────────────────────────

var promBaseURL string

func initPrometheus() {
	promURL := os.Getenv("PROMETHEUS_URL")
	if promURL == "" {
		log.Println("PROMETHEUS_URL not set — metrics graphs will be disabled")
		return
	}
	base := strings.TrimRight(promURL, "/")
	if strings.Contains(base, "grafana.net") {
		base += "/api/prom"
	}
	promBaseURL = base
	log.Printf("Prometheus configured: %s/api/v1/query_range", promBaseURL)
}

func promQuery(query, start, end, step string) ([]byte, error) {
	if promBaseURL == "" {
		return nil, fmt.Errorf("PROMETHEUS_URL not configured")
	}
	promUser := os.Getenv("PROMETHEUS_USER")
	promKey := os.Getenv("PROMETHEUS_KEY")

	u := promBaseURL + "/api/v1/query_range"
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("query", query)
	q.Set("start", start)
	q.Set("end", end)
	q.Set("step", step)
	req.URL.RawQuery = q.Encode()

	if promUser != "" && promKey != "" {
		req.SetBasicAuth(promUser, promKey)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		truncLen := len(body)
		if truncLen > 200 { truncLen = 200 }
		return nil, fmt.Errorf("prometheus returned %d: %s", resp.StatusCode, string(body[:truncLen]))
	}
	return body, nil
}

func promInstantQuery(query string) (float64, error) {
	if promBaseURL == "" {
		return 0, fmt.Errorf("PROMETHEUS_URL not configured")
	}
	promUser := os.Getenv("PROMETHEUS_USER")
	promKey := os.Getenv("PROMETHEUS_KEY")

	u := promBaseURL + "/api/v1/query"
	req, err := http.NewRequest("GET", u, nil)
	if err != nil { return 0, err }
	q := req.URL.Query()
	q.Set("query", query)
	q.Set("time", fmt.Sprintf("%d", time.Now().Unix()))
	req.URL.RawQuery = q.Encode()
	if promUser != "" && promKey != "" {
		req.SetBasicAuth(promUser, promKey)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil { return 0, err }
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil { return 0, err }
	if resp.StatusCode != 200 {
		truncLen := len(body)
		if truncLen > 200 { truncLen = 200 }
		return 0, fmt.Errorf("prometheus %d: %s", resp.StatusCode, string(body[:truncLen]))
	}
	var result struct {
		Data struct {
			Result []struct {
				Value []interface{} `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil { return 0, err }
	if len(result.Data.Result) == 0 { return 0, nil }
	valStr, ok := result.Data.Result[0].Value[1].(string)
	if !ok { return 0, nil }
	return strconv.ParseFloat(valStr, 64)
}

// ─── Workload Right-Sizing (Prometheus 7-day) ───────────────────────
func apiWorkloadSizing(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	nsName := r.URL.Query().Get("namespace")
	wlName := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	if nsName == "" || wlName == "" {
		http.Error(w, "need namespace and name", 400)
		return
	}

	cache.mu.RLock()
	var cpuReqM, cpuLimM, memReqMi, memLimMi int64
	var podRegex string
	switch kind {
	case "Deployment":
		if cache.deployments != nil {
			for _, d := range cache.deployments.Items {
				if d.Name == wlName && d.Namespace == nsName {
					for _, ct := range d.Spec.Template.Spec.Containers {
						cpuReqM += ct.Resources.Requests.Cpu().MilliValue()
						cpuLimM += ct.Resources.Limits.Cpu().MilliValue()
						memReqMi += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
						memLimMi += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
					}
					podRegex = wlName + "-[a-z0-9]+-[a-z0-9]+"
					break
				}
			}
		}
	case "StatefulSet":
		if cache.statefulsets != nil {
			for _, s := range cache.statefulsets.Items {
				if s.Name == wlName && s.Namespace == nsName {
					for _, ct := range s.Spec.Template.Spec.Containers {
						cpuReqM += ct.Resources.Requests.Cpu().MilliValue()
						cpuLimM += ct.Resources.Limits.Cpu().MilliValue()
						memReqMi += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
						memLimMi += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
					}
					podRegex = wlName + "-[0-9]+"
					break
				}
			}
		}
	case "DaemonSet":
		if cache.daemonsets != nil {
			for _, d := range cache.daemonsets.Items {
				if d.Name == wlName && d.Namespace == nsName {
					for _, ct := range d.Spec.Template.Spec.Containers {
						cpuReqM += ct.Resources.Requests.Cpu().MilliValue()
						cpuLimM += ct.Resources.Limits.Cpu().MilliValue()
						memReqMi += ct.Resources.Requests.Memory().Value() / (1024 * 1024)
						memLimMi += ct.Resources.Limits.Memory().Value() / (1024 * 1024)
					}
					podRegex = wlName + "-[a-z0-9]+"
					break
				}
			}
		}
	}
	cache.mu.RUnlock()

	if podRegex == "" {
		http.Error(w, "workload not found", 404)
		return
	}

	podFilter := fmt.Sprintf(`namespace="%s",pod=~"%s",container!=""`, nsName, podRegex)
	type promResult struct {
		key string
		val float64
		err error
	}
	ch := make(chan promResult, 4)
	queries := map[string]string{
		"cpuAvg":  fmt.Sprintf(`avg_over_time(sum(rate(container_cpu_usage_seconds_total{%s}[5m]))[7d:5m])`, podFilter),
		"cpuMax":  fmt.Sprintf(`max_over_time(sum(rate(container_cpu_usage_seconds_total{%s}[5m]))[7d:5m])`, podFilter),
		"memAvg":  fmt.Sprintf(`avg_over_time(sum(container_memory_working_set_bytes{%s})[7d:5m])`, podFilter),
		"memMax":  fmt.Sprintf(`max_over_time(sum(container_memory_working_set_bytes{%s})[7d:5m])`, podFilter),
	}
	for k, q := range queries {
		go func(key, query string) {
			val, err := promInstantQuery(query)
			ch <- promResult{key, val, err}
		}(k, q)
	}
	vals := map[string]float64{}
	for i := 0; i < 4; i++ {
		r := <-ch
		if r.err != nil {
			log.Printf("sizing query %s failed: %v", r.key, r.err)
		}
		vals[r.key] = r.val
	}

	cpuAvgM := int64(vals["cpuAvg"] * 1000)
	cpuMaxM := int64(vals["cpuMax"] * 1000)
	memAvgMi := int64(vals["memAvg"] / (1024 * 1024))
	memMaxMi := int64(vals["memMax"] / (1024 * 1024))

	round10 := func(v int64) int64 { return ((v + 9) / 10) * 10 }
	roundMi := func(v int64) int64 {
		if v < 128 { return ((v + 7) / 8) * 8 }
		return ((v + 31) / 32) * 32
	}

	recCpuReq := round10(cpuAvgM * 120 / 100)
	recCpuLim := round10(cpuMaxM * 130 / 100)
	recMemReq := roundMi(memAvgMi * 120 / 100)
	recMemLim := roundMi(memMaxMi * 120 / 100)

	if recCpuReq < 10 { recCpuReq = 10 }
	if recCpuLim < recCpuReq { recCpuLim = recCpuReq }
	if recMemReq < 32 { recMemReq = 32 }
	if recMemLim < recMemReq { recMemLim = recMemReq }

	sizing := "ok"
	if cpuReqM > 0 && recCpuReq < cpuReqM*50/100 {
		sizing = "over"
	} else if cpuReqM > 0 && recCpuReq > cpuReqM {
		sizing = "under"
	}
	if memReqMi > 0 && recMemReq < memReqMi*50/100 {
		sizing = "over"
	} else if memReqMi > 0 && recMemReq > memReqMi {
		sizing = "under"
	}

	j(w, map[string]interface{}{
		"current": map[string]int64{"cpuReqM": cpuReqM, "cpuLimM": cpuLimM, "memReqMi": memReqMi, "memLimMi": memLimMi},
		"observed": map[string]int64{"cpuAvgM": cpuAvgM, "cpuMaxM": cpuMaxM, "memAvgMi": memAvgMi, "memMaxMi": memMaxMi},
		"recommended": map[string]int64{"cpuReqM": recCpuReq, "cpuLimM": recCpuLim, "memReqMi": recMemReq, "memLimMi": recMemLim},
		"sizing": sizing,
		"source": "prometheus-7d-avg",
	})
}

// ─── Firing Alerts (Prometheus) ──────────────────────────────────────
func apiAlerts(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": "Prometheus not configured"})
		return
	}
	promUser := os.Getenv("PROMETHEUS_USER")
	promKey := os.Getenv("PROMETHEUS_KEY")

	u := promBaseURL + "/api/v1/alerts"
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": err.Error()})
		return
	}
	if promUser != "" && promKey != "" {
		req.SetBasicAuth(promUser, promKey)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if resp.StatusCode != 200 {
		j(w, map[string]interface{}{"alerts": []interface{}{}, "error": fmt.Sprintf("prometheus %d", resp.StatusCode)})
		return
	}

	var result struct {
		Data struct {
			Alerts []struct {
				Labels      map[string]string `json:"labels"`
				Annotations map[string]string `json:"annotations"`
				State       string            `json:"state"`
				ActiveAt    string            `json:"activeAt"`
			} `json:"alerts"`
		} `json:"data"`
	}
	json.Unmarshal(body, &result)

	type alertOut struct {
		Name        string `json:"name"`
		Severity    string `json:"severity"`
		State       string `json:"state"`
		Namespace   string `json:"namespace,omitempty"`
		Pod         string `json:"pod,omitempty"`
		Node        string `json:"node,omitempty"`
		Service     string `json:"service,omitempty"`
		Summary     string `json:"summary"`
		Description string `json:"description"`
		ActiveSince string `json:"activeSince"`
	}

	alerts := make([]alertOut, 0)
	for _, a := range result.Data.Alerts {
		if a.State != "firing" { continue }
		sev := a.Labels["severity"]
		if sev == "" { sev = "warning" }
		since := a.ActiveAt
		if t, err := time.Parse(time.RFC3339, a.ActiveAt); err == nil {
			since = shortDur(time.Since(t))
		}
		alerts = append(alerts, alertOut{
			Name: a.Labels["alertname"], Severity: sev, State: a.State,
			Namespace: a.Labels["namespace"], Pod: a.Labels["pod"],
			Node: a.Labels["node"], Service: a.Labels["service"],
			Summary: a.Annotations["summary"], Description: a.Annotations["description"],
			ActiveSince: since,
		})
	}
	sort.Slice(alerts, func(i, k int) bool {
		sevOrder := map[string]int{"critical": 0, "warning": 1, "info": 2}
		si, sk := sevOrder[alerts[i].Severity], sevOrder[alerts[k].Severity]
		if si != sk { return si < sk }
		return alerts[i].Name < alerts[k].Name
	})
	j(w, map[string]interface{}{"alerts": alerts})
}


func apiMetricsNode(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	node := r.URL.Query().Get("node")
	rangeStr := r.URL.Query().Get("range")
	if node == "" {
		http.Error(w, `{"error":"node parameter required"}`, 400)
		return
	}
	if rangeStr == "" {
		rangeStr = "1h"
	}

	dur, _ := time.ParseDuration(rangeStr)
	if dur == 0 {
		dur = time.Hour
	}
	end := time.Now()
	start := end.Add(-dur)
	step := "60s"
	rateWin := "5m"
	if dur > 12*time.Hour {
		step = "600s"
		rateWin = "15m"
	} else if dur > 6*time.Hour {
		step = "300s"
		rateWin = "10m"
	} else if dur > time.Hour {
		step = "120s"
		rateWin = "5m"
	}
	startStr := fmt.Sprintf("%d", start.Unix())
	endStr := fmt.Sprintf("%d", end.Unix())

	nodeInstance := ""
	cache.mu.RLock()
	if cache.nodes != nil {
		for _, n := range cache.nodes.Items {
			if n.Name == node {
				for _, addr := range n.Status.Addresses {
					if addr.Type == corev1.NodeInternalIP {
						nodeInstance = addr.Address
						break
					}
				}
				break
			}
		}
	}
	cache.mu.RUnlock()

	queries := map[string]string{
		"rr_cpu_used":    fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{node=~"%s"})`, node),
		"cpu_capacity":   fmt.Sprintf(`sum(kube_node_status_capacity{node=~"%s", resource="cpu"})`, node),
		"rr_cpu_requests": fmt.Sprintf(`sum(cluster:namespace:pod_cpu:active:kube_pod_container_resource_requests{node=~"%s"})`, node),
		"rr_cpu_limits":  fmt.Sprintf(`sum(cluster:namespace:pod_cpu:active:kube_pod_container_resource_limits{node=~"%s"})`, node),

		"rr_mem_used":     fmt.Sprintf(`sum(node_namespace_pod_container:container_memory_working_set_bytes{node=~"%s", container!=""})`, node),
		"mem_capacity":    fmt.Sprintf(`sum(kube_node_status_capacity{node=~"%s", resource="memory"})`, node),
		"rr_mem_requests": fmt.Sprintf(`sum(cluster:namespace:pod_memory:active:kube_pod_container_resource_requests{node=~"%s"})`, node),
		"rr_mem_limits":   fmt.Sprintf(`sum(cluster:namespace:pod_memory:active:kube_pod_container_resource_limits{node=~"%s"})`, node),
		"rr_mem_rss":      fmt.Sprintf(`sum(node_namespace_pod_container:container_memory_rss{node=~"%s", container!=""})`, node),
		"rr_mem_cache":    fmt.Sprintf(`sum(node_namespace_pod_container:container_memory_cache{node=~"%s", container!=""})`, node),

		"cpu":    fmt.Sprintf(`100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle",instance=~"%s:.*"}[%s])) * 100)`, nodeInstance, rateWin),
		"memory": fmt.Sprintf(`(1 - node_memory_MemAvailable_bytes{instance=~"%s:.*"} / node_memory_MemTotal_bytes{instance=~"%s:.*"}) * 100`, nodeInstance, nodeInstance),
		"fs_used": fmt.Sprintf(`(1 - node_filesystem_avail_bytes{instance=~"%s:.*",mountpoint="/",fstype!="tmpfs"} / node_filesystem_size_bytes{instance=~"%s:.*",mountpoint="/",fstype!="tmpfs"}) * 100`, nodeInstance, nodeInstance),
	}

	jGz(w, r, promQueryParallel(queries, startStr, endStr, step))
}

func apiMetricsPod(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	ns := r.URL.Query().Get("namespace")
	pod := r.URL.Query().Get("pod")
	rangeStr := r.URL.Query().Get("range")
	if ns == "" || pod == "" {
		http.Error(w, `{"error":"namespace and pod parameters required"}`, 400)
		return
	}
	if rangeStr == "" {
		rangeStr = "1h"
	}

	dur, _ := time.ParseDuration(rangeStr)
	if dur == 0 {
		dur = time.Hour
	}
	end := time.Now()
	start := end.Add(-dur)
	step := "60s"
	rw := "5m"
	if dur > 12*time.Hour {
		step = "600s"
		rw = "15m"
	} else if dur > 6*time.Hour {
		step = "300s"
		rw = "10m"
	} else if dur > time.Hour {
		step = "120s"
		rw = "5m"
	}
	startStr := fmt.Sprintf("%d", start.Unix())
	endStr := fmt.Sprintf("%d", end.Unix())

	queries := map[string]string{
		"cpu":      fmt.Sprintf(`sum by(container)(rate(container_cpu_usage_seconds_total{namespace="%s",pod="%s",container!="",container!="POD"}[%s])) * 1000`, ns, pod, rw),
		"memory":   fmt.Sprintf(`sum by(container)(container_memory_working_set_bytes{namespace="%s",pod="%s",container!="",container!="POD"}) / (1024*1024)`, ns, pod),
		"net_rx":   fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{namespace="%s",pod="%s"}[%s]))`, ns, pod, rw),
		"net_tx":   fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{namespace="%s",pod="%s"}[%s]))`, ns, pod, rw),
		"throttle": fmt.Sprintf(`sum by(container)(rate(container_cpu_cfs_throttled_periods_total{namespace="%s",pod="%s",container!="",container!="POD"}[%s])) / sum by(container)(rate(container_cpu_cfs_periods_total{namespace="%s",pod="%s",container!="",container!="POD"}[%s])) * 100`, ns, pod, rw, ns, pod, rw),
		"restarts": fmt.Sprintf(`kube_pod_container_status_restarts_total{namespace="%s",pod="%s"}`, ns, pod),

		// K8s mixin recording rules (Grafana Cloud)
		"rr_cpu":    fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s",pod="%s",container!=""}) * 1000`, ns, pod),
		"rr_memory": fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_memory_working_set_bytes{namespace="%s",pod="%s",container!=""}) / (1024*1024)`, ns, pod),
		"rr_rss":    fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_memory_rss{namespace="%s",pod="%s",container!=""}) / (1024*1024)`, ns, pod),
		"rr_cache":  fmt.Sprintf(`sum by(container)(node_namespace_pod_container:container_memory_cache{namespace="%s",pod="%s",container!=""}) / (1024*1024)`, ns, pod),
	}

	metrics := promQueryParallel(queries, startStr, endStr, step)

	// Attach resource requests/limits from cached pod spec
	type containerResources struct {
		Container string  `json:"container"`
		CpuReq    float64 `json:"cpuReqM"`
		CpuLim    float64 `json:"cpuLimM"`
		MemReq    float64 `json:"memReqMi"`
		MemLim    float64 `json:"memLimMi"`
	}
	var resources []containerResources

	cache.mu.RLock()
	if cache.pods != nil {
		for i := range cache.pods.Items {
			p := &cache.pods.Items[i]
			if p.Namespace == ns && p.Name == pod {
				for _, c := range p.Spec.Containers {
					cr := containerResources{Container: c.Name}
					if c.Resources.Requests != nil {
						if v, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
							cr.CpuReq = float64(v.MilliValue())
						}
						if v, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
							cr.MemReq = float64(v.Value()) / (1024 * 1024)
						}
					}
					if c.Resources.Limits != nil {
						if v, ok := c.Resources.Limits[corev1.ResourceCPU]; ok {
							cr.CpuLim = float64(v.MilliValue())
						}
						if v, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
							cr.MemLim = float64(v.Value()) / (1024 * 1024)
						}
					}
					resources = append(resources, cr)
				}
				break
			}
		}
	}
	cache.mu.RUnlock()

	resp := map[string]interface{}{}
	for k, v := range metrics {
		resp[k] = v
	}
	if resources != nil {
		resp["resources"] = resources
	}

	jGz(w, r, resp)
}

func apiMetricsWorkload(w http.ResponseWriter, r *http.Request) {
	if promBaseURL == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"Prometheus not configured"}`))
		return
	}
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	rangeStr := r.URL.Query().Get("range")
	if ns == "" || name == "" {
		http.Error(w, `{"error":"namespace and name parameters required"}`, 400)
		return
	}
	if kind == "" {
		kind = "deployment"
	}
	if rangeStr == "" {
		rangeStr = "1h"
	}

	dur, _ := time.ParseDuration(rangeStr)
	if dur == 0 {
		dur = time.Hour
	}
	end := time.Now()
	start := end.Add(-dur)
	step := "60s"
	rateWindow := "5m"
	if dur > 12*time.Hour {
		step = "600s"
		rateWindow = "15m"
	} else if dur > 6*time.Hour {
		step = "300s"
		rateWindow = "10m"
	} else if dur > time.Hour {
		step = "120s"
		rateWindow = "5m"
	}
	startStr := fmt.Sprintf("%d", start.Unix())
	endStr := fmt.Sprintf("%d", end.Unix())

	kindLower := strings.ToLower(kind)

	ownerJoin := fmt.Sprintf(`namespace_workload_pod:kube_pod_owner:relabel{namespace="%s", workload="%s", workload_type="%s"}`, ns, name, kindLower)

	var podMatcher string
	switch kindLower {
	case "statefulset":
		podMatcher = fmt.Sprintf("%s-[0-9]+", name)
	default:
		podMatcher = fmt.Sprintf("%s-[a-z0-9]+-[a-z0-9]+", name)
	}

	queries := map[string]string{
		// Recording-rule based (Grafana Cloud) — aggregated totals
		"rr_cpu_total": fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s"} * on(namespace,pod) group_left(workload, workload_type) %s) * 1000`, ns, ownerJoin),
		"rr_mem_total": fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s", container!="", image!=""} * on(namespace,pod) group_left(workload, workload_type) %s) / (1024*1024)`, ns, ownerJoin),

		// Recording-rule based — per-pod breakdown
		"rr_cpu_per_pod": fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_mem_per_pod": fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s", container!="", image!=""} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),

		"rr_cpu_req_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_requests{namespace="%s", resource="cpu"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_cpu_lim_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_limits{namespace="%s", resource="cpu"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_cpu_req_pct": fmt.Sprintf(`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="%s"} * on(namespace,pod) group_left(workload, workload_type) %s) / sum(kube_pod_container_resource_requests{namespace="%s", resource="cpu"} * on(namespace,pod) group_left(workload, workload_type) %s)`, ns, ownerJoin, ns, ownerJoin),
		"rr_mem_req_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_requests{namespace="%s", resource="memory"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),
		"rr_mem_lim_per_pod": fmt.Sprintf(`sum(kube_pod_container_resource_limits{namespace="%s", resource="memory"} * on(namespace,pod) group_left(workload, workload_type) %s) by (pod)`, ns, ownerJoin),

		// Raw cadvisor fallback — aggregated totals
		"cpu_total":    fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) * 1000`, ns, podMatcher, rateWindow),
		"mem_total":    fmt.Sprintf(`sum(container_memory_working_set_bytes{namespace="%s",pod=~"%s",container!="",container!="POD"}) / (1024*1024)`, ns, podMatcher),

		// Raw cadvisor fallback — per-pod
		"cpu_per_pod":  fmt.Sprintf(`sum by(pod)(rate(container_cpu_usage_seconds_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) * 1000`, ns, podMatcher, rateWindow),
		"mem_per_pod":  fmt.Sprintf(`sum by(pod)(container_memory_working_set_bytes{namespace="%s",pod=~"%s",container!="",container!="POD"}) / (1024*1024)`, ns, podMatcher),

		"throttle":     fmt.Sprintf(`sum(rate(container_cpu_cfs_throttled_periods_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) / sum(rate(container_cpu_cfs_periods_total{namespace="%s",pod=~"%s",container!="",container!="POD"}[%s])) * 100`, ns, podMatcher, rateWindow, ns, podMatcher, rateWindow),

		// ── kube-state-metrics (work in both envs) ──
		"restarts":       fmt.Sprintf(`sum by(pod)(kube_pod_container_status_restarts_total{namespace="%s",pod=~"%s"})`, ns, podMatcher),
		"pods_running":   fmt.Sprintf(`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Running"} == 1)`, ns, podMatcher),
		"pods_pending":   fmt.Sprintf(`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Pending"} == 1)`, ns, podMatcher),
		"pods_failed":    fmt.Sprintf(`count(kube_pod_status_phase{namespace="%s",pod=~"%s",phase="Failed"} == 1)`, ns, podMatcher),
		"containers_ready":     fmt.Sprintf(`sum(kube_pod_container_status_ready{namespace="%s",pod=~"%s"})`, ns, podMatcher),
		"containers_not_ready": fmt.Sprintf(`sum(kube_pod_container_status_ready{namespace="%s",pod=~"%s"} == 0)`, ns, podMatcher),
	}

	// Deployment-specific kube-state-metrics
	if kindLower == "deployment" {
		queries["replicas"] = fmt.Sprintf(`kube_deployment_status_replicas{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_avl"] = fmt.Sprintf(`kube_deployment_status_replicas_available{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_updated"] = fmt.Sprintf(`kube_deployment_status_replicas_updated{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_unavail"] = fmt.Sprintf(`kube_deployment_status_replicas_unavailable{namespace="%s",deployment="%s"}`, ns, name)
		queries["replicas_desired"] = fmt.Sprintf(`kube_deployment_spec_replicas{namespace="%s",deployment="%s"}`, ns, name)
		queries["generation_observed"] = fmt.Sprintf(`kube_deployment_status_observed_generation{namespace="%s",deployment="%s"}`, ns, name)
		queries["generation_meta"] = fmt.Sprintf(`kube_deployment_metadata_generation{namespace="%s",deployment="%s"}`, ns, name)
	} else if kindLower == "statefulset" {
		queries["replicas"] = fmt.Sprintf(`kube_statefulset_status_replicas{namespace="%s",statefulset="%s"}`, ns, name)
		queries["replicas_avl"] = fmt.Sprintf(`kube_statefulset_status_replicas_ready{namespace="%s",statefulset="%s"}`, ns, name)
		queries["replicas_updated"] = fmt.Sprintf(`kube_statefulset_status_replicas_updated{namespace="%s",statefulset="%s"}`, ns, name)
		queries["replicas_desired"] = fmt.Sprintf(`kube_statefulset_replicas{namespace="%s",statefulset="%s"}`, ns, name)
	} else if kindLower == "daemonset" {
		queries["ds_desired"] = fmt.Sprintf(`kube_daemonset_status_desired_number_scheduled{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_ready"] = fmt.Sprintf(`kube_daemonset_status_number_ready{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_available"] = fmt.Sprintf(`kube_daemonset_status_number_available{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_misscheduled"] = fmt.Sprintf(`kube_daemonset_status_number_misscheduled{namespace="%s",daemonset="%s"}`, ns, name)
		queries["ds_unavailable"] = fmt.Sprintf(`kube_daemonset_status_number_unavailable{namespace="%s",daemonset="%s"}`, ns, name)
	}

	metrics := promQueryParallel(queries, startStr, endStr, step)

	// Attach aggregate resource requests/limits
	type wlResources struct {
		Replicas int     `json:"replicas"`
		CpuReqM  float64 `json:"cpuReqM"`
		CpuLimM  float64 `json:"cpuLimM"`
		MemReqMi float64 `json:"memReqMi"`
		MemLimMi float64 `json:"memLimMi"`
	}
	var res wlResources

	cache.mu.RLock()
	if cache.pods != nil {
		re := regexp.MustCompile("^" + podMatcher + "$")
		for i := range cache.pods.Items {
			p := &cache.pods.Items[i]
			if p.Namespace != ns || !re.MatchString(p.Name) { continue }
			if p.Status.Phase != corev1.PodRunning && p.Status.Phase != corev1.PodPending { continue }
			res.Replicas++
			for _, c := range p.Spec.Containers {
				if c.Resources.Requests != nil {
					if v, ok := c.Resources.Requests[corev1.ResourceCPU]; ok { res.CpuReqM += float64(v.MilliValue()) }
					if v, ok := c.Resources.Requests[corev1.ResourceMemory]; ok { res.MemReqMi += float64(v.Value()) / (1024 * 1024) }
				}
				if c.Resources.Limits != nil {
					if v, ok := c.Resources.Limits[corev1.ResourceCPU]; ok { res.CpuLimM += float64(v.MilliValue()) }
					if v, ok := c.Resources.Limits[corev1.ResourceMemory]; ok { res.MemLimMi += float64(v.Value()) / (1024 * 1024) }
				}
			}
		}
	}
	cache.mu.RUnlock()

	resp := map[string]interface{}{}
	for k, v := range metrics {
		resp[k] = v
	}
	resp["resources"] = res

	jGz(w, r, resp)
}

type promMetricSeries struct {
	Name   string      `json:"name"`
	Values [][2]float64 `json:"values"`
}

func promQueryParallel(queries map[string]string, startStr, endStr, step string) map[string][]promMetricSeries {
	type queryResult struct {
		name   string
		series []promMetricSeries
	}

	ch := make(chan queryResult, len(queries))
	for name, query := range queries {
		go func(n, q string) {
			raw, err := promQuery(q, startStr, endStr, step)
			if err != nil {
				log.Printf("prom query %s failed: %v", n, err)
				ch <- queryResult{name: n}
				return
			}
			var promResp struct {
				Data struct {
					Result []struct {
						Metric map[string]string `json:"metric"`
						Values [][]interface{}   `json:"values"`
					} `json:"result"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &promResp); err != nil {
				ch <- queryResult{name: n}
				return
			}
			series := make([]promMetricSeries, 0, len(promResp.Data.Result))
			for _, r := range promResp.Data.Result {
				label := n
				if v, ok := r.Metric["pod"]; ok { label = v } else if v, ok := r.Metric["container"]; ok { label = v } else if v, ok := r.Metric["device"]; ok { label = v }
				vals := make([][2]float64, 0, len(r.Values))
				for _, v := range r.Values {
					ts, _ := v[0].(float64)
					val := float64(0)
					if s, ok := v[1].(string); ok {
						val, _ = strconv.ParseFloat(s, 64)
					}
					vals = append(vals, [2]float64{ts, val})
				}
				series = append(series, promMetricSeries{Name: label, Values: vals})
			}
			ch <- queryResult{name: n, series: series}
		}(name, query)
	}

	result := map[string][]promMetricSeries{}
	for i := 0; i < len(queries); i++ {
		qr := <-ch
		if qr.series != nil {
			result[qr.name] = qr.series
		}
	}
	return result
}

// ─── AI (LLM Gateway) ───────────────────────────────────────────────

var (
	llmGatewayURL   string
	llmGatewayKey   string
	llmGatewayModel string
	aiEnabled       bool
	aiRateMu        sync.Mutex
	aiCallTimes     []time.Time
	aiConcurrent    int32
)

const (
	aiMaxCallsPerMin = 10
	aiMaxConcurrent  = 2
)

func initLLM() {
	llmGatewayURL = os.Getenv("LLM_GATEWAY_URL")
	llmGatewayKey = os.Getenv("LLM_GATEWAY_KEY")
	llmGatewayModel = os.Getenv("LLM_GATEWAY_MODEL")
	if llmGatewayURL == "" {
		log.Println("ai: LLM_GATEWAY_URL not set — AI features disabled")
		return
	}
	// Extract model from ?model= query param if not set via env
	if llmGatewayModel == "" {
		if parsed, err := url.Parse(llmGatewayURL); err == nil {
			llmGatewayModel = parsed.Query().Get("model")
		}
	}
	// Auto-append /v1/chat/completions if URL is just a base domain
	if parsed, err := url.Parse(llmGatewayURL); err == nil {
		if parsed.Path == "" || parsed.Path == "/" {
			parsed.Path = "/v1/chat/completions"
			llmGatewayURL = parsed.String()
		}
	}
	aiEnabled = true
	log.Printf("ai: LLM Gateway configured (url=%s model=%s)", llmGatewayURL, llmGatewayModel)
}

func aiRateOK() bool {
	aiRateMu.Lock()
	defer aiRateMu.Unlock()
	now := time.Now()
	cutoff := now.Add(-1 * time.Minute)
	filtered := aiCallTimes[:0]
	for _, t := range aiCallTimes {
		if t.After(cutoff) { filtered = append(filtered, t) }
	}
	aiCallTimes = filtered
	if len(aiCallTimes) >= aiMaxCallsPerMin { return false }
	if aiConcurrent >= int32(aiMaxConcurrent) { return false }
	aiCallTimes = append(aiCallTimes, now)
	aiConcurrent++
	return true
}

func aiRateDone() {
	aiRateMu.Lock()
	defer aiRateMu.Unlock()
	aiConcurrent--
	if aiConcurrent < 0 { aiConcurrent = 0 }
}

func streamLLM(w http.ResponseWriter, systemPrompt, userPrompt string) {
	if !aiEnabled || llmGatewayURL == "" {
		http.Error(w, `{"error":"AI not available — LLM Gateway not configured"}`, 503)
		return
	}
	if !aiRateOK() {
		http.Error(w, `{"error":"AI rate limit exceeded — try again in a minute"}`, 429)
		return
	}
	defer aiRateDone()

	payload := map[string]interface{}{
		"stream":     true,
		"max_tokens": 2048,
		"messages": []map[string]interface{}{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
	}
	if llmGatewayModel != "" {
		payload["model"] = llmGatewayModel
	}
	reqBody, _ := json.Marshal(payload)

	log.Printf("ai: POST LLM gateway (model=%s, body_len=%d)", llmGatewayModel, len(reqBody))

	req, err := http.NewRequest("POST", llmGatewayURL, bytes.NewReader(reqBody))
	if err != nil {
		http.Error(w, `{"error":"failed to build LLM request"}`, 500)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if llmGatewayKey != "" {
		req.Header.Set("Authorization", "Bearer "+llmGatewayKey)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("ai: llm gateway error: %v", err)
		http.Error(w, fmt.Sprintf(`{"error":"LLM Gateway error: %s"}`, err.Error()), 502)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		log.Printf("ai: llm gateway returned %d: %s (url=%s)", resp.StatusCode, string(bodyBytes), llmGatewayURL)
		http.Error(w, fmt.Sprintf(`{"error":"LLM Gateway returned %d"}`, resp.StatusCode), 502)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", 500)
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") { continue }
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" { break }

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil { continue }
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			data, _ := json.Marshal(map[string]string{"text": chunk.Choices[0].Delta.Content})
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
	fmt.Fprintf(w, "data: {\"done\":true}\n\n")
	flusher.Flush()
}

// ─── AI: API Handlers ────────────────────────────────────────────────


func apiAIDiagnose(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" { http.Error(w, "POST only", 405); return }
	var body struct {
		Namespace string `json:"namespace"`
		Pod       string `json:"pod"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Pod == "" {
		http.Error(w, `{"error":"namespace and pod are required"}`, 400); return
	}

	podCtx := buildPodDiagnosticContext(body.Namespace, body.Pod)
	if podCtx == "" {
		http.Error(w, `{"error":"pod not found"}`, 404); return
	}

	systemPrompt := `You are a terse Kubernetes troubleshooter embedded in an ops dashboard. Space is precious.

Rules:
- Maximum 8-12 lines total. No filler, no greetings, no summaries.
- Use this exact format (skip sections that don't apply):

**Cause:** one sentence with the specific root cause
**Evidence:** bullet each signal (name, value, error text) — max 3 bullets
**Fix:** numbered kubectl commands or config changes — max 3 steps
**Prevent:** one sentence if applicable

- Reference exact container names, exit codes, error strings, timestamps.
- If the pod is healthy, reply with one line: "Pod is healthy — no issues detected."
- Never repeat the pod name/namespace or restate the question.
- Never use verbose headings, horizontal rules, or multi-paragraph explanations.`

	userPrompt := fmt.Sprintf("Diagnose this Kubernetes pod:\n\n%s", podCtx)

	streamLLM(w, systemPrompt, userPrompt)
}

func apiAISpotAnalysis(w http.ResponseWriter, r *http.Request) {
	spotCtx := buildSpotAdvisorContext()
	if spotCtx == "" {
		http.Error(w, `{"error":"no spot data available"}`, 404); return
	}

	systemPrompt := `You are a terse AWS Spot-instance advisor in an ops dashboard. Space is precious.

Rules:
- Start with a ONE-line fleet summary (node count, monthly spend, avg interruption risk).
- Then a compact markdown table: columns Current Type | Nodes | Replace With | New Nodes | Monthly Δ | Interrupt Risk
- Below the table, max 3 bullet warnings (risky patterns, consolidation tips, family concentration).
- Use exact dollar amounts and instance names. No intros, no filler.`

	userPrompt := fmt.Sprintf("Analyze this Kubernetes spot instance fleet and provide optimization recommendations:\n\n%s", spotCtx)

	streamLLM(w, systemPrompt, userPrompt)
}

// ─── AI: Context builders ────────────────────────────────────────────


func buildPodDiagnosticContext(ns, podName string) string {
	cache.mu.RLock()

	if cache.pods == nil { cache.mu.RUnlock(); return "" }

	var targetPod *corev1.Pod
	for i := range cache.pods.Items {
		p := &cache.pods.Items[i]
		if p.Namespace == ns && p.Name == podName { targetPod = p; break }
	}
	if targetPod == nil { cache.mu.RUnlock(); return "" }

	var sb strings.Builder
	p := targetPod

	sb.WriteString(fmt.Sprintf("## Pod: %s/%s\n", p.Namespace, p.Name))
	sb.WriteString(fmt.Sprintf("Status: %s\n", podDisplayStatus(*p)))
	sb.WriteString(fmt.Sprintf("Phase: %s\n", p.Status.Phase))
	if p.Status.Reason != "" { sb.WriteString(fmt.Sprintf("Reason: %s\n", p.Status.Reason)) }
	if p.Status.Message != "" { sb.WriteString(fmt.Sprintf("Message: %s\n", p.Status.Message)) }
	sb.WriteString(fmt.Sprintf("Node: %s\n", p.Spec.NodeName))
	sb.WriteString(fmt.Sprintf("Age: %s\n", shortDur(time.Since(p.CreationTimestamp.Time))))
	if p.DeletionTimestamp != nil { sb.WriteString("⚠ Pod is being DELETED\n") }

	// Container statuses
	sb.WriteString("\n### Container Statuses:\n")
	for _, cs := range p.Status.ContainerStatuses {
		sb.WriteString(fmt.Sprintf("- Container: %s ready=%v restarts=%d\n", cs.Name, cs.Ready, cs.RestartCount))
		if cs.State.Running != nil {
			sb.WriteString(fmt.Sprintf("  State: Running since %s\n", shortDur(time.Since(cs.State.Running.StartedAt.Time))))
		}
		if cs.State.Waiting != nil {
			sb.WriteString(fmt.Sprintf("  State: Waiting reason=%s message=%s\n", cs.State.Waiting.Reason, cs.State.Waiting.Message))
		}
		if cs.State.Terminated != nil {
			t := cs.State.Terminated
			sb.WriteString(fmt.Sprintf("  State: Terminated reason=%s exitCode=%d signal=%d message=%s\n", t.Reason, t.ExitCode, t.Signal, t.Message))
		}
		if cs.LastTerminationState.Terminated != nil {
			t := cs.LastTerminationState.Terminated
			sb.WriteString(fmt.Sprintf("  LastTermination: reason=%s exitCode=%d finishedAt=%s\n", t.Reason, t.ExitCode, t.FinishedAt.Time.Format(time.RFC3339)))
		}
	}

	// Init container statuses
	for _, cs := range p.Status.InitContainerStatuses {
		sb.WriteString(fmt.Sprintf("- InitContainer: %s ready=%v restarts=%d\n", cs.Name, cs.Ready, cs.RestartCount))
		if cs.State.Waiting != nil {
			sb.WriteString(fmt.Sprintf("  State: Waiting reason=%s message=%s\n", cs.State.Waiting.Reason, cs.State.Waiting.Message))
		}
		if cs.State.Terminated != nil {
			t := cs.State.Terminated
			sb.WriteString(fmt.Sprintf("  State: Terminated reason=%s exitCode=%d\n", t.Reason, t.ExitCode))
		}
	}

	// Container names for log fetching
	containerNames := []string{}
	for _, c := range p.Spec.Containers {
		containerNames = append(containerNames, c.Name)
	}

	// Resource requests/limits
	sb.WriteString("\n### Container Specs:\n")
	for _, c := range p.Spec.Containers {
		sb.WriteString(fmt.Sprintf("- %s image=%s\n", c.Name, c.Image))
		if c.Resources.Requests != nil {
			sb.WriteString(fmt.Sprintf("  Requests: cpu=%s mem=%s\n", c.Resources.Requests.Cpu().String(), c.Resources.Requests.Memory().String()))
		}
		if c.Resources.Limits != nil {
			sb.WriteString(fmt.Sprintf("  Limits: cpu=%s mem=%s\n", c.Resources.Limits.Cpu().String(), c.Resources.Limits.Memory().String()))
		}
	}

	// Actual usage from metrics
	if cache.podMetrics != nil {
		for _, m := range cache.podMetrics.Items {
			if m.Namespace == ns && m.Name == podName {
				sb.WriteString("\n### Current Resource Usage:\n")
				for _, c := range m.Containers {
					sb.WriteString(fmt.Sprintf("- %s: cpu=%dm mem=%dMi\n", c.Name, c.Usage.Cpu().MilliValue(), c.Usage.Memory().Value()/(1024*1024)))
				}
			}
		}
	}

	// Conditions
	if len(p.Status.Conditions) > 0 {
		sb.WriteString("\n### Pod Conditions:\n")
		for _, c := range p.Status.Conditions {
			sb.WriteString(fmt.Sprintf("- %s=%s reason=%s message=%s\n", c.Type, c.Status, c.Reason, c.Message))
		}
	}

	// Node conditions (if the pod is on a troubled node)
	if cache.nodes != nil && p.Spec.NodeName != "" {
		for _, n := range cache.nodes.Items {
			if n.Name == p.Spec.NodeName {
				for _, c := range n.Status.Conditions {
					if c.Type != corev1.NodeReady && c.Status == corev1.ConditionTrue {
						sb.WriteString(fmt.Sprintf("\n⚠ Node %s has condition: %s=%s (%s)\n", n.Name, c.Type, c.Status, c.Message))
					}
					if c.Type == corev1.NodeReady && c.Status != corev1.ConditionTrue {
						sb.WriteString(fmt.Sprintf("\n⚠ Node %s is NOT READY: %s\n", n.Name, c.Message))
					}
				}
			}
		}
	}

	// Related events
	if cache.events != nil {
		sb.WriteString("\n### Related Events:\n")
		count := 0
		for _, e := range cache.events.Items {
			if e.InvolvedObject.Name == podName && e.InvolvedObject.Namespace == ns {
				sb.WriteString(fmt.Sprintf("- [%s] %s %s: %s\n", shortDur(time.Since(e.LastTimestamp.Time)), e.Type, e.Reason, e.Message))
				count++
				if count >= 30 { break }
			}
		}
		if count == 0 { sb.WriteString("No recent events\n") }
	}

	cache.mu.RUnlock()

	// Fetch live logs from each container (tail 100 lines, plus previous terminated logs)
	sb.WriteString("\n### Container Logs (tail 100):\n")
	tailLines := int64(100)
	for _, cName := range containerNames {
		// Current container logs
		opts := &corev1.PodLogOptions{Container: cName, TailLines: &tailLines}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		stream, err := clientset.CoreV1().Pods(ns).GetLogs(podName, opts).Stream(ctx)
		if err != nil {
			sb.WriteString(fmt.Sprintf("\n#### Container: %s\n(failed to fetch logs: %s)\n", cName, err.Error()))
			cancel()
			continue
		}
		logBytes, err := io.ReadAll(io.LimitReader(stream, 64*1024))
		stream.Close()
		cancel()
		if err != nil {
			sb.WriteString(fmt.Sprintf("\n#### Container: %s\n(error reading logs: %s)\n", cName, err.Error()))
			continue
		}
		logStr := string(logBytes)
		if logStr == "" { logStr = "(empty)" }
		sb.WriteString(fmt.Sprintf("\n#### Container: %s (current)\n```\n%s\n```\n", cName, logStr))

		// Previous terminated container logs (useful for CrashLoopBackOff)
		prevOpts := &corev1.PodLogOptions{Container: cName, TailLines: &tailLines, Previous: true}
		ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
		prevStream, err := clientset.CoreV1().Pods(ns).GetLogs(podName, prevOpts).Stream(ctx2)
		if err == nil {
			prevBytes, _ := io.ReadAll(io.LimitReader(prevStream, 64*1024))
			prevStream.Close()
			if len(prevBytes) > 0 {
				sb.WriteString(fmt.Sprintf("\n#### Container: %s (previous/crashed)\n```\n%s\n```\n", cName, string(prevBytes)))
			}
		}
		cancel2()
	}

	return sb.String()
}

func buildSpotAdvisorContext() string {
	spotCache.mu.RLock()
	defer spotCache.mu.RUnlock()
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	if spotCache.entries == nil || cache.nodes == nil { return "" }

	var sb strings.Builder
	sb.WriteString("## Spot Instance Fleet Analysis\n\n")
	sb.WriteString(fmt.Sprintf("Region: %s\n", spotCache.region))

	// Build per-node usage map
	nodeUsage := map[string][2]int64{}
	if cache.nodeMetrics != nil {
		for _, m := range cache.nodeMetrics.Items {
			nodeUsage[m.Name] = [2]int64{m.Usage.Cpu().MilliValue(), m.Usage.Memory().Value() / (1024 * 1024)}
		}
	}

	// Collect spot nodes grouped by instance type
	type nodeInfo struct {
		Name     string
		CPU, Mem int64 // allocatable
		UsedCPU, UsedMem int64
		Nodepool string
	}
	typeNodes := map[string][]nodeInfo{}
	totalSpot := 0

	for _, n := range cache.nodes.Items {
		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" {
			if v, ok := n.Labels["eks.amazonaws.com/capacityType"]; ok { capType = strings.ToLower(v) }
		}
		if capType != "spot" { continue }
		totalSpot++

		itype := n.Labels["node.kubernetes.io/instance-type"]
		if itype == "" { itype = n.Labels["beta.kubernetes.io/instance-type"] }
		if itype == "" { continue }

		usage := nodeUsage[n.Name]
		typeNodes[itype] = append(typeNodes[itype], nodeInfo{
			Name: n.Name,
			CPU: n.Status.Allocatable.Cpu().MilliValue(),
			Mem: n.Status.Allocatable.Memory().Value() / (1024 * 1024),
			UsedCPU: usage[0], UsedMem: usage[1],
			Nodepool: n.Labels["karpenter.sh/nodepool"],
		})
	}

	sb.WriteString(fmt.Sprintf("Total spot nodes: %d across %d instance types\n\n", totalSpot, len(typeNodes)))

	sb.WriteString("### Current Spot Fleet:\n")
	sb.WriteString("InstanceType | Count | AllocCPU(m) | AllocMem(Mi) | AvgUsedCPU(m) | AvgUsedMem(Mi) | UtilCPU% | UtilMem% | SpotPrice | MonthlyPerNode | Interruption | Nodepools\n")

	for itype, nodes := range typeNodes {
		var totalAllocCPU, totalAllocMem, totalUsedCPU, totalUsedMem int64
		npSet := map[string]bool{}
		for _, n := range nodes {
			totalAllocCPU += n.CPU; totalAllocMem += n.Mem
			totalUsedCPU += n.UsedCPU; totalUsedMem += n.UsedMem
			if n.Nodepool != "" { npSet[n.Nodepool] = true }
		}
		cnt := len(nodes)
		avgCPU := totalUsedCPU / int64(cnt)
		avgMem := totalUsedMem / int64(cnt)
		utilCPU, utilMem := 0, 0
		if totalAllocCPU > 0 { utilCPU = int(totalUsedCPU * 100 / totalAllocCPU) }
		if totalAllocMem > 0 { utilMem = int(totalUsedMem * 100 / totalAllocMem) }
		price := spotCache.spotPrices[itype]
		entry := spotCache.entries[itype]
		nps := []string{}
		for np := range npSet { nps = append(nps, np) }

		sb.WriteString(fmt.Sprintf("%s | %d | %d | %d | %d | %d | %d%% | %d%% | $%.4f/hr | $%.0f/mo | %s | %s\n",
			itype, cnt, totalAllocCPU/int64(cnt), totalAllocMem/int64(cnt),
			avgCPU, avgMem, utilCPU, utilMem,
			price, price*730, interruptLabel(entry.R), strings.Join(nps, ",")))
	}

	// Available alternatives
	sb.WriteString("\n### Available Spot Alternatives (same architecture):\n")
	sb.WriteString("CurrentType | Alternative | AltCPU | AltMemGB | AltPrice | AltInterrupt | Savings%\n")
	for itype := range typeNodes {
		alts := generateAlternatives(itype)
		shown := 0
		for _, alt := range alts {
			if shown >= 5 { break }
			entry, ok := spotCache.entries[alt]
			if !ok { continue }
			spec, ok := spotCache.typeSpecs[alt]
			if !ok { continue }
			price := spotCache.spotPrices[alt]
			sb.WriteString(fmt.Sprintf("%s | %s | %d | %.1f | $%.4f/hr | %s | %d%%\n",
				itype, alt, spec.Cores, spec.RamGB, price, interruptLabel(entry.R), entry.S))
			shown++
		}
	}

	return sb.String()
}
