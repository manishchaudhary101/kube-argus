import { useRef, useEffect } from 'react'

export const TABS = [
  { id: 'overview', label: 'Overview', icon: '⬡' },
  { id: 'nodes', label: 'Nodes', icon: '⬢' },
  { id: 'workloads', label: 'Workloads', icon: '▣' },
  { id: 'pods', label: 'Pods', icon: '◉' },
  { id: 'services', label: 'Services', icon: '⇌' },
  { id: 'ingress', label: 'Ingress', icon: '↗' },
  { id: 'hpa', label: 'HPA', icon: '⟳' },
  { id: 'pvcs', label: 'PV & PVCs', icon: '▤' },
  { id: 'config', label: 'Config & Secrets', icon: '⬔' },
  { id: 'spot', label: 'Spot Advisor', icon: '◎' },
  { id: 'events', label: 'Events', icon: '◷' },
  { id: 'troubled', label: 'Troubled', icon: '⚠' },
  { id: 'topology', label: 'Topology', icon: '◈' },
] as const

// ─── Info Popover ───────────────────────────────────────────────────

export const TAB_DETAIL: Record<string, { desc: string; actions: string[]; tips: string[] }> = {
  overview: {
    desc: 'Cluster health at a glance — node status, resource pressure, warning counts, and top resource consumers.',
    actions: ['View node Ready/NotReady/Draining status', 'See cluster-wide CPU & memory utilisation', 'Spot resource-hungry workloads instantly', 'Collapse/expand individual panels'],
    tips: ['Nodes turn amber when cordoned or draining', 'Click any node row to jump to its detail view'],
  },
  nodes: {
    desc: 'All nodes with status, instance type, capacity, allocatable resources, and age.',
    actions: ['Sort by any column (persists across refreshes)', 'Click a node for kubectl-describe-style detail', 'View Karpenter/system events on each node', 'Check Prometheus CPU, memory, disk, and network metrics per node'],
    tips: ['Instance type comes from the node.kubernetes.io/instance-type label', 'Node events show spot interruptions, drain failures, and pressure transitions'],
  },
  workloads: {
    desc: 'Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs in one filterable list.',
    actions: ['Filter by kind using the pill buttons', 'Click any workload for a full detail view', 'View ReplicaSets (last 5) inside Deployments', 'See Prometheus CPU & memory metrics with time range selector', 'Check resource right-sizing recommendations (7-day average)', 'Explore dependency graph — HPA, Services, Ingress, ConfigMaps linked to the workload', 'PDB status badge shown inline on each workload row'],
    tips: ['Right-sizing uses 7-day average usage for requests and max for limits', 'Dependency graph cards are clickable — they navigate to the linked resource'],
  },
  pods: {
    desc: 'All pods with phase, restarts, resource usage bars, node placement, and age.',
    actions: ['Click any pod for logs, events, and container details', 'Stream logs with container selector (includes init containers)', 'View CPU & memory metrics per pod with request/limit reference lines', 'AI-powered diagnosis for unhealthy pods'],
    tips: ['Resource bars turn red only when usage hits the limit', 'Init containers appear with an amber badge in the pod detail view'],
  },
  services: {
    desc: 'ClusterIP, NodePort, and LoadBalancer services with type, ports, and cluster IP.',
    actions: ['View all ports and target ports', 'See external IPs for LoadBalancer services'],
    tips: ['Filter by namespace using the namespace picker in the header'],
  },
  ingress: {
    desc: 'Ingress rules with hosts, paths, TLS status, and backend service mappings.',
    actions: ['Click any ingress for a detailed rule breakdown', 'See which services and ports each path routes to'],
    tips: ['TLS-enabled ingresses show a lock indicator'],
  },
  hpa: {
    desc: 'Horizontal Pod Autoscalers with current/desired/max replicas and scaling metrics.',
    actions: ['See CPU and memory target utilisation vs current', 'View min and max replica bounds'],
    tips: ['HPA metrics show both percentage and absolute values when available'],
  },
  pvcs: {
    desc: 'PersistentVolumeClaims, PersistentVolumes, and StorageClasses across the cluster.',
    actions: ['View PVC status (Bound/Pending/Lost) with workload mapping', 'Identify orphaned PVs (Available/Released with no claim)', 'Click any PVC row to see bound PV details and source', 'Browse StorageClasses with provisioner and reclaim policy'],
    tips: ['Pending PVCs are sorted to the top for quick identification', 'Filter by namespace using the namespace picker'],
  },
  config: {
    desc: 'ConfigMaps and Secrets with data key counts and last-modified timestamps.',
    actions: ['Toggle between ConfigMaps and Secrets', 'See when each resource was last modified', 'View data keys and values (Secrets are masked)'],
    tips: ['All items show a subtle "modified X ago" timestamp', 'Filter by namespace to narrow down results'],
  },
  spot: {
    desc: 'Spot instance advisor with intelligent consolidation suggestions and cost allocation.',
    actions: ['View total cluster cost breakdown', 'See namespace-level cost allocation', 'See nodepool-level cost allocation', 'Get consolidation suggestions (e.g. replace smaller nodes with fewer larger ones)'],
    tips: ['Cost estimates are based on on-demand pricing for the instance types in use', 'Switch between Namespace and Nodepool cost views using tabs'],
  },
  events: {
    desc: 'Cluster events with type, reason, source, message, count, and age.',
    actions: ['Filter by namespace', 'See Warning vs Normal event types', 'View event count for repeated occurrences'],
    tips: ['Events auto-refresh with the cluster data polling cycle'],
  },
  troubled: {
    desc: 'Non-running pods aggregated in one view — CrashLoopBackOff, ImagePullBackOff, Pending, OOMKilled, etc.',
    actions: ['Fullscreen mode for dedicated monitoring screens', 'Click any pod to see its detail and logs', 'AI diagnosis available for each troubled pod'],
    tips: ['Great for wall-mounted dashboards — use fullscreen to remove browser chrome', 'Shows node IP for quick identification of affected nodes'],
  },
  topology: {
    desc: 'Topology spread constraint analysis — checks if workloads respect their spread rules.',
    actions: ['See violations grouped by topology key (zone, hostname, instance-type)', 'View actual pod distribution vs expected spread', 'Check if constraints are soft (ScheduleAnyway) or hard (DoNotSchedule)'],
    tips: ['Only workloads with topologySpreadConstraints defined are analysed', '"At limit" means the skew equals maxSkew — one more imbalanced pod would violate the constraint'],
  },
}

