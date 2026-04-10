# Changelog

All notable changes to Kube-Argus will be documented in this file.

## [v1.2.5] — 2026-04-10

### ⭐ New Features

#### Slack Notifications for JIT Access Requests
Get notified in Slack when someone requests JIT access, with interactive **Approve** and **Deny** buttons directly in the message.

- **Incoming Webhook** — sends Block Kit messages with requester, resource, duration, reason, and cluster name
- **Interactive buttons** — admins approve or deny from Slack; the original message updates to show the result
- **Signing secret verification** — Slack request signatures validated via HMAC-SHA256 to prevent spoofing
- **Dashboard Settings** — configure webhook URL and signing secret from the UI (Settings modal in admin menu), or via `SLACK_WEBHOOK_URL` / `SLACK_SIGNING_SECRET` env vars
- **ConfigMap persistence** — settings stored in `kube-argus-settings` ConfigMap, surviving pod restarts

#### Node Allocated Resources
Node detail view now shows **pod requests and limits** as a percentage of allocatable capacity, matching `kubectl describe node` output.

- Two side-by-side resource cards (CPU and Memory) showing usage bar, requests, and limits
- Color-coded overcommit warnings (amber >80%, red >100%)
- Calculation matches kubectl — uses `max(init, regular)` per pod per resource

#### Pod Log Viewer Enhancements
- **Search/filter** within log output with match highlighting
- **Configurable tail size** — 100, 300, or 1,000 lines
- **Error highlighting** — lines containing ERROR, WARN, or FATAL are color-coded with theme-aware backgrounds

### ⚡ Performance

- **Code splitting** — all views lazy-loaded via `React.lazy()` with manual chunk splitting for react-dom and recharts
- **SWR client cache** — 30-second stale-while-revalidate cache eliminates loading flicker on view revisits
- **Prometheus query cache** — 30-second TTL in-memory cache with automatic eviction above 200 entries
- **Pre-computed lookup maps** — pod-to-deployment resolution is now O(1) via maps built once per cache refresh
- **Memoized components** — MetricChart and RestartTimeline wrapped with `React.memo()`

### 🔧 Improvements

- **Online Users** — expanded from 5-minute to 24-hour window with Online / Away / Offline status groups
- **Audit trail** — immediate persistence (was 60-second batch), "Access Requests" filter tab, configurable retention via `AUDIT_RETENTION_DAYS`
- **Light theme** — darker saturated chart colors, smooth 300ms theme transitions, softened shadows
- **Helm chart** — image tag now defaults to `Chart.appVersion` instead of `latest`, pullPolicy changed to `IfNotPresent`
- **JIT refactoring** — extracted `jitApprove()`/`jitDeny()` for reuse by both HTTP API and Slack handler, consistent resource strings in audit records

### 🐛 Fixes

- **JSON error responses** — all API endpoints now return `{"error":"..."}` instead of plain text, fixing `Unexpected token` parse errors on the frontend
- **404 for missing resources** — terminated nodes, deleted pods, and removed workloads now return 404 instead of 500
- **False login events** — audit trail no longer records "session resume" as a login when users return after inactivity
- **Settings modal** — Save button works on first setup (not just when changing existing values)
- **Cache noise** — `kube-root-ca.crt` ConfigMaps and `helm.sh/` Secrets filtered from config metadata

---

## [v1.2.4] — 2026-04-07

### ⭐ New Features

#### Workload Restart with JIT Access
Restart is no longer limited to Deployments — **StatefulSets** and **DaemonSets** can now be restarted too. Viewers can request restart access through the existing JIT approval flow.

- **Admin** — clicks "Restart" directly on any Deployment, StatefulSet, or DaemonSet
- **Viewer** — clicks "Request Restart" → JIT modal → admin approves → restart button appears
- **Audit trail** — every restart is recorded with actor, role, workload kind, namespace, and name
- **Scale remains admin-only** — no change to scaling behavior

#### Light Theme Redesign
Complete overhaul of the light ("Notion") theme with a fresh, modern color palette designed natively for light surfaces.

| Role | Old | New |
|------|-----|-----|
| Primary | Indigo-600 (deep purple) | **Blue-600** (bright blue) |
| Success | Green-700 (dark forest) | **Emerald-600** (jewel green) |
| Warning | Orange-700 (burnt orange) | **Amber-700** (golden amber) |
| Error | Red-700 (brick red) | **Rose-600** (vibrant rose) |
| Action | Blue-600 | **Violet-600** (rich purple) |

