package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	k8serr "k8s.io/apimachinery/pkg/api/errors"
)

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

type gzResponseWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzResponseWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

func gzipWrap(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.ServeHTTP(w, r)
			return
		}
		p := r.URL.Path
		if p == "/api/exec" || p == "/api/events" || p == "/api/ai/diagnose" || strings.HasSuffix(p, "/agglogs") || r.URL.Query().Get("follow") == "true" || (strings.HasSuffix(p, "/drain") && r.URL.Query().Get("stream") == "true") {
			h.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(p, "/api/") {
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			defer gz.Close()
			h.ServeHTTP(&gzResponseWriter{ResponseWriter: w, gz: gz}, r)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// jk8s writes a JSON error, returning 404 for k8s NotFound errors, 500 otherwise.
func jk8s(w http.ResponseWriter, err error) {
	if k8serr.IsNotFound(err) {
		je(w, "not found", 404)
	} else {
		je(w, err.Error(), 500)
	}
}

func je(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func j(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		je(w, "encoding failed", http.StatusInternalServerError)
	}
}

func jGz(w http.ResponseWriter, _ *http.Request, v interface{}) {
	j(w, v)
}

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}
