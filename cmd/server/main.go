package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"

	_ "golang.org/x/crypto/ssh"
	"golang.org/x/term"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
)

var (
	clientset   *kubernetes.Clientset
	metricsCl   *metricsv.Clientset
	restCfg     *rest.Config
	clusterName string
)

// parseLogLevel maps a case-insensitive level string to a slog.Level.
// Returns (level, true) for recognized values; (slog.LevelInfo, false) otherwise.
func parseLogLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "warn":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}

// initLogger configures the global slog default logger with a JSON handler
// writing to stdout. The minimum level is read from the LOG_LEVEL env var.
func initLogger() {
	levelStr := os.Getenv("LOG_LEVEL")
	level, recognized := parseLogLevel(levelStr)

	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
	})
	slog.SetDefault(slog.New(handler))

	if levelStr != "" && !recognized {
		slog.Warn("unrecognized LOG_LEVEL value, defaulting to info", "LOG_LEVEL", levelStr)
	}
}

func main() {
	initLogger()

	isTTY := term.IsTerminal(int(os.Stdout.Fd()))
	cyan, bold, uline, reset := "\033[36m", "\033[1m", "\033[4m", "\033[0m"
	if !isTTY {
		cyan, bold, uline, reset = "", "", "", ""
	}
	fmt.Fprint(os.Stdout, cyan+`
  _  ___   _ ____  _____      _    ____   ____ _   _ ____
 | |/ / | | | __ )| ____|    / \  |  _ \ / ___| | | / ___|
 | ' /| | | |  _ \|  _|     / _ \ | |_) | |  _| | | \___ \
 | . \| |_| | |_) | |___   / ___ \|  _ <| |_| | |_| |___) |
 |_|\_\\___/|____/|_____| /_/   \_\_| \_\\____|\___/|____/
`+reset+"\n")
	fmt.Fprint(os.Stdout, "  "+bold+"Real-time Kubernetes Dashboard"+reset+"\n")
	fmt.Fprint(os.Stdout, "  Created by "+cyan+"Manish Chaudhary"+reset+" ("+uline+"https://github.com/manishchaudhary101"+reset+")\n")
	fmt.Fprintln(os.Stdout)

	loadSecretsFromAWS()

	cfg, err := kubeConfig()
	if err != nil {
		slog.Error("kubeconfig failed", "error", err)
		os.Exit(1)
	}
	restCfg = cfg
	clientset, err = kubernetes.NewForConfig(cfg)
	if err != nil {
		slog.Error("clientset init failed", "error", err)
		os.Exit(1)
	}
	metricsCl, err = metricsv.NewForConfig(cfg)
	if err != nil {
		slog.Warn("metrics-server client init failed", "error", err)
	} else {
		slog.Info("metrics-server client initialized")
	}

	slog.Info("warming cache...")
	prevGC := debug.SetGCPercent(400)
	startCacheLoop()
	debug.SetGCPercent(prevGC)
	runtime.GC()
	cache.mu.RLock()
	nm, pm := cache.nodeMetrics != nil, cache.podMetrics != nil
	cache.mu.RUnlock()
	if nm && pm {
		slog.Info("cache ready", "metrics_server", "node + pod metrics available")
	} else if nm || pm {
		slog.Info("cache ready", "metrics_server", "partial", "node", nm, "pod", pm)
	} else if metricsCl != nil {
		slog.Warn("cache ready", "metrics_server", "no data returned — check APIService and RBAC")
	} else {
		slog.Info("cache ready", "metrics_server", "disabled")
	}

	startSpotAdvisorLoop()
	initLLM()
	initPrometheus()

	initAuth()
	jitInitPersistence()
	jitRestore()
	if len(jitStore.requests) > 0 {
		slog.Info("jit: restored requests", "count", len(jitStore.requests))
	}
	go jitExpiryLoop()

	initSlack()

	auditInitPersistence()
	auditRestore()

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
	mux.HandleFunc("/api/pod-sparklines", apiPodSparklines)
	mux.HandleFunc("/api/pods/", apiPodDetail)
	mux.HandleFunc("/api/ingresses", apiIngresses)
	mux.HandleFunc("/api/ingresses/", apiIngressDescribe)
	mux.HandleFunc("/api/services", apiServices)
	mux.HandleFunc("/api/services/", apiServiceDetail)
	mux.HandleFunc("/api/events", apiEvents)
	mux.HandleFunc("/api/hpa", apiHPA)
	mux.HandleFunc("/api/hpa/", apiHPADetail)
	mux.HandleFunc("/api/configs", apiConfigs)
	mux.HandleFunc("/api/configs/", apiConfigData)
	mux.HandleFunc("/api/exec", apiExec)
	mux.HandleFunc("/api/spot-advisor", apiSpotAdvisor)
	mux.HandleFunc("/api/spot-interruptions", apiSpotInterruptions)
	mux.HandleFunc("/api/topology-spread", apiTopologySpread)
	mux.HandleFunc("/api/metrics/node", apiMetricsNode)
	mux.HandleFunc("/api/metrics/pod", apiMetricsPod)
	mux.HandleFunc("/api/metrics/workload", apiMetricsWorkload)
	mux.HandleFunc("/api/restart-timeline", apiRestartTimeline)
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
	mux.HandleFunc("/api/storage", apiStorage)
	mux.HandleFunc("/api/config-drift", apiConfigDrift)
	mux.HandleFunc("/api/yaml/", apiYaml)
	mux.HandleFunc("/api/jit/requests", apiJITRequests)
	mux.HandleFunc("/api/jit/my-grants", apiJITMyGrants)
	mux.HandleFunc("/api/jit/", apiJITAction)
	mux.HandleFunc("/api/slack/interact", apiSlackInteract)
	mux.HandleFunc("/api/settings/slack", apiSlackSettings)
	mux.HandleFunc("/api/audit", apiAudit)
	mux.HandleFunc("/api/online-users", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		j(w, getOnlineUsers())
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
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(webRoot, "index.html"))
		})
	}

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	slog.Info("kube-argus listening", "addr", addr)
	if err := http.ListenAndServe(addr, gzipWrap(authMiddleware(corsWrap(mux)))); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
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
