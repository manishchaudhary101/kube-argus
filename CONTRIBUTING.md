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
DEFAULT_ROLE=admin go run main.go
```

Open http://localhost:8080. The dashboard auto-refreshes every 10 seconds.

### Frontend Development (with hot reload)

```bash
# Terminal 1: Run the Go backend
go run main.go

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
├── main.go                 # Go backend — all API handlers, cache, auth, WebSocket
├── web/
│   ├── src/
│   │   ├── App.tsx         # React frontend — all components in a single file
│   │   ├── index.css       # Tailwind CSS + custom styles
│   │   └── main.tsx        # React entry point
│   ├── package.json
│   └── vite.config.ts
├── deploy/
│   ├── helm/kube-argus/    # Helm chart
│   └── k8s/                # Plain Kubernetes manifests
├── Dockerfile              # Multi-stage, multi-arch build
└── docker-compose.yaml     # Local evaluation with Docker
```

### Backend (main.go)

The Go backend is a single file that handles:

- **In-memory cache** — Kubernetes resources are fetched in 3 batches every 10 seconds and stored in memory. All API responses read from this cache, so 100 users don't mean 100x API calls.
- **API handlers** — REST endpoints under `/api/*` for cluster data, workload management, pod actions, storage, YAML view/edit, audit trail, and more.
- **Auth** — OIDC/OAuth2 with support for Google SSO, generic OIDC, or no auth. Sessions stored in signed cookies.
- **WebSocket** — Pod exec terminal via `gorilla/websocket` + `client-go/remotecommand`.
- **SSE streaming** — Pod logs, drain progress, and aggregated workload logs streamed via Server-Sent Events.
- **Gzip middleware** — Automatic response compression for all API endpoints.

### Frontend (App.tsx)

The React frontend is a single-file application using:

- **React 19** with TypeScript
- **Tailwind CSS** for styling (dark theme)
- **Recharts** for Prometheus metric charts
- **xterm.js** for the pod terminal
- **js-yaml** for YAML parsing/display

## How to Add a New Feature

### Adding a New Backend API Endpoint

1. Write your handler function in `main.go`:
   ```go
   func apiMyFeature(w http.ResponseWriter, r *http.Request) {
       // Use the cached data from clusterCache
       c.mu.RLock()
       defer c.mu.RUnlock()
       // Build your response
       j(w, result) // j() is the JSON response helper
   }
   ```

2. Register the route in `main()` (around line 1900):
   ```go
   mux.HandleFunc("/api/my-feature", apiMyFeature)
   ```

3. If the endpoint modifies cluster state, wrap it with `requireAdmin()` and add an `auditRecord()` call.

4. If new K8s resources are needed, add RBAC permissions to both `deploy/k8s/rbac.yaml` and `deploy/helm/kube-argus/templates/clusterrole.yaml`.

### Adding a New Frontend Component

1. Add your component function in `web/src/App.tsx`.
2. Add navigation in the sidebar (search for the `nav` section).
3. Add the view rendering in the main content area (search for the view switching logic).

### Adding New Cache Data

If your feature needs Kubernetes resources not already cached:

1. Add the list call in the appropriate batch in `clusterCache.refresh()` (around line 670).
2. Add the field to the `clusterCache` struct.
3. Use `c.mu.RLock()` in your handler to read from the cache.

## Code Style

- Go code follows standard `gofmt` formatting
- Frontend uses the project's ESLint config
- Avoid adding comments that narrate what the code does — comments should explain non-obvious intent
- Keep things simple — both `main.go` and `App.tsx` are single files by design for easy navigation

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Ensure both builds pass:
   ```bash
   go build -o /dev/null main.go
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
