package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/secretsmanager"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
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
		slog.Info("AWS_SECRET_NAME not set, skipping Secrets Manager")
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
		slog.Warn("AWS session init failed, secrets won't load from SM", "error", err)
		return
	}
	svc := secretsmanager.New(sess)
	result, err := svc.GetSecretValue(&secretsmanager.GetSecretValueInput{
		SecretId: aws.String(secretName),
	})
	if err != nil {
		slog.Error("failed to fetch secret", "secret", secretName, "error", err)
		return
	}
	if result.SecretString == nil {
		slog.Warn("secret has no string value", "secret", secretName)
		return
	}

	var secrets map[string]string
	if err := json.Unmarshal([]byte(*result.SecretString), &secrets); err != nil {
		slog.Error("failed to parse secret JSON", "error", err)
		return
	}

	envKeys := []string{"OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_SECRET", "OIDC_ADMIN_GROUP", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAILS", "DEFAULT_ROLE", "CLUSTER_NAME", "LLM_GATEWAY_URL", "LLM_GATEWAY_KEY", "LLM_GATEWAY_MODEL", "PROMETHEUS_URL", "PROMETHEUS_USER", "PROMETHEUS_KEY", "SLACK_WEBHOOK_URL", "SLACK_SIGNING_SECRET"}
	loaded := 0
	for _, k := range envKeys {
		if v, ok := secrets[k]; ok && v != "" && os.Getenv(k) == "" {
			os.Setenv(k, v)
			loaded++
		}
	}
	slog.Info("loaded auth secrets from AWS Secrets Manager", "count", loaded, "secret", secretName)
}

func initAuth() {
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
		slog.Info("auth mode: none", "default_role", defaultRole)
		return
	}

	oidcIssuer = issuer

	// ── Session signing key ─────────────────────────────────────────
	secret := os.Getenv("SESSION_SECRET")
	if secret == "" {
		b := make([]byte, 32)
		rand.Read(b)
		sessionKey = b
		slog.Warn("SESSION_SECRET not set, generated random key (sessions won't survive restarts)")
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
		slog.Error("OIDC provider init failed", "error", err)
		os.Exit(1)
	}

	oauthConfig = &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Endpoint:     oidcProvider.Endpoint(),
		Scopes:       scopes,
	}

	oidcVerifier = oidcProvider.Verifier(&oidc.Config{ClientID: clientID})
	authEnabled = true
	slog.Info("auth mode configured", "mode", authMode, "issuer", issuer)
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
		Name:     "kubeargus_session",
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
		Name:     "kubeargus_session",
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
	if oauthConfig == nil {
		je(w, "authentication not configured — set OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET", 500)
		return
	}
	oauthConfig.RedirectURL = callbackURL(r)
	state := fmt.Sprintf("%d", time.Now().UnixNano())
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: state, Path: "/", HttpOnly: true, MaxAge: 600, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"})
	http.Redirect(w, r, oauthConfig.AuthCodeURL(state), http.StatusFound)
}

func authCallback(w http.ResponseWriter, r *http.Request) {
	if oauthConfig == nil {
		je(w, "authentication not configured", 500)
		return
	}
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
		je(w, "token exchange failed: "+err.Error(), 500)
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		je(w, "no id_token in response", 500)
		return
	}

	idToken, err := oidcVerifier.Verify(r.Context(), rawIDToken)
	if err != nil {
		je(w, "token verify failed: "+err.Error(), 500)
		return
	}

	var claims struct {
		Email  string   `json:"email"`
		Groups []string `json:"groups"`
	}
	if err := idToken.Claims(&claims); err != nil {
		je(w, "claims parse failed: "+err.Error(), 500)
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
	slog.Info("auth: user logged in", "email", claims.Email, "role", role)
	auditRecord(claims.Email, role, "login", "", "role: "+role, clientIP(r))

	redirectTo := "/"
	if rc, err := r.Cookie("kubeargus_return"); err == nil && rc.Value != "" && strings.HasPrefix(rc.Value, "/") {
		redirectTo = rc.Value
		http.SetCookie(w, &http.Cookie{Name: "kubeargus_return", Value: "", Path: "/", MaxAge: -1})
	}
	http.Redirect(w, r, redirectTo, http.StatusFound)
}

func authLogout(w http.ResponseWriter, r *http.Request) {
	if sd, ok := r.Context().Value(userCtxKey).(*sessionData); ok && sd != nil {
		auditRecord(sd.Email, sd.Role, "logout", "", "", clientIP(r))
	}
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
		if path == "/health" || strings.HasPrefix(path, "/auth/") || strings.HasPrefix(path, "/api/slack/") {
			next.ServeHTTP(w, r)
			return
		}

		cookie, err := r.Cookie("kubeargus_session")
		if err != nil {
			if strings.HasPrefix(path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(401)
				json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			} else {
				returnTo := r.URL.RequestURI()
				if returnTo != "" && returnTo != "/" {
					http.SetCookie(w, &http.Cookie{Name: "kubeargus_return", Value: returnTo, Path: "/", HttpOnly: true, MaxAge: 300, SameSite: http.SameSiteLaxMode})
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
					http.SetCookie(w, &http.Cookie{Name: "kubeargus_return", Value: returnTo, Path: "/", HttpOnly: true, MaxAge: 300, SameSite: http.SameSiteLaxMode})
				}
				http.Redirect(w, r, "/auth/login", http.StatusFound)
			}
			return
		}

		trackUser(sd.Email, sd.Role, clientIP(r))
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
