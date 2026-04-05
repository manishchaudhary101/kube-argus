# Changelog

All notable changes to Kube-Argus will be documented in this file.

## [v1.2.1] — 2026-04-05

### 📋 Structured JSON Logging

Production-grade structured logging with configurable log levels. All log output is now machine-readable JSON, compatible with CloudWatch, Datadog, ELK, and other log aggregation tools.

#### Changes

- **Structured JSON output** — replaced Go's standard `log` package with `log/slog` across all 9 server source files. Every log line is now a single-line JSON object with `time`, `level`, and `msg` fields plus structured key-value attributes.
- **Configurable `LOG_LEVEL`** — new environment variable accepts `debug`, `info`, `warn`, or `error` (case-insensitive). Defaults to `info`. Invalid values fall back to `info` with a warning.
- **Helm chart support** — `LOG_LEVEL` added to `values.yaml` (default: `info`) and `values.schema.json` for declarative configuration.
- **Appropriate log levels** — startup messages at INFO, degraded states (metrics-server unavailable) at WARN, failures at ERROR, verbose detail (AI request bodies) at DEBUG.
- **ASCII banner preserved** — the startup banner uses `fmt.Fprint` to avoid wrapping decorative output in JSON.
- **Standard log bridge** — `slog.SetDefault()` ensures any third-party library using Go's standard `log` package also emits structured JSON.

### 📄 README Redesign

- Centered hero section with logo, title, and author attribution
- Expanded badge row: build status, release version, last commit, code size, stars, issues, Docker image, Artifact Hub
- Feature details collapsed into expandable sections for cleaner presentation
- Feature comparison table with checkmark icons

## [v1.2.0] — 2026-04-03

### 🔐 New Feature: Just-in-Time (JIT) Exec Access

**Zero-trust shell access for Kubernetes pods** — viewers request time-bound exec access, admins approve or deny from the dashboard. No more permanent shell permissions for non-admin users.

#### 🔄 How it works

1. 🙋 **Viewer requests access** — from the pod detail page, viewers click "Request Shell Access" and provide a reason and duration
2. 🔔 **Admin gets notified** — a notification badge appears on the admin's avatar showing the number of pending requests
3. ✅ **Admin approves/denies** — from the Access Requests panel (admin dropdown menu), admins review and approve or deny each request
4. ⏱️ **Temporary access** — approved access is scoped to the workload (Deployment/StatefulSet) and auto-expires after the requested duration
5. 📝 **Full audit trail** — all JIT actions (request, approve, deny, revoke, expire) are recorded in the audit trail

#### ⚙️ Backend (Go) — `cmd/server/jit.go` (511 lines, new file)

- 🔁 **JIT request lifecycle** — full state machine: `pending` → `active`/`denied`/`expired` → `revoked`/`expired`
- 🎯 **Workload-scoped grants** — access is granted at the Deployment/StatefulSet/DaemonSet level, not individual pods; `resolvePodOwner()` walks `OwnerReferences` chains (Pod → ReplicaSet → Deployment) to resolve the top-level owner
- 💾 **ConfigMap persistence** — JIT requests survive pod restarts and are shared across replicas via Kubernetes ConfigMap (no database required)
- 🔒 **Optimistic concurrency** — ConfigMap updates use `resourceVersion` to prevent lost updates in multi-replica setups, with automatic retry on conflicts
- ⏳ **Pending request TTL** — unanswered requests auto-expire after 48 hours
- 🧹 **Configurable retention** — terminal states (expired, denied, revoked) are pruned after `jit.retentionDays` (default: 7 days)
- 🔄 **Background expiry loop** — goroutine that checks active grants and pending TTLs every 30 seconds, persists state every 60 seconds
- 🛡️ **Graceful degradation** — ConfigMap read/write failures log warnings but never crash the application
- 🌐 **REST API endpoints**: `POST /api/jit/request`, `GET /api/jit/requests`, `GET /api/jit/grants`, `POST /api/jit/:id/approve`, `POST /api/jit/:id/deny`, `POST /api/jit/:id/revoke`
- 🔗 **Exec integration** — `requireAdminOrJIT` middleware updated to check deployment-scoped JIT grants before allowing exec

#### 💾 Backend — Audit ConfigMap Persistence (`cmd/server/audit.go`)

- 📦 **Audit trail persistence** — audit entries now persist to a dedicated ConfigMap alongside JIT requests
- ⚡ **Dirty-flag optimization** — `auditPersistLoop()` only writes to ConfigMap when new entries have been recorded (every 60s)
- 🔄 **Restore on startup** — `auditRestore()` loads previous audit entries from ConfigMap at application start

#### 🖥️ Frontend — JIT Request Modal (`web/src/components/modals/JITRequestModal.tsx`, new file)

- 📋 **Request form** — modal for viewers to submit JIT access requests with reason and duration fields
- 🏷️ **Workload context** — displays the ownerKind/ownerName (e.g., "Deployment: my-app") with an explanatory message about deployment-level access
- ⏱️ **Duration selector** — configurable access duration

#### 📋 Frontend — Access Requests Panel (`web/src/components/views/JITRequestsView.tsx`, new file)

- 🖼️ **Full-screen modal** — styled consistently with Audit Trail and Online Users modals
- 🔍 **Status filters** — filter by all/pending/active/denied/expired/revoked
- 🛠️ **Admin actions** — approve, deny, and revoke buttons with loading states
- 🃏 **Request cards** — show status badge, requester email, namespace, workload, duration, reason, approver, and time-remaining countdown for active grants
- 🔄 **Auto-refresh** — polls every 10 seconds for live updates

