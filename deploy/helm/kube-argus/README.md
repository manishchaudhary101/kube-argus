# Kube-Argus Helm Chart

The Kubernetes dashboard you'd build if you were tired of switching between k9s, Grafana, and kubectl.

Live cluster state, streaming pod logs, interactive shell, YAML editor, drain wizard, cost analysis, and AI-powered diagnostics — in a single binary with zero dependencies.

## Quick Install

```bash
helm repo add kube-argus https://manishchaudhary101.github.io/kube-argus
helm install kube-argus kube-argus/kube-argus -n kube-argus --create-namespace \
  --set env.CLUSTER_NAME="my-cluster"
```

## Features

- **Real-time views** — Pods, nodes, workloads, services, events auto-refresh every 10s
- **Streaming logs** — Live pod logs via SSE with follow mode and previous container logs
- **Pod exec terminal** — Browser-based shell using xterm.js
- **Node drain wizard** — Safe, guided drains with PDB awareness and live progress
- **Spot instance advisor** — Cost optimization with alternative instance recommendations
- **AI diagnostics** — LLM-powered root cause analysis for troubled pods
- **YAML view/edit** — In-browser YAML editor for all resource types
- **Workload dependency graph** — Visual map of Deployments → Services → Ingresses → HPAs
- **Namespace cost allocation** — On-demand cost breakdown per namespace
- **Topology spread validation** — HA constraint compliance at a glance
- **Audit trail** — Track who did what across the cluster
- **SSO built in** — Google, Okta, Auth0, Keycloak, or no auth

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `replicaCount` | Number of replicas | `2` |
| `image.repository` | Docker image repository | `ghcr.io/manishchaudhary101/kube-argus` |
| `image.tag` | Docker image tag | `latest` |
| `image.pullPolicy` | Image pull policy | `Always` |
| `service.type` | Kubernetes service type | `ClusterIP` |
| `service.port` | Service port | `8080` |
| `service.annotations` | Service annotations (e.g. AWS LB, Prometheus) | `{}` |
| `ingress.enabled` | Enable ingress | `false` |
| `ingress.className` | Ingress class name | `""` |
| `ingress.hosts` | Ingress hosts configuration | see values.yaml |
| `resources.requests.cpu` | CPU request | `100m` |
| `resources.requests.memory` | Memory request | `128Mi` |
| `resources.limits.cpu` | CPU limit | `500m` |
| `resources.limits.memory` | Memory limit | `512Mi` |
| `podAnnotations` | Pod annotations | `{}` |
| `podSecurityContext.runAsNonRoot` | Require non-root user | `true` |
| `podSecurityContext.runAsUser` | UID to run as | `65534` |
| `securityContext.readOnlyRootFilesystem` | Read-only root filesystem | `true` |
| `securityContext.allowPrivilegeEscalation` | Prevent privilege escalation | `false` |
| `serviceAccount.create` | Create a service account | `true` |
| `rbac.create` | Create RBAC resources (ClusterRole + binding) | `true` |
| `existingSecret` | Use an existing secret for env vars | `""` |
| `topologySpreadConstraints` | Spread pods across nodes (soft) | per-hostname |
| `affinity` | Pod anti-affinity (soft, weight 100) | per-hostname |

### Environment Variables

Set via `env.*` in values or through `existingSecret`:

| Variable | Description |
|----------|-------------|
| `CLUSTER_NAME` | Display name for the cluster |
| `DEFAULT_ROLE` | Default role for authenticated users (`viewer` or `admin`) |
| **Google SSO** | |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| **Generic OIDC** | |
| `OIDC_ISSUER` | OIDC issuer URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `OIDC_ADMIN_GROUP` | OIDC group claim for admin role |
| **Session & RBAC** | |
| `ADMIN_EMAILS` | Comma-separated admin email addresses |
| `SESSION_SECRET` | Secret key for signing session cookies |
| `SESSION_TTL` | Session duration (e.g., `8h`) |
| `CORS_ORIGIN` | Allowed CORS origin |
| **Integrations** | |
| `PROMETHEUS_URL` | Prometheus server URL for metrics charts |
| `LLM_GATEWAY_URL` | LLM API endpoint for AI diagnostics |
| `LLM_GATEWAY_KEY` | LLM API key |
| `LLM_GATEWAY_MODEL` | LLM model name |

## Examples

### With Google SSO

```bash
helm install kube-argus kube-argus/kube-argus -n kube-argus --create-namespace \
  --set env.CLUSTER_NAME="production" \
  --set env.GOOGLE_CLIENT_ID="your-client-id" \
  --set env.GOOGLE_CLIENT_SECRET="your-secret" \
  --set env.ADMIN_EMAILS="admin@company.com"
```

### With Prometheus metrics

```bash
helm install kube-argus kube-argus/kube-argus -n kube-argus --create-namespace \
  --set env.CLUSTER_NAME="production" \
  --set env.PROMETHEUS_URL="http://prometheus-server.monitoring:9090"
```

### With Ingress

```bash
helm install kube-argus kube-argus/kube-argus -n kube-argus --create-namespace \
  --set env.CLUSTER_NAME="production" \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=dashboard.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix
```

## Compatibility

Works on any conformant Kubernetes cluster: EKS, GKE, AKS, kind, Minikube, k3s, RKE2, and more.

## Links

- [GitHub Repository](https://github.com/manishchaudhary101/kube-argus)
- [Full Documentation](https://github.com/manishchaudhary101/kube-argus#readme)
- [Changelog](https://github.com/manishchaudhary101/kube-argus/blob/master/CHANGELOG.md)
