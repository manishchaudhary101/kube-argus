# Contributing to Kube-Argus

Thanks for your interest in improving Kube-Argus! This guide will help you get set up and start contributing.

## Local Development Setup

### Prerequisites

- Go 1.25+
- Node.js 20+
- Access to a Kubernetes cluster (Minikube, kind, or a real cluster via kubeconfig)
- (Optional) Prometheus for metrics features

### Quick Start

```bash
git clone https://github.com/manishchaudhary101/kube-argus.git
cd kube-argus

# Build the frontend
cd web && npm install && npm run build && cd ..

# Run the backend (uses ~/.kube/config by default)
DEFAULT_ROLE=admin go run ./cmd/server
```

Open http://localhost:8080. The dashboard auto-refreshes every 10 seconds.

### Frontend Development (with hot reload)

```bash
# Terminal 1: Run the Go backend
go run ./cmd/server

# Terminal 2: Run the Vite dev server with proxy
cd web && npm run dev
```

The Vite dev server runs on port 5173 and proxies API requests to the Go backend on port 8080.

### Docker Build

```bash
docker build -t kube-argus .
docker run -p 8080:8080 -v ~/.kube/config:/home/nobody/.kube/config:ro kube-argus
```

## Architecture

```
├── cmd/server/                 # Go backend source files (package main)
│   ├── main.go                 #   Entrypoint, route registration, kubeConfig
│   ├── auth.go                 #   OIDC / Google / None auth, sessions, middleware
│   ├── cache.go                #   In-memory Kubernetes resource cache
│   ├── nodes.go                #   Node APIs (list, cordon, drain, pod-usage)
│   ├── workloads.go            #   Workload APIs (list, scale, restart, agglogs)
│   ├── pods.go                 #   Pod APIs (list, detail, delete)
│   ├── prometheus.go           #   Prometheus metrics, sizing, alerts
│   ├── ai.go                   #   LLM gateway, AI diagnosis
│   ├── ...                     #   + 11 more domain-organized files
├── web/
│   ├── src/
│   │   ├── App.tsx             # React app shell — routing, sidebar, header
│   │   ├── types.ts            # Shared TypeScript interfaces
│   │   ├── routing.ts          # Tab definitions and URL parsing
│   │   ├── context/            # React contexts (auth)
│   │   ├── hooks/              # Custom hooks (useFetch, useMetrics, etc.)
│   │   ├── components/
│   │   │   ├── ui/             # Reusable atoms (Pill, Btn, K9sBar, MetricChart)
│   │   │   ├── modals/         # Modal dialogs (Search, Drain, YAML, Audit)
│   │   │   └── views/          # Page-level view components
│   │   ├── layout/             # Layout components (NamespacePicker, UserMenu)
│   │   ├── index.css           # Tailwind CSS + custom styles
│   │   └── main.tsx            # React entry point
│   ├── package.json
│   └── vite.config.ts
├── deploy/
│   ├── helm/kube-argus/        # Helm chart
│   └── k8s/                    # Plain Kubernetes manifests
├── Dockerfile                  # Multi-stage, multi-arch build
└── docker-compose.yaml         # Local evaluation with Docker
```

### Backend (`cmd/server/`)

The Go backend is organized into ~20 domain-focused files, all in `package main`:

- **`main.go`** — Entrypoint, Kubernetes client initialization, route registration
- **`server.go`** — CORS, gzip middleware, JSON/context helpers
- **`auth.go`** — OIDC/OAuth2 with Google SSO, generic OIDC, or no auth; cookie-based sessions
- **`cache.go`** — In-memory cache refreshed every 10s in 3 batches; all API reads hit cache, not the K8s API
- **`nodes.go`** — Node list, cordon/uncordon, drain wizard, pod-usage heatmap
- **`workloads.go`** — Workload list, scale/restart, aggregated logs
- **`pods.go`** — Pod list, detail, delete
- **`prometheus.go`** — Metrics charts, right-sizing, alerts
- **`ai.go`** — LLM-powered pod diagnosis and spot analysis
- **`resources.go`** — PDBs, HPAs, events, topology spread, search, namespace costs
- **`spot_advisor.go`** — Spot instance recommendations and consolidation
- And more: `audit.go`, `config.go`, `exec.go`, `networking.go`, `storage.go`, `yaml_editor.go`, `sparklines.go`, `helpers.go`

### Frontend (`web/src/`)

The React frontend is organized into ~40 TypeScript files:

- **`types.ts`** — All shared interfaces (Pod, Workload, NodeInfo, etc.)
- **`hooks/`** — Data fetching (`useFetch`), metrics, AI streaming, drain background
- **`components/ui/`** — Reusable atoms: Pill, Btn, Spinner, K9sBar, MetricChart, MiniSparkline
- **`components/modals/`** — Search, DrainWizard, YAML editor, AuditTrail, OnlineUsers
- **`components/views/`** — One file per page (OverviewView, NodesView, PodsView, etc.)
- **`layout/`** — NamespacePicker, UserMenuDropdown

Uses React 19, TypeScript, Tailwind CSS, Recharts, xterm.js, and js-yaml.

## How to Add a New Feature

### Adding a New Backend API Endpoint

1. Create a handler function in the appropriate domain file under `cmd/server/` (e.g., add a storage endpoint to `storage.go`):
   ```go
   func apiMyFeature(w http.ResponseWriter, r *http.Request) {
       cache.mu.RLock()
       defer cache.mu.RUnlock()
       j(w, result)
   }
   ```

2. Register the route in `main.go`:
   ```go
   mux.HandleFunc("/api/my-feature", apiMyFeature)
   ```

3. If the endpoint modifies cluster state, wrap it with `requireAdmin()` and add an `auditRecord()` call.

4. If new K8s resources are needed, add RBAC permissions to both `deploy/k8s/rbac.yaml` and `deploy/helm/kube-argus/templates/clusterrole.yaml`.

### Adding a New Frontend Component

1. Add your view component in `web/src/components/views/`.
2. Import and render it in `App.tsx` within the tab routing section.
3. Add navigation entry in `routing.ts` (the `TABS` array).

### Adding New Cache Data

If your feature needs Kubernetes resources not already cached:

1. Add the list call in the appropriate batch in `cache.go`'s `refresh()` function.
2. Add the field to the `clusterCache` struct.
3. Use `cache.mu.RLock()` in your handler to read from the cache.

## Code Style

- Go code follows standard `gofmt` formatting
- Frontend uses the project's ESLint config
- Avoid adding comments that narrate what the code does — comments should explain non-obvious intent
- Group code by domain — each file should own one concern

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Ensure both builds pass:
   ```bash
   go build ./cmd/server
   cd web && npm run build
   ```
5. Commit with a descriptive message (`feat:`, `fix:`, `docs:`, `chore:`)
6. Push and open a Pull Request

## Reporting Issues

- Use the **Bug Report** template for bugs
- Use the **Feature Request** template for new ideas
- Include your Kubernetes version, cloud provider, and browser when reporting UI issues

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
