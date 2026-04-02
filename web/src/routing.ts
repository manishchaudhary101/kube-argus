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
export type TabId = typeof TABS[number]['id']

export function parseRoute(): { tab: TabId; pod: { ns: string; name: string } | null; node: string | null; ingress: { ns: string; name: string } | null; workload: { ns: string; name: string; kind: string } | null; nodePool: string } {
  const p = window.location.pathname.replace(/^\/+|\/+$/g, '')
  const segs = p.split('/')
  const sp = new URLSearchParams(window.location.search)
  const nodePool = sp.get('pool') || ''
  const validTabs = TABS.map(t => t.id) as string[]
  if (segs[0] === 'pods' && segs.length === 3) return { tab: 'pods', pod: { ns: segs[1], name: segs[2] }, node: null, ingress: null, workload: null, nodePool }
  if (segs[0] === 'nodes' && segs.length === 2) return { tab: 'nodes', pod: null, node: segs[1], ingress: null, workload: null, nodePool }
  if (segs[0] === 'ingress' && segs.length === 3) return { tab: 'ingress', pod: null, node: null, ingress: { ns: segs[1], name: segs[2] }, workload: null, nodePool }
  if (segs[0] === 'workloads' && segs.length === 4) {
    const kindMap: Record<string, string> = { deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet', job: 'Job', cronjob: 'CronJob' }
    const rawKind = segs[1]
    const canonKind = kindMap[rawKind.toLowerCase()] || rawKind
    return { tab: 'workloads', pod: null, node: null, ingress: null, workload: { ns: segs[2], name: segs[3], kind: canonKind }, nodePool }
  }
  if (validTabs.includes(segs[0])) return { tab: segs[0] as TabId, pod: null, node: null, ingress: null, workload: null, nodePool }
  return { tab: 'overview', pod: null, node: null, ingress: null, workload: null, nodePool: '' }
}
