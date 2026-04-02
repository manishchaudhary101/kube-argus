# Changelog

All notable changes to Kube-Argus will be documented in this file.

## [v1.1.1] — 2026-04-02

### Security

- **Go runtime upgraded from 1.19 → 1.25**, resolving 42 standard library vulnerabilities (crypto/tls, crypto/x509, net/http, net/url, encoding/asn1, os/exec, and more)
- **All Go dependencies upgraded to latest**: k8s.io 0.26→0.35, golang.org/x/crypto 0.14→0.49, golang.org/x/net 0.17→0.52, go-oidc 3.9→3.17, go-jose 3.0.1→3.0.5
- **npm vulnerabilities fixed**: brace-expansion, flatted, picomatch patched via audit fix
- Result: **0 Go vulnerabilities** (govulncheck), **0 npm vulnerabilities** (npm audit)

---

## [v1.1.0] — 2026-03-29

### New Features

**Drain Wizard** — Safe, guided node drains with full visibility
- Preview which pods will be evicted before draining
- PodDisruptionBudget (PDB) awareness — see which pods are PDB-blocked
- Categorizes pods into: daemonSet, standalone, localStorage, pdbBlocked, evictable
- Real-time SSE streaming of drain progress (per-pod evicting/evicted/failed events)
- "Run in Background" option to continue working while drain proceeds

**YAML Viewer/Editor** — View and edit raw YAML for 11 resource kinds
- Supports Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, ConfigMap, Secret, HPA
- Syntax-highlighted viewer with copy-to-clipboard
- Edit and apply changes directly from the dashboard (admin only)
- managedFields auto-stripped for readability

**Storage Dashboard** — Complete PVC, PV, and StorageClass visibility
- PersistentVolumeClaims with status, capacity, StorageClass, and bound PV details
- PersistentVolumes with reclaim policy and capacity
- StorageClasses with provisioner information
- Pod-to-PVC mapping in expandable rows

**Config Drift Detection** — Identify stale configurations before they cause incidents
- Detects when a ConfigMap or Secret has been modified but pods are still running the old version
- Integrated into the dependency graph (drifted items highlighted with "STALE" badge)
- Per-item drift panel with list of affected pods

**Pod Sparklines** — Inline CPU/MEM trend charts
- 30-point ring buffer of pod metrics updated every 10 seconds
- Inline SVG sparklines with gradient fill in the pods table
- Smart unit formatting (Mi → Gi)

**Aggregated Workload Logs** — Stream logs from all pods of a workload
- Color-coded per-pod output (10 rotating colors)
- Supports Deployments, StatefulSets, and DaemonSets
- Configurable tail lines (100/300/1000) with follow mode
- Pause/resume buffering with auto-scroll

**Node Pod Heatmap** — "Noisy Neighbors" visualization
- Per-pod CPU/MEM usage on a node with heat-colored cells
- Node-level pressure bars (CPU/MEM percentage)
- Warnings for high pressure (>80% CPU or >85% MEM)

**Spot Interruption Tracking & Resilience Scoring**
- Spot instance disruption event feed with per-reason filtering
- Workload resilience scores (0-100) with deductions for single replica, zone, node, and disruptions
- Filterable by namespace and rating (low/medium/high)

**Audit Trail** — Track who did what and when
- Records logins, logouts, pod deletions, workload scaling, exec sessions, and YAML edits
- Filterable by action type (All/Logins/Admin Actions)
- Color-coded action badges with auto-refresh

**Online Users** — Live presence awareness
- See who's currently viewing the dashboard
- Avatar initials with green presence dots
- "Last seen" timestamps with 15-second auto-refresh

### Enhancements

**Pods View** — Major overhaul
- Table and card views with toggle (persisted to localStorage)
- Search bar for pod name/namespace filtering
- Status filter and owner filter dropdowns
- Sortable columns (name, namespace, status, restarts, age, CPU, MEM)
- Summary strip: total, running, pending, failed, restarts, CPU, MEM totals
- Owner info (ownerKind/ownerName) resolved through ReplicaSet chains
- Container state badges and labels in card view

**Workload Detail** — More actions, richer info
- Restart button (admin only) with confirmation
- Scale button with stepper modal
- YAML button opening inline editor
- "Agg Logs" tab for aggregated pod log streaming
- Rolling update strategy details (maxSurge, maxUnavailable, partition)
- Toast notifications for actions

**Pod Detail** — Deeper visibility
- Previous container logs (from crashed/restarted containers)
- Owner navigation — clickable link to parent workload
- Health probe display (liveness, readiness, startup) with tooltip details
- Last termination info (reason, exit code, message, timestamp)
- YAML button in header bar

**Node Management** — Safer operations
- Drain button now opens the Drain Wizard instead of direct API call
- DrainBgBanner for tracking background drains across navigation
- Pod heatmap integration in node detail

**Services & HPAs** — YAML buttons added to each item

**Dependency Graph** — Config drift integration
- Drifted ConfigMaps/Secrets highlighted with "STALE" badge
- Drift detail showing modification time and stale pod count

**Search** — Extended to more resource types
- Now also searches StatefulSets, DaemonSets, Jobs, and CronJobs

### Performance

- **Multi-batch cache refresh** — 3 sequential batches instead of one large parallel fetch, allowing the UI to render partial data faster (overview renders after batch 1)
- **GC tuning** — `SetGCPercent(400)` during initial cache load with compacting GC after, reducing startup memory pressure
- **Automatic gzip compression** — all API responses are transparently gzipped via middleware (excluding streaming endpoints)
- **Overview polling** — reduced from 10s to 5s for faster updates

### Security

- Container now runs as non-root user (`USER nobody` in Dockerfile)
- Audit logging for all mutation operations

### RBAC

- Added `persistentvolumeclaims`, `persistentvolumes` (get, list, watch)
- Added `storage.k8s.io/storageclasses` (get, list, watch)
- Added `update` verb on services, configmaps, secrets, deployments, statefulsets, daemonsets, jobs, cronjobs, HPAs (for YAML editor)

---

## [v1.0.0] — 2026-03-20

Initial open-source release.

- Live cluster overview with 10-second auto-refresh
- Node management with cordon, uncordon, drain
- Workload management (Deployments, StatefulSets, DaemonSets, Jobs, CronJobs)
- Pod management with live log streaming (SSE) and web terminal (WebSocket)
- Prometheus metrics integration (node, pod, workload)
- Spot Advisor with cost analysis and consolidation recommendations
- AI-powered pod diagnosis (any OpenAI-compatible LLM)
- Resource right-sizing recommendations
- Topology spread constraint validation
- Workload dependency graph
- Troubled pods / NOC screen with fullscreen mode
- Three auth modes: Google SSO, Generic OIDC, No Login
- Helm chart and plain Kubernetes manifests
- Multi-architecture Docker image (amd64 + arm64)
