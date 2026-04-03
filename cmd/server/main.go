package main

import (
	"log"
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

func main() {
	log.SetFlags(0)
	isTTY := term.IsTerminal(int(os.Stdout.Fd()))
	cyan, bold, uline, reset := "\033[36m", "\033[1m", "\033[4m", "\033[0m"
	if !isTTY {
		cyan, bold, uline, reset = "", "", "", ""
	}
	log.Println(cyan + `
  _  ___   _ ____  _____      _    ____   ____ _   _ ____
 | |/ / | | | __ )| ____|    / \  |  _ \ / ___| | | / ___|
 | ' /| | | |  _ \|  _|     / _ \ | |_) | |  _| | | \___ \
 | . \| |_| | |_) | |___   / ___ \|  _ <| |_| | |_| |___) |
 |_|\_\\___/|____/|_____| /_/   \_\_| \_\\____|\___/|____/
` + reset)
	log.Println("  " + bold + "Real-time Kubernetes Dashboard" + reset)
	log.Println("  Created by " + cyan + "Manish Chaudhary" + reset + " (" + uline + "https://github.com/manishchaudhary101" + reset + ")")
	log.Println()
	log.SetFlags(log.LstdFlags)

	loadSecretsFromAWS()

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
	prevGC := debug.SetGCPercent(400)
	startCacheLoop()
	debug.SetGCPercent(prevGC)
	runtime.GC()
	log.Println("cache ready")

	startSpotAdvisorLoop()
	initLLM()
	initPrometheus()

	initAuth()
	jitInitPersistence()
	jitRestore()
	go jitExpiryLoop()

	auditInitPersistence()
	auditRestore()
	go auditPersistLoop()

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
	mux.HandleFunc("/api/events", apiEvents)
	mux.HandleFunc("/api/hpa", apiHPA)
	mux.HandleFunc("/api/configs", apiConfigs)
	mux.HandleFunc("/api/configs/", apiConfigData)
	mux.HandleFunc("/api/exec", apiExec)
	mux.HandleFunc("/api/spot-advisor", apiSpotAdvisor)
	mux.HandleFunc("/api/spot-interruptions", apiSpotInterruptions)
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
	mux.HandleFunc("/api/storage", apiStorage)
	mux.HandleFunc("/api/config-drift", apiConfigDrift)
	mux.HandleFunc("/api/yaml/", apiYaml)
	mux.HandleFunc("/api/jit/requests", apiJITRequests)
	mux.HandleFunc("/api/jit/my-grants", apiJITMyGrants)
	mux.HandleFunc("/api/jit/", apiJITAction)
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
	log.Printf("kube-argus listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, gzipWrap(authMiddleware(corsWrap(mux)))))
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