- Cool slate backgrounds replace warm cream tones
- Neutral zinc grays replace warm stone grays
- All derivative colors updated: glows, borders, hovers, gradients, progress bars, chart reference lines, terminal theme, aggregated log colors, restart timeline

### 🐛 Fixes

- **Auth crash (502)** — `authLogin` and `authCallback` now return a 500 error with a clear message when OIDC is not configured, instead of panicking with a nil pointer dereference
- **Duplicate secrets load** — removed redundant `loadSecretsFromAWS()` call inside `initAuth()` that logged a confusing `count: 0`
- **Contextual JIT buttons** — "Request Access" buttons now use specific labels: "Request Shell Access" (pods), "Request Trigger Access" (CronJobs), "Request Restart" (workloads)
- **CronJob modal page shift** — JIT modal no longer pushes page content down when opened (moved outside `space-y-3` container)
- **Vite security** — upgraded from `^8.0.0` to `8.0.5` (fixes CVE in affected versions 8.0.0–8.0.4)

---

## [v1.2.3] — 2026-04-06

### ⭐ New Features

#### Service Detail View
Click any Service in the resource graph to see its full details — type, ClusterIP, ports table, selector labels, endpoint pods (clickable), labels, and annotations.

#### HPA Detail View
Click any HPA in the resource graph to see target workload, min/max/current/desired replicas, metrics table with current vs target values, and conditions.

#### Resource Graph Click-Through
- **Service** → opens Service detail view
- **HPA** → opens HPA detail view
- **ConfigMap/Secret** → opens Config view pre-filtered by namespace and name
- **PDB** → info shown inline (no detail view)

### 🐛 Fixes
- **CronJob detail crash** — fixed blank screen when opening a CronJob with no job history (`data.runs` null safety)
- **Restart timeline OOMKilled** — `OOMKilling` events now correctly map to `OOMKilled` and show as red dots
- **JIT modal titles** — "Request CronTrigger Access" for CronJobs, "Request Pod Shell/Exec Access" for pods
- **Request Access button consistency** — CronJob and pod detail views now use the same amber button styling

## [v1.2.2] — 2026-04-05

### ⭐ Namespace Favorites

Pin your most-used namespaces to the top of the namespace picker. Click the star icon next to any namespace — favorites persist per-user in your browser across sessions. Works across all views (pods, workloads, services, events, etc.).

### ⏱️ CronJob Manual Trigger

New **"▶ Run Now"** button on the CronJob detail view. Creates a one-off Job from the CronJob's template — no more `kubectl create job --from=cronjob/...` in the terminal.

- 🔓 **Admins** can trigger directly
- 🔒 **Viewers** need JIT approval first (scoped to the specific CronJob)
- 📝 Every trigger is recorded in the audit trail
- 🔗 Created Jobs appear in the CronJob's execution history with owner references

### 🕐 Custom JIT Duration

The JIT access request modal now supports **custom durations** alongside the preset 30m / 1h / 2h / 4h buttons. Enter any value in hours or days, up to a maximum of 7 days. Applies to both pod exec access and CronJob trigger access.

### 📊 Pod Restart Timeline

A new **color-coded scatter chart** showing individual restart events over time, visible on both the Pod Detail View and Workload Detail View.

- 🔴 **Red** dots = OOMKilled
- 🟡 **Amber** dots = Liveness/readiness probe failures
- ⚪ **Gray** dots = Other reasons (Error, Completed, etc.)
- 🔍 Hover any dot to see timestamp, container name, reason, and exit code
- ⏰ Selectable time range: 1h, 6h, 12h, 24h
- 📡 Uses Prometheus as primary data source, falls back to K8s events + container status when Prometheus is unavailable

### 📦 Init Container Visibility

All workload types (Deployment, StatefulSet, DaemonSet, CronJob, Job, ReplicaSet) now display **init containers** in the Containers tab with an amber **INIT** badge. Previously only regular containers were shown. Container info (resources, ports, env count) is now standardized across all workload types.

### 🐛 Fixes

- **JIT restore log spam** — The `jit: restored requests from configmap` message that repeated every 30 seconds is now logged at DEBUG level instead of INFO

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
