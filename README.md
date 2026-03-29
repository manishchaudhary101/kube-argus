# K8SDASH

A production-grade Kubernetes dashboard built for SREs and platform engineers. Real-time cluster visibility with Prometheus metrics, cost analysis, resource right-sizing, and AI-powered diagnostics — all in a single pane of glass.

![Go](https://img.shields.io/badge/Go-1.19+-00ADD8?logo=go&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![License](https://img.shields.io/badge/License-Apache%202.0-blue)
![Kubernetes](https://img.shields.io/badge/Kubernetes-1.24+-326CE5?logo=kubernetes&logoColor=white)

![K8SDASH Overview](docs/screenshot-overview.png)

![K8SDASH Spot Advisor](docs/screenshot-spot-advisor.png)

---

## Why K8SDASH?

Most Kubernetes dashboards show you resources. K8SDASH tells you what's **wrong**, what it **costs**, and how to **fix** it.

| Capability | K8SDASH | K8s Dashboard | Lens | Headlamp | k9s |
|---|:---:|:---:|:---:|:---:|:---:|
| Spot instance cost analysis & consolidation | **Yes** | — | — | — | — |
| AI-powered pod diagnosis (any LLM) | **Yes** | — | — | — | — |
| Resource right-sizing recommendations | **Yes** | — | — | — | — |
| Topology spread constraint validation | **Yes** | — | — | — | — |
| Namespace-level cost allocation | **Yes** | — | — | — | — |
| Prometheus metrics (node, pod, workload) | **Yes** | — | Partial | — | — |
| Workload dependency graph | **Yes** | — | — | — | — |
| PDB status inline on workloads | **Yes** | — | — | — | — |
| Web terminal (exec into pods) | **Yes** | — | Yes | Yes | Terminal-native |
| Troubled pods view (NOC screen mode) | **Yes** | — | — | — | — |
| Single binary, zero dependencies | **Yes** | Needs metrics-server | Desktop app | Needs plugins | Terminal app |
| Web-based (no install) | **Yes** | Yes | No | Yes | No |
| Open source (Apache 2.0) | **Yes** | Yes | Freemium | Yes | Yes |

**In short**: K8SDASH combines cluster visibility, cost optimisation, and AI diagnostics into a single binary that deploys in under a minute — no CRDs, no databases, no agents.

---

## Features

### Cluster Overview
- Real-time node status (Ready, NotReady, Draining, Cordoned) with k9s-style transitions
- Cluster-wide CPU and memory utilisation at a glance
- Warning counts and top resource consumers

### Node Management
- All nodes with status, instance type, capacity, allocatable resources, and age
- Click any node for `kubectl describe`-style detail with events (Karpenter, spot interruptions, drain failures)
- Per-node Prometheus metrics: CPU, memory, disk, and network

### Workloads
- Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs in one filterable view
- ReplicaSet history (last 5) inside Deployments
- PodDisruptionBudget (PDB) status badges inline on workload rows
- Prometheus CPU and memory metrics with selectable time ranges (1h, 6h, 12h, 24h)
- Resource right-sizing recommendations based on 7-day average usage
- Interactive dependency graph showing linked HPA, Services, Ingress, ConfigMaps, and Secrets

### Pod Management
- All pods with phase, restarts, resource usage bars, and node placement
- Log streaming with container selector (including init containers)
- AI-powered diagnosis for unhealthy pods
- Per-pod CPU and memory metrics

### Networking
- Services (ClusterIP, NodePort, LoadBalancer) with ports and selectors
- Ingress rules with hosts, paths, TLS status, and backend services

### Configuration
- ConfigMaps and Secrets with last-modified timestamps
- Data key inspection (Secrets are masked)

### Cost & Optimisation
- **Spot Advisor**: Spot instance risk analysis with intelligent consolidation suggestions
- **Cost Allocation**: Namespace-level and nodepool-level cost breakdown
- **Total Cluster Cost**: Aggregated cost panel

### Topology Spread Analysis
- Validates workloads against their topologySpreadConstraints
- Shows violations grouped by topology key (zone, hostname, instance-type)
- Distinguishes soft (ScheduleAnyway) vs hard (DoNotSchedule) constraints

### Troubled Pods
- Non-running pods (CrashLoopBackOff, ImagePullBackOff, Pending, OOMKilled) in one dedicated view
- Fullscreen mode for wall-mounted monitoring screens

### Events
- Cluster events filtered by namespace with type, reason, source, and message

### Security
- **Three auth modes**: Google SSO, generic OIDC (Okta, Auth0, Keycloak, Azure AD, Dex), or no login
- Role-based access: admin vs viewer (via OIDC groups or email allowlist)
- Session cookies with HMAC signing

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Browser (React + TypeScript + Tailwind)     │
│  Recharts for metrics, xterm.js for shell    │
└──────────────┬───────────────────────────────┘
               │ HTTP / WebSocket
┌──────────────▼───────────────────────────────┐
│  Go Backend (single binary)                  │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ │
│  │ K8s API     │ │Prometheus│ │ AWS EC2   │ │
│  │ client-go   │ │ /api/v1  │ │ Spot Price│ │
│  └─────────────┘ └──────────┘ └───────────┘ │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ │
│  │ OIDC Auth   │ │ LLM GW   │ │ Secrets   │ │
│  │ (any IdP)   │ │ (OpenAI) │ │ Manager   │ │
│  └─────────────┘ └──────────┘ └───────────┘ │
└──────────────────────────────────────────────┘
```

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Recharts
- **Backend**: Go with client-go, single binary, in-memory cache with configurable poll interval
- **Metrics**: Prometheus API (compatible with Grafana Cloud, Thanos, vanilla Prometheus)
- **Auth**: OIDC/OAuth2 (any compliant provider)
- **AI**: Any OpenAI-compatible chat completion API (optional)
- **Secrets**: AWS Secrets Manager (optional) or direct environment variables

---

## Quick Start

### Prerequisites
- Go 1.19+
- Node.js 18+
- Access to a Kubernetes cluster (kubeconfig or in-cluster)
- (Optional) Prometheus endpoint for metrics
- (Optional) OIDC provider for authentication

### Local Development

```bash
# Clone the repository
git clone https://github.com/manishchaudhary101/k8sdash.git
cd k8sdash

# Build the frontend
cd web && npm install && npm run build && cd ..

# Run the backend (uses ~/.kube/config by default)
go run main.go
```

Open http://localhost:8080.

### With Docker

```bash
docker build -t k8sdash .
docker run -p 8080:8080 \
  -v ~/.kube/config:/root/.kube/config:ro \
  k8sdash
```

### On Kubernetes (Helm)

```bash
helm install k8sdash oci://ghcr.io/manishchaudhary101/charts/k8sdash \
  --set env.CLUSTER_NAME="my-cluster"
```

To customise, download the default values and edit:

```bash
helm show values oci://ghcr.io/manishchaudhary101/charts/k8sdash > values.yaml
# Edit values.yaml, then:
helm install k8sdash oci://ghcr.io/manishchaudhary101/charts/k8sdash -f values.yaml
```

### On Kubernetes (plain manifests)

```bash
kubectl apply -f deploy/k8s/
```

---

## Configuration

All configuration is via environment variables. No config files to manage.

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8080` | HTTP listen port |
| `CLUSTER_NAME` | No | auto-detected | Display name for the cluster |
| `KUBECONFIG` | No | `~/.kube/config` | Path to kubeconfig (ignored when running in-cluster) |

### Authentication

Auth mode is **auto-detected** from which env vars you set:

| Mode | When | Login screen |
|------|------|-------------|
| **Google SSO** | `GOOGLE_CLIENT_ID` is set | "Sign in with Google" button |
| **Generic OIDC** | `OIDC_ISSUER` is set | "Sign in with SSO" button |
| **None** | Neither set | No login wall, everyone gets `DEFAULT_ROLE` |

#### Option A: Google SSO (simplest)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth2 client ID ([console.cloud.google.com](https://console.cloud.google.com/apis/credentials)) |
| `GOOGLE_CLIENT_SECRET` | Yes | — | Google OAuth2 client secret |

Set the authorized redirect URI in Google Cloud Console to `https://YOUR_DOMAIN/auth/callback`.

#### Option B: Generic OIDC (any provider)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OIDC_ISSUER` | Yes | — | OIDC issuer URL (e.g. `https://your-org.okta.com/oauth2/default`) |
| `OIDC_CLIENT_ID` | Yes | — | OAuth2 client ID |
| `OIDC_CLIENT_SECRET` | Yes | — | OAuth2 client secret |
| `OIDC_ADMIN_GROUP` | No | `admin` | OIDC group claim value that grants admin role |

> **Note**: Legacy `OKTA_*` env var names are still supported for backward compatibility.

#### Option C: No Login

Leave all auth env vars blank. Everyone gets `DEFAULT_ROLE` (default: `viewer`). Suitable for local dev or trusted networks.

#### Roles & Access

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_EMAILS` | No | — | Comma-separated admin email addresses (works with any auth mode) |
| `DEFAULT_ROLE` | No | `viewer` | Role when auth is disabled: `viewer` or `admin` |
| `SESSION_SECRET` | No | random | HMAC key for session cookies (hex-encoded recommended) |
| `SESSION_TTL` | No | `8h` | Session duration (Go duration format: `1h`, `30m`, `24h`) |
| `INSECURE_COOKIE` | No | `false` | Set to `true` for HTTP-only dev environments |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin (set to your dashboard URL in production) |

Admin access (pod delete, exec, scale) is granted when **any** of these match:
1. User's email is in `ADMIN_EMAILS`
2. User's OIDC group matches `OIDC_ADMIN_GROUP`
3. Auth is disabled and `DEFAULT_ROLE=admin`

### Prometheus Metrics

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROMETHEUS_URL` | No | — | Prometheus base URL. Grafana Cloud URLs (`*.grafana.net`) get `/api/prom` auto-appended |
| `PROMETHEUS_USER` | No | — | Basic auth username (for Grafana Cloud or protected Prometheus) |
| `PROMETHEUS_KEY` | No | — | Basic auth password/API key |

### AI Diagnosis (Optional)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_GATEWAY_URL` | No | — | OpenAI-compatible chat completions endpoint |
| `LLM_GATEWAY_KEY` | No | — | Bearer token for the LLM API |
| `LLM_GATEWAY_MODEL` | No | — | Model name (e.g. `gpt-4o`, `claude-3`) |

### AWS Integration (Optional)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_SECRET_NAME` | No | — | AWS Secrets Manager secret ID to load config from |
| `AWS_REGION` | No | `us-east-1` | AWS region for Secrets Manager and EC2 spot pricing |

When `AWS_SECRET_NAME` is set, the app loads config values from Secrets Manager at startup. Any env var already set takes precedence. The secret should be a JSON object with keys matching the env var names above.

---

## Cluster Impact

K8SDASH is designed to be lightweight:
- **Read-only**: No write operations to the K8s API (except admin actions: pod delete, scale, exec)
- **Cached**: All list operations are cached in-memory, refreshed every 15 seconds
- **Single connection**: One set of API calls per refresh cycle, not per-user
- **No CRDs**: No custom resources or operators needed
- **Prometheus**: Standard PromQL range queries, no recording rules required (but supported)

---

## RBAC

The service account needs the following permissions:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: k8sdash
rules:
  - apiGroups: [""]
    resources: [nodes, pods, pods/log, services, events, configmaps, secrets, namespaces, resourcequotas]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [nodes]
    verbs: [patch]
  - apiGroups: [""]
    resources: [pods, pods/exec]
    verbs: [get, list, watch, delete, create]
  - apiGroups: [""]
    resources: [pods/eviction]
    verbs: [create]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets, replicasets]
    verbs: [get, list, watch, patch]
  - apiGroups: [apps]
    resources: [deployments/scale, statefulsets/scale]
    verbs: [get, update]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list, watch]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets]
    verbs: [get, list, watch]
  - apiGroups: [metrics.k8s.io]
    resources: [nodes, pods]
    verbs: [get, list]
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

---

## License

This project is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE) file for details.