export function InfoPopover({ tab, onClose }: { tab: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const currentTab = TABS.find(t => t.id === tab)
  const info = TAB_DETAIL[tab]
  return (
    <div ref={ref} className="absolute right-0 top-full mt-2 w-96 rounded-xl border border-hull-600 bg-hull-950 shadow-2xl shadow-black/60 z-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-hull-700/30">
        <p className="text-[11px] font-bold text-white">{currentTab?.icon} {currentTab?.label}</p>
        <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">{info?.desc}</p>
      </div>
      {info && (
        <div className="px-4 py-3 max-h-[60vh] overflow-y-auto space-y-3">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-wider text-neon-cyan/70 mb-1.5">What you can do</p>
            <ul className="space-y-1">
              {info.actions.map((a, i) => (
                <li key={i} className="text-[10px] text-gray-400 leading-relaxed flex gap-2">
                  <span className="text-hull-500 shrink-0 mt-px">›</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[9px] font-bold uppercase tracking-wider text-neon-amber/70 mb-1.5">Tips</p>
            <ul className="space-y-1">
              {info.tips.map((t, i) => (
                <li key={i} className="text-[10px] text-gray-500 leading-relaxed flex gap-2">
                  <span className="text-neon-amber/50 shrink-0 mt-px">*</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-hull-700/30 pt-3">
            <p className="text-[9px] font-bold uppercase tracking-wider text-gray-600 mb-1.5">All Sections</p>
            <div className="grid grid-cols-2 gap-1">
              {TABS.map(t => (
                <div key={t.id} className={`text-[10px] py-0.5 ${t.id === tab ? 'text-neon-cyan font-medium' : 'text-gray-600'}`}>
                  <span className="inline-block w-4 text-center mr-1">{t.icon}</span>{t.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