#### 🔔 Frontend — Notification Badge & Admin Dropdown (`web/src/App.tsx`, `UserMenuDropdown.tsx`)

- 🟡 **Notification badge** — amber badge on admin avatar showing pending JIT request count (polled every 15s), with glow effect and `9+` overflow
- 📂 **Admin dropdown** — "Access Requests" entry added alongside "Online Users" and "Audit Trail" with inline pending count badge
- 🧹 **JIT tab removed** — Access Requests moved from sidebar tab to admin dropdown for cleaner navigation

#### 🔔 Frontend — Pod Detail Integration (`web/src/components/views/PodDetailView.tsx`)

- 🍞 **Toast notifications** — viewers receive color-coded toasts when their JIT request is approved (green), denied (red), or expired (amber)
- 📡 **Status polling** — `useEffect` hook polls JIT grants/requests and tracks state transitions via `prevJitState` ref
- 🎯 **Deployment-scoped checks** — JIT status checks now match on `namespace + ownerKind + ownerName`

#### 📦 Helm Chart

- ➕ **New values** — `jit.persistence.enabled` (default: `true`), `jit.retentionDays` (default: `7`)
- 🔧 **Environment variables** — `POD_NAMESPACE` (Downward API), `JIT_CONFIGMAP_NAME`, `JIT_RETENTION_DAYS`, `AUDIT_CONFIGMAP_NAME` injected conditionally when persistence is enabled
- 📐 **Values schema** — JSON schema updated with JIT configuration definitions
- 🏷️ **Chart version** bumped to `1.2.0`
- 📋 **ArtifactHub changelog** — `artifacthub.io/changes` annotation with 6 change entries
- 🔑 **Keywords** — added `jit-access` and `security`

#### 🔐 RBAC

- ➕ Added `create` verb for `configmaps` in both Helm ClusterRole and raw K8s manifests (required for JIT and audit ConfigMap persistence)

#### 📄 Raw Kubernetes Manifests (`deploy/k8s/`)

- `deployment.yaml` — added `POD_NAMESPACE`, `JIT_CONFIGMAP_NAME`, `AUDIT_CONFIGMAP_NAME` environment variables
- `rbac.yaml` — added `create` verb for `configmaps`

### 📚 Docs & Landing Page

- 🌐 **GitHub Pages landing page** — new `docs/index.html` with hero section, 12 feature cards (4×3 grid), screenshots, install command, and badges
- 🏷️ **CI badge** — added to README and landing page (links to GitHub Actions CI workflow)
- 🏷️ **ArtifactHub badge** — added to landing page
- 📖 **README** — new JIT feature section, updated feature comparison table, JIT config env vars table, updated RBAC section, updated tagline

### 🐛 Bug Fixes

- 🔧 **`.gitignore` fix** — `server` pattern was matching `cmd/server/` directory, preventing new files from being tracked; changed to `/server` to only match root-level compiled binary
- 🔧 **JIT exec fix** — `requireAdminOrJIT` now checks JIT grants even when auth is disabled (previously skipped JIT lookup entirely for non-admin roles)
- 🔧 **Node metrics panel** — shows "Prometheus not configured" message instead of silently hiding
- 📊 **Prometheus fallback** — node metrics now work with vanilla Prometheus (raw cadvisor queries alongside recording-rule queries)
- 📝 **Metrics-server logging** — errors from metrics-server API calls are now logged instead of silently discarded
- 🖥️ **TTY-aware banner** — startup ASCII banner only emits ANSI colors when stdout is a real terminal

---

## [v1.1.5] — 2026-04-03

### Helm Chart Hardening

- **Default replicas bumped to 2** with **topology spread constraint** and **pod anti-affinity** (soft, weight 100) to prefer scheduling replicas on different nodes
- **Pod security context** — Chart now enforces `runAsNonRoot`, `readOnlyRootFilesystem`, and drops all Linux capabilities by default, passing Pod Security Standards audits out of the box
- **Startup probe** added to prevent liveness kills during slow cluster API connections (10 retries x 5s)
- **Pod annotations** (`podAnnotations`) and **service annotations** (`service.annotations`) are now configurable via `values.yaml`

### CI/CD

- **PR CI workflow** — New `ci.yaml` runs `go vet`, `go build`, and frontend `npm run build` on every pull request
- **Release concurrency** — Overlapping tag builds are now automatically cancelled

### Polish

- `.dockerignore` updated to exclude `.github/` and `.cursor/` from build context
- `web/package.json` now declares `engines: { node: ">=20" }` for fast-fail on wrong Node versions
- **Accessibility** — Added `aria-label` and `aria-expanded` attributes to all icon-only buttons (sidebar, search, info, user menu)

---

## [v1.1.4] — 2026-04-02

### Security

- **Alpine base image upgraded from 3.19 → 3.21**, resolving 6 CVEs in busybox and ssl_client (CVE-2024-58251, CVE-2025-46394)

### Improvements

- **ArtifactHub** — Added values schema for configuration table, verified publisher metadata, and all 4 screenshots
- Updated project tagline across README and Helm chart

---

## [v1.1.3] — 2026-04-02

### Refactor

- **Backend restructured** — Split monolithic 7,000-line `main.go` into 20 domain-organized Go files under `cmd/server/` following idiomatic Go project layout
- **Frontend restructured** — Split 6,350-line `App.tsx` into 40 TypeScript files organized by concern (types, hooks, components, views, layout)
- **Dockerfile updated** to build from `cmd/server/`
- **ArtifactHub listing** — Chart now includes README, annotations, and maintainer metadata
- Zero logic changes — pure structural split, compiled output is identical

---

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
