import { useState, useEffect, useCallback, useRef, createContext, useContext, useMemo } from 'react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts'

// ─── Auth Context ────────────────────────────────────────────────────
type UserInfo = { email: string; role: string; authMode: string }
const AuthCtx = createContext<UserInfo>({ email: 'anonymous', role: 'viewer', authMode: 'none' })
const useAuth = () => useContext(AuthCtx)

// ─── Types ──────────────────────────────────────────────────────────
type NodeInfo = { name: string; ready: boolean; status: string; role: string; nodepool: string; instanceType: string; age: string; ageSec: number; version: string; internalIP: string; cordoned: boolean; allocCpuM: number; allocMemMi: number; usedCpuM: number; usedMemMi: number; cpuPercent: number; memPercent: number; pods: number }
type OverviewData = {
  nodes: NodeInfo[]; nodesReady: number; nodesTotal: number
  pods: { running: number; pending: number; failed: number; succeeded: number; total: number }
  deployments: { ready: number; total: number }; namespaces: number
  cacheAgeMs?: number
  cluster?: { cpuCapacityM: number; memCapacityMi: number; cpuAllocatableM: number; memAllocatableMi: number; cpuUsedM: number; memUsedMi: number }
  counts?: { services: number; ingresses: number; statefulsets: number; daemonsets: number; jobs: number; cronjobs: number }
  topNamespaces?: { ns: string; pods: number }[]
  warnings?: { type: string; reason: string; object: string; message: string; age: string; ns: string }[]
}
type NodeDetail = { name: string; ready: boolean; cordoned: boolean; nodepool: string; age: string; allocCpuM: number; allocMemMi: number; usedCpuM: number; usedMemMi: number; pods: number; podCapacity: number; instanceType: string; zone: string; capacityType: string; arch: string; kubelet: string; runtime: string; internalIp: string; taints: number; conditions: string[] }
type Workload = { kind: string; name: string; namespace: string; ready: number; desired: number; age: string; images: string; pdb?: { name: string; status: string; disruptionsAllowed: number }; cpuReqM: number; cpuLimM: number; cpuUsedM: number; memReqMi: number; memLimMi: number; memUsedMi: number }
type Pod = { name: string; namespace: string; status: string; restarts: number; age: string; node: string; ready: string; cpuReqM: number; cpuLimM: number; cpuUsedM: number; memReqMi: number; memLimMi: number; memUsedMi: number; cpuSizing: string; memSizing: string }
type Evt = { type: string; reason: string; message: string; age: string; count: number }
type ContainerInfo = { name: string; image: string; ready: boolean; state: string; reason: string; message: string; restarts: number; started: boolean; cpuReqM: number; cpuLimM: number; cpuUsedM: number; memReqMi: number; memLimMi: number; memUsedMi: number }
type PodDescribe = { name: string; namespace: string; node: string; status: string; ip: string; qos: string; age: string; containers: ContainerInfo[]; initContainers?: ContainerInfo[]; conditions: { type: string; status: string; reason: string; message: string }[] }
type IngressRule = { host: string; path: string; backend: string; port: string }
type Ingress = { name: string; namespace: string; class: string; hosts: string[]; addresses: string[]; tls: boolean; rules: IngressRule[]; age: string }
type IngressDescData = {
  name: string; namespace: string; class: string; age: string; defaultBackend: string
  tls: { hosts: string[]; secretName: string }[]
  rules: { host: string; path: string; pathType: string; backend: string; port: string }[]
  addresses: string[]
  annotations: Record<string, string>; labels: Record<string, string>
  events: { type: string; reason: string; message: string; age: string; count: number }[]
}
type Service = { name: string; namespace: string; type: string; clusterIP: string; externalIP: string; ports: string; age: string; selector: string }
type ClusterEvent = { type: string; reason: string; object: string; kind: string; message: string; age: string; count: number; namespace: string }
type SearchResult = { kind: string; name: string; namespace: string }
type HPAMetric = { name: string; type: string; current: string; target: string }
type HPACondition = { type: string; status: string; reason: string; message: string }
type HPA = { name: string; namespace: string; reference: string; minReplicas: number; maxReplicas: number; currentReplicas: number; desiredReplicas: number; metrics: HPAMetric[]; conditions: HPACondition[]; age: string }
type ConfigItem = { kind: string; name: string; namespace: string; keys: string[]; keyCount: number; type?: string; age: string; modifiedAgo: string; recentChange: boolean }
type ConfigDataResp = { kind: string; name: string; namespace: string; entries: { key: string; value: string }[]; masked: boolean }
type SpotAlternative = { instanceType: string; vcpus: number; memoryGB: number; interruptRange: number; interruptLabel: string; savingsPct: number; spotPrice: number; nodesNeeded: number; totalMonthlyCost: number; monthlySaving: number; fitNote: string; score: number }
type SpotCurrent = { instanceType: string; count: number; vcpus: number; memoryGiB: number; interruptRange: number; interruptLabel: string; savingsPct: number; spotPrice: number; monthlyCost: number; totalMonthlyCost: number; nodepools: string[]; totalUsedCpuM: number; totalUsedMemMi: number; totalReqCpuM: number; totalReqMemMi: number; totalAllocCpuM: number; totalAllocMemMi: number; avgCpuPct: number; avgMemPct: number; effectiveCpuM: number; effectiveMemMi: number }
type SpotConsolidation = { instanceType: string; vcpus: number; memoryGB: number; interruptRange: number; interruptLabel: string; spotPrice: number; nodesNeeded: number; replacesNodes: number; replacesTypes: string[]; totalMonthlyCost: number; monthlySaving: number; reason: string; score: number }
type SpotRecommendation = { current: SpotCurrent; alternatives: SpotAlternative[] }
type ClusterCostData = { totalNodes: number; spotNodes: number; onDemandNodes: number; spotMonthlyCost: number; onDemandMonthlyCost: number; totalMonthlyCost: number; onDemandByType: { instanceType: string; count: number }[] }
type SpotAdvisorData = { ready: boolean; message?: string; region: string; totalSpotNodes: number; recommendations: SpotRecommendation[]; consolidations?: SpotConsolidation[]; totalEffectiveCpuM?: number; totalEffectiveMemMi?: number; lastRefresh: string; clusterCost?: ClusterCostData }
type NodeEvent = { type: string; reason: string; age: string; from: string; message: string; count: number }
type NodeDescData = {
  name: string; status: string; role: string; age: string; version: string; cordoned: boolean
  addresses: { type: string; address: string }[]
  conditions: { type: string; status: string; reason: string; message: string; age: string }[]
  taints: { key: string; value: string; effect: string }[]
  capacity: { cpu: string; memory: string; pods: string }
  allocatable: { cpu: string; memory: string; pods: string }
  systemInfo: { os: string; arch: string; kernel: string; containerRuntime: string; kubelet: string; kubeProxy: string; osImage: string }
  labels: Record<string, string>
  images: { names: string[]; size: number }[]
  pods: { name: string; namespace: string; status: string; ready: string; age: string }[]
  events?: NodeEvent[]
  usedCpuM: number; usedMemMi: number; allocCpuM: number; allocMemMi: number; cpuPercent: number; memPercent: number
}

// ─── Hooks ──────────────────────────────────────────────────────────
function useFetch<T>(url: string | null, ms = 0) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refetch = useCallback(() => {
    if (!url) return
    fetch(url).then(async r => {
      if (r.status === 401) { window.location.href = '/auth/login'; return }
      if (!r.ok) {
        const body = await r.text().catch(() => r.statusText)
        try { const j = JSON.parse(body); throw new Error(j.error || body) } catch (e: any) { if (e.message) throw e; throw new Error(body) }
      }
      return r.json()
    }).then(d => { if (d !== undefined) { setData(d); setErr(null) } }).catch(e => setErr(e.message || String(e))).finally(() => setLoading(false))
  }, [url])
  useEffect(() => {
    if (!url) { setLoading(false); return }
    refetch()
    const id = ms > 0 ? setInterval(refetch, ms) : undefined
    return () => { if (id) clearInterval(id) }
  }, [url, ms, refetch])
  return { data, err, loading, refetch }
}

async function post(url: string) {
  const r = await fetch(url, { method: 'POST' })
  if (r.status === 401) { window.location.href = '/auth/login'; throw new Error('unauthorized') }
  if (r.status === 403) {
    const body = await r.json().catch(() => ({ message: 'forbidden' }))
    throw new Error(body.message || 'admin access required')
  }
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

function useFullscreen() {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const enter = useCallback(() => {
    if (ref.current?.requestFullscreen) {
      ref.current.requestFullscreen().then(() => setActive(true)).catch(() => {})
    }
  }, [])
  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().then(() => setActive(false)).catch(() => {})
    else setActive(false)
  }, [])
  useEffect(() => {
    const h = () => setActive(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])
  return { ref, active, enter, exit }
}

const FullscreenBtn = ({ active, onEnter, onExit }: { active: boolean; onEnter: () => void; onExit: () => void }) => (
  <button
    onClick={(e) => { e.stopPropagation(); active ? onExit() : onEnter() }}
    className="rounded-md p-1 text-gray-500 hover:text-neon-cyan hover:bg-hull-700/50 transition-all"
    title={active ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
  >
    {active ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
    )}
  </button>
)

// ─── UI Atoms ───────────────────────────────────────────────────────
const Pill = ({ children, color }: { children: React.ReactNode; color: string }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}>{children}</span>
)


const StatusDot = ({ ok }: { ok: boolean }) => (
  <span className={`inline-block h-2.5 w-2.5 rounded-full ring-2 ${ok ? 'bg-neon-green ring-green-500/20 shadow-[0_0_8px_rgba(0,255,136,0.5)]' : 'bg-neon-red ring-red-500/20 shadow-[0_0_8px_rgba(255,51,85,0.5)]'}`} />
)

const Btn = ({ children, onClick, variant = 'default', disabled, small }: { children: React.ReactNode; onClick: () => void; variant?: 'default' | 'danger' | 'success' | 'primary'; disabled?: boolean; small?: boolean }) => {
  const base = small ? 'px-2.5 py-1 text-[10px]' : 'px-3 py-1.5 text-xs'
  const colors = {
    default: 'bg-hull-700/80 text-gray-300 hover:bg-hull-600 border-hull-600',
    danger: 'bg-red-950/40 text-neon-red border-red-900/40 hover:bg-red-900/30 hover:shadow-[0_0_12px_rgba(255,51,85,0.15)]',
    success: 'bg-green-950/40 text-neon-green border-green-900/40 hover:bg-green-900/30 hover:shadow-[0_0_12px_rgba(0,255,136,0.15)]',
    primary: 'bg-cyan-950/40 text-neon-cyan border-cyan-900/40 hover:bg-cyan-900/30 hover:shadow-[0_0_12px_rgba(6,214,224,0.15)]',
  }
  return <button onClick={onClick} disabled={disabled} className={`${base} rounded-lg border font-medium transition-all duration-200 disabled:opacity-30 ${colors[variant]}`}>{children}</button>
}

const SizingBadge = ({ resource, sizing }: { resource: string; sizing: string }) => {
  if (sizing === 'ok') return <span className="rounded-full bg-green-950/40 border border-green-900/20 px-1.5 py-0.5 text-[9px] font-medium text-neon-green">{resource} ✓</span>
  if (sizing === 'over') return <span className="rounded-full bg-amber-950/40 border border-amber-900/20 px-1.5 py-0.5 text-[9px] font-medium text-neon-amber">{resource} ↑ over</span>
  if (sizing === 'under') return <span className="rounded-full bg-red-950/40 border border-red-900/20 px-1.5 py-0.5 text-[9px] font-medium text-neon-red">{resource} ↓ under</span>
  return null
}

const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="relative h-8 w-8">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
      <div className="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-b-neon-green" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
    </div>
  </div>
)

const MiniStat = ({ label, value, sub, color = 'text-white', icon, onClick }: { label: string; value: string | number; sub?: string; color?: string; icon: string; onClick?: () => void }) => (
  <div className={`stat-card p-3 anim-in ${onClick ? 'cursor-pointer active:scale-95 transition-transform' : ''}`} onClick={onClick}>
    <div className="flex items-start justify-between">
      <span className="text-lg opacity-60">{icon}</span>
      <span className={`text-xl font-bold tabular-nums ${color}`}>{value}</span>
    </div>
    <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
    {sub && <p className="text-[9px] text-gray-600 mt-0.5">{sub}</p>}
  </div>
)


const UserAvatar = ({ email }: { email: string }) => {
  const initials = email.split('@')[0].split('.').map(p => p[0]?.toUpperCase()).join('').slice(0, 2)
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-neon-cyan/20 to-neon-green/10 text-[10px] font-bold text-neon-cyan ring-1 ring-neon-cyan/20">{initials}</div>
  )
}

// ─── Search Modal ───────────────────────────────────────────────────
function SearchModal({ onClose, onSelect }: { onClose: () => void; onSelect: (r: SearchResult) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { inputRef.current?.focus() }, [])

  const doSearch = useCallback((q: string) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
  }, [])

  const handleInput = (v: string) => {
    setQuery(v)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(v), 300)
  }

  const kindIcon = (k: string) => {
    switch (k) {
      case 'Pod': return '◉'
      case 'Deployment': return '▣'
      case 'Service': return '⇌'
      case 'Ingress': return '↗'
      case 'Node': return '⬢'
      default: return '●'
    }
  }
  const kindColor = (k: string) => {
    switch (k) {
      case 'Pod': return 'text-neon-green'
      case 'Deployment': return 'text-neon-cyan'
      case 'Service': return 'text-indigo-400'
      case 'Ingress': return 'text-indigo-300'
      case 'Node': return 'text-neon-amber'
      default: return 'text-gray-400'
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-hull-950/95 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-auto w-full max-w-lg px-4 pt-12" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 rounded-lg border border-hull-600 bg-hull-900 px-3 py-2">
          <span className="text-gray-500">⌕</span>
          <input ref={inputRef} type="text" value={query} onChange={e => handleInput(e.target.value)} placeholder="Search pods, deployments, services, nodes…" className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-gray-600" />
          {loading && <div className="h-4 w-4 animate-spin rounded-full border-2 border-hull-600 border-t-neon-cyan" />}
          <button onClick={onClose} className="text-xs text-gray-600 hover:text-gray-400">ESC</button>
        </div>
        <div className="mt-2 max-h-[60vh] overflow-auto rounded-lg border border-hull-700 bg-hull-900">
          {query.length < 2 && <p className="p-4 text-center text-xs text-gray-600">Type at least 2 characters</p>}
          {query.length >= 2 && results.length === 0 && !loading && <p className="p-4 text-center text-xs text-gray-600">No results</p>}
          {results.map((r, i) => (
            <button key={i} onClick={() => { onSelect(r); onClose() }} className="flex w-full items-center gap-3 border-b border-hull-800 px-4 py-3 text-left transition-colors hover:bg-hull-800 active:bg-hull-700 last:border-0">
              <span className={`text-lg ${kindColor(r.kind)}`}>{kindIcon(r.kind)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{r.name}</p>
                <p className="text-[10px] text-gray-600">{r.kind}{r.namespace ? ` · ${r.namespace}` : ''}</p>
              </div>
              <span className="text-gray-700">›</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── k9s-style bar for CPU/MEM ──────────────────────────────────────
const K9sBar = ({ pct, large }: { pct: number; large?: boolean }) => {
  const filled = Math.round(Math.min(pct, 100) / 5)
  const empty = 20 - filled
  const color = pct > 80 ? 'text-neon-red' : pct > 50 ? 'text-neon-amber' : 'text-neon-green'
  return (
    <span className={`font-mono leading-none ${large ? 'text-sm' : 'text-[11px]'}`}>
      <span className={color}>{'█'.repeat(filled)}</span>
      <span className="text-hull-700">{'░'.repeat(empty)}</span>
    </span>
  )
}

// ─── Flash cell: wraps a <td> that flashes on change ────────────────
function Celld({ k, changed, className, children }: { k: string; changed: Set<string>; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLTableCellElement>(null)
  useEffect(() => {
    if (!changed.has(k) || !ref.current) return
    ref.current.classList.remove('k9s-changed')
    void ref.current.offsetWidth
    ref.current.classList.add('k9s-changed')
  }, [k, changed])
  return <td ref={ref} className={className}>{children}</td>
}

// ─── Overview (k9s Node View style) ─────────────────────────────────

function OverviewView({ onNodeTap, onTab }: { onNodeTap: (n: string) => void; onTab: (t: string, kind?: string) => void }) {
  const { data, err, loading } = useFetch<OverviewData>('/api/overview', 10000)
  const prevRef = useRef<OverviewData | null>(null)
  const [changed, setChanged] = useState<Set<string>>(new Set())
  const podTrend = useRef<Map<string, 'up' | 'down' | null>>(new Map())
  const nodeFs = useFullscreen()
  type SortCol = 'name' | 'status' | 'nodepool' | 'type' | 'age' | 'version' | 'ip' | 'pods' | 'cpu' | 'mem'
  const [sortCol, setSortCol] = useState<SortCol>(() => {
    try { return (localStorage.getItem('ov-sort-col') as SortCol) || 'name' } catch { return 'name' }
  })
  const [sortAsc, setSortAsc] = useState(() => {
    try { return localStorage.getItem('ov-sort-asc') !== 'false' } catch { return true }
  })
  const toggleSort = (col: SortCol) => {
    if (sortCol === col) {
      const next = !sortAsc
      setSortAsc(next)
      try { localStorage.setItem('ov-sort-asc', String(next)) } catch {}
    } else {
      const asc = col === 'name'
      setSortCol(col); setSortAsc(asc)
      try { localStorage.setItem('ov-sort-col', col); localStorage.setItem('ov-sort-asc', String(asc)) } catch {}
    }
  }

  useEffect(() => {
    if (!data || !prevRef.current) { prevRef.current = data; return }
    const prev = prevRef.current
    const diffs = new Set<string>()

    const pp = prev.pods, cp = data.pods
    if (pp.total !== cp.total) diffs.add('c:pods')
    if (pp.running !== cp.running) diffs.add('c:run')
    if (pp.pending !== cp.pending) diffs.add('c:pend')
    if (pp.failed !== cp.failed) diffs.add('c:fail')
    if (prev.nodesReady !== data.nodesReady || prev.nodesTotal !== data.nodesTotal) diffs.add('c:nodes')
    if (prev.deployments.ready !== data.deployments.ready || prev.deployments.total !== data.deployments.total) diffs.add('c:deploy')
    if (prev.namespaces !== data.namespaces) diffs.add('c:ns')

    const prevMap = new Map(prev.nodes.map(n => [n.name, n]))
    const newTrends = new Map(podTrend.current)
    for (const n of data.nodes) {
      const o = prevMap.get(n.name)
      if (!o) { diffs.add(`n:${n.name}:row`); continue }
      if (o.status !== n.status) diffs.add(`n:${n.name}:status`)
      if (o.pods !== n.pods) {
        diffs.add(`n:${n.name}:pods`)
        newTrends.set(n.name, n.pods > o.pods ? 'up' : 'down')
      }
      if (o.cpuPercent !== n.cpuPercent) { diffs.add(`n:${n.name}:cpu`); diffs.add(`n:${n.name}:cpuPct`) }
      if (o.memPercent !== n.memPercent) { diffs.add(`n:${n.name}:mem`); diffs.add(`n:${n.name}:memPct`) }
      if (o.cordoned !== n.cordoned) diffs.add(`n:${n.name}:status`)
    }
    podTrend.current = newTrends

    prevRef.current = data
    if (diffs.size > 0) {
      setChanged(diffs)
      setTimeout(() => { setChanged(new Set()); podTrend.current = new Map() }, 3000)
    }
  }, [data])

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  if (!data) return null
  const p = data.pods

  const statusColor = (s: string) => {
    if (s.includes('SchedulingDisabled')) return 'text-neon-amber'
    if (s === 'Ready') return 'text-neon-green'
    return 'text-neon-red'
  }


  const sortedNodes = [...data.nodes].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'status': cmp = a.status.localeCompare(b.status); break
      case 'nodepool': cmp = a.nodepool.localeCompare(b.nodepool); break
      case 'type': cmp = (a.instanceType || '').localeCompare(b.instanceType || ''); break
      case 'age': cmp = a.ageSec - b.ageSec; break
      case 'version': cmp = a.version.localeCompare(b.version); break
      case 'ip': cmp = a.internalIP.localeCompare(b.internalIP); break
      case 'pods': cmp = a.pods - b.pods; break
      case 'cpu': cmp = a.cpuPercent - b.cpuPercent; break
      case 'mem': cmp = a.memPercent - b.memPercent; break
    }
    return sortAsc ? cmp : -cmp
  })

  const fsA = nodeFs.active
  const thCls = (col: SortCol, extra = '') =>
    `${fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'} font-medium cursor-pointer select-none transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''} ${extra}`
  const arrow = (col: SortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''

  const totalCpu = data.nodes.reduce((s, n) => s + n.allocCpuM, 0)
  const usedCpu = data.nodes.reduce((s, n) => s + n.usedCpuM, 0)
  const totalMem = data.nodes.reduce((s, n) => s + n.allocMemMi, 0)
  const usedMem = data.nodes.reduce((s, n) => s + n.usedMemMi, 0)
  const clusterCpuPct = totalCpu > 0 ? Math.round(usedCpu * 100 / totalCpu) : 0
  const clusterMemPct = totalMem > 0 ? Math.round(usedMem * 100 / totalMem) : 0

  const c = data.counts || { services: 0, ingresses: 0, statefulsets: 0, daemonsets: 0, jobs: 0, cronjobs: 0 }
  const cl = data.cluster
  const clCpuPct = cl && cl.cpuAllocatableM > 0 ? Math.round(cl.cpuUsedM * 100 / cl.cpuAllocatableM) : clusterCpuPct
  const clMemPct = cl && cl.memAllocatableMi > 0 ? Math.round(cl.memUsedMi * 100 / cl.memAllocatableMi) : clusterMemPct
  const topNS = data.topNamespaces || []
  const maxNSPods = topNS.length > 0 ? topNS[0].pods : 1
  const warns = data.warnings || []

  return (
    <div className="space-y-3 p-3">
      {/* Row 1: Core stats */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <MiniStat icon="⬢" label="Nodes" value={`${data.nodesReady}/${data.nodesTotal}`} color={data.nodesReady === data.nodesTotal ? 'text-neon-green' : 'text-neon-amber'} onClick={() => onTab('nodes')} />
        <MiniStat icon="◉" label="Pods" value={p.total} color="text-neon-cyan" sub={`${p.running} run`} onClick={() => onTab('pods')} />
        <MiniStat icon="⚡" label="Pending" value={p.pending} color={p.pending > 0 ? 'text-neon-amber' : 'text-gray-500'} onClick={() => onTab('troubled')} />
        <MiniStat icon="✗" label="Failed" value={p.failed} color={p.failed > 0 ? 'text-neon-red' : 'text-gray-500'} onClick={() => onTab('troubled')} />
        <MiniStat icon="▣" label="Deploys" value={`${data.deployments.ready}/${data.deployments.total}`} color={data.deployments.ready === data.deployments.total ? 'text-neon-green' : 'text-neon-amber'} onClick={() => onTab('workloads', 'Deployment')} />
        <MiniStat icon="⟳" label="CronJobs" value={c.cronjobs} color="text-sky-300" onClick={() => onTab('workloads', 'CronJob')} />
      </div>

      {/* Cluster resource cards */}
      {(() => {
        const cpuUsed = cl ? cl.cpuUsedM : usedCpu
        const cpuTotal = cl ? cl.cpuAllocatableM : totalCpu
        const memUsedVal = cl ? cl.memUsedMi : usedMem
        const memTotal = cl ? cl.memAllocatableMi : totalMem
        const cpuFree = Math.max(0, cpuTotal - cpuUsed)
        const memFree = Math.max(0, memTotal - memUsedVal)
        const pctColor = (p: number) => p > 80 ? 'text-neon-red' : p > 50 ? 'text-neon-amber' : 'text-neon-cyan'
        const barGrad = (p: number) => p > 80 ? 'from-red-500 to-red-400' : p > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'
        const barGlow = (p: number) => p > 80 ? 'shadow-[0_0_12px_rgba(255,51,85,0.25)]' : p > 50 ? 'shadow-[0_0_12px_rgba(255,184,0,0.2)]' : 'shadow-[0_0_12px_rgba(6,214,224,0.2)]'
        return (
          <div className="grid grid-cols-2 gap-2">
            <div className="stat-card p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">CPU</span>
              </div>
              <div className="flex items-end gap-1 mb-2">
                <span className={`text-3xl font-extrabold tabular-nums leading-none ${pctColor(clCpuPct)}`}>{clCpuPct}</span>
                <span className="text-sm text-gray-600 font-medium mb-0.5">%</span>
              </div>
              <div className="h-2 rounded-full bg-hull-800/80 overflow-hidden mb-2">
                <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(clCpuPct)} ${barGlow(clCpuPct)} transition-all duration-700 ease-out`} style={{ width: `${Math.min(clCpuPct, 100)}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-x-2 text-[10px] font-mono">
                <div><span className="text-gray-600">Used </span><span className="text-gray-300">{(cpuUsed / 1000).toFixed(1)}c</span></div>
                <div><span className="text-gray-600">Free </span><span className="text-gray-300">{(cpuFree / 1000).toFixed(1)}c</span></div>
                <div className="col-span-2 mt-0.5"><span className="text-gray-600">Total </span><span className="text-gray-400">{(cpuTotal / 1000).toFixed(1)} cores</span></div>
              </div>
            </div>
            <div className="stat-card p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Memory</span>
              </div>
              <div className="flex items-end gap-1 mb-2">
                <span className={`text-3xl font-extrabold tabular-nums leading-none ${pctColor(clMemPct)}`}>{clMemPct}</span>
                <span className="text-sm text-gray-600 font-medium mb-0.5">%</span>
              </div>
              <div className="h-2 rounded-full bg-hull-800/80 overflow-hidden mb-2">
                <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(clMemPct)} ${barGlow(clMemPct)} transition-all duration-700 ease-out`} style={{ width: `${Math.min(clMemPct, 100)}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-x-2 text-[10px] font-mono">
                <div><span className="text-gray-600">Used </span><span className="text-gray-300">{(memUsedVal / 1024).toFixed(1)}G</span></div>
                <div><span className="text-gray-600">Free </span><span className="text-gray-300">{(memFree / 1024).toFixed(1)}G</span></div>
                <div className="col-span-2 mt-0.5"><span className="text-gray-600">Total </span><span className="text-gray-400">{(memTotal / 1024).toFixed(1)} GiB</span></div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Top namespaces by pod count */}
      {topNS.length > 0 && (
        <div className="stat-card p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Top Namespaces by Pods</p>
          <div className="space-y-1.5">
            {topNS.map(n => (
              <div key={n.ns} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-gray-400 w-[110px] truncate shrink-0">{n.ns}</span>
                <div className="flex-1 h-2 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-neon-cyan/60 to-neon-cyan/30 transition-all duration-500" style={{ width: `${Math.round(n.pods * 100 / maxNSPods)}%` }} />
                </div>
                <span className="text-[10px] font-mono tabular-nums text-gray-500 w-8 text-right">{n.pods}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* k9s-style node table */}
      <div ref={nodeFs.ref} className={`rounded-xl border border-hull-700/60 bg-hull-900/80 overflow-hidden ${fsA ? 'bg-hull-950 !rounded-none !border-0 h-screen flex flex-col' : ''}`}>
        <div className={`border-b border-hull-700/60 bg-hull-800/50 flex items-center justify-between shrink-0 ${fsA ? 'px-4 py-3' : 'px-3 py-2'}`}>
          <span className={`font-mono font-bold uppercase tracking-wider text-neon-cyan ${fsA ? 'text-xs' : 'text-[10px]'}`}>Nodes</span>
          <div className="flex items-center gap-2">
            <span className={`text-gray-600 ${fsA ? 'text-xs' : 'text-[9px]'}`}>{data.nodesTotal} total</span>
            <FullscreenBtn active={fsA} onEnter={nodeFs.enter} onExit={nodeFs.exit} />
          </div>
        </div>
        <div className={`overflow-x-auto ${fsA ? 'flex-1 overflow-y-auto' : ''}`}>
          <table className={`w-full min-w-[800px] font-mono ${fsA ? 'text-sm' : 'text-[11px]'}`}>
            <thead className={fsA ? 'sticky top-0 z-10 bg-hull-900' : ''}>
              <tr className={`border-b border-hull-700 text-left uppercase tracking-wider ${fsA ? 'text-xs text-gray-400' : 'text-[10px] text-gray-500'}`}>
                <th className={thCls('name')} onClick={() => toggleSort('name')}>Name{arrow('name')}</th>
                <th className={thCls('status')} onClick={() => toggleSort('status')}>Status{arrow('status')}</th>
                <th className={thCls('nodepool')} onClick={() => toggleSort('nodepool')}>Pool{arrow('nodepool')}</th>
                <th className={thCls('type')} onClick={() => toggleSort('type')}>Type{arrow('type')}</th>
                <th className={thCls('age')} onClick={() => toggleSort('age')}>Age{arrow('age')}</th>
                <th className={thCls('version')} onClick={() => toggleSort('version')}>Ver{arrow('version')}</th>
                <th className={thCls('ip')} onClick={() => toggleSort('ip')}>IP{arrow('ip')}</th>
                <th className={thCls('pods')} onClick={() => toggleSort('pods')}>Pods{arrow('pods')}</th>
                <th className={`${fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'} font-medium`}>CPU</th>
                <th className={thCls('cpu', 'text-right')} onClick={() => toggleSort('cpu')}>%{arrow('cpu')}</th>
                <th className={`${fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'} font-medium`}>MEM</th>
                <th className={thCls('mem', 'text-right')} onClick={() => toggleSort('mem')}>%{arrow('mem')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map(n => {
                const trend = podTrend.current.get(n.name)
                const cp = fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'
                return (
                <tr key={n.name} onClick={() => onNodeTap(n.name)} className={`cursor-pointer border-b border-hull-800 transition-colors hover:bg-hull-800 active:bg-hull-700 last:border-0 ${changed.has(`n:${n.name}:row`) ? 'k9s-changed' : ''}`}>
                  <td className={`whitespace-nowrap ${cp} text-white`}>
                    <span className="flex items-center gap-1.5">
                      {n.name}
                      {n.cordoned && <span className={`inline-flex items-center rounded px-1 py-0.5 font-bold uppercase tracking-wider bg-amber-950/60 border border-amber-800/50 text-neon-amber leading-none animate-pulse ${fsA ? 'text-[10px]' : 'text-[8px]'}`}>drain</span>}
                    </span>
                  </td>
                  <Celld k={`n:${n.name}:status`} changed={changed} className={`whitespace-nowrap ${cp} ${statusColor(n.status)}`}>{n.status}</Celld>
                  <td className={`whitespace-nowrap ${cp} text-purple-400 font-medium`}>{n.nodepool || '—'}</td>
                  {n.instanceType ? <td className={`whitespace-nowrap ${cp} text-sky-400/80`}>{n.instanceType}</td> : <td className={`whitespace-nowrap ${cp} text-gray-700`}>—</td>}
                  <td className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-500'}`}>{n.age}</td>
                  <td className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-500'}`}>{n.version}</td>
                  <td className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-500'}`}>{n.internalIP}</td>
                  <Celld k={`n:${n.name}:pods`} changed={changed} className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-400'}`}>
                    <span className="inline-flex items-center gap-1">
                      {n.pods}
                      {trend === 'up' && <span className={`text-neon-green animate-pulse ${fsA ? 'text-xs' : 'text-[10px]'}`}>▲</span>}
                      {trend === 'down' && <span className={`text-neon-red animate-pulse ${fsA ? 'text-xs' : 'text-[10px]'}`}>▼</span>}
                    </span>
                  </Celld>
                  <Celld k={`n:${n.name}:cpu`} changed={changed} className={`whitespace-nowrap ${cp}`}><K9sBar pct={n.cpuPercent} large={fsA} /></Celld>
                  <Celld k={`n:${n.name}:cpuPct`} changed={changed} className={`whitespace-nowrap ${cp} text-right tabular-nums ${n.cpuPercent > 80 ? 'text-neon-red' : n.cpuPercent > 50 ? 'text-neon-amber' : fsA ? 'text-gray-300' : 'text-gray-400'}`}>{n.cpuPercent}%</Celld>
                  <Celld k={`n:${n.name}:mem`} changed={changed} className={`whitespace-nowrap ${cp}`}><K9sBar pct={n.memPercent} large={fsA} /></Celld>
                  <Celld k={`n:${n.name}:memPct`} changed={changed} className={`whitespace-nowrap ${cp} text-right tabular-nums ${n.memPercent > 80 ? 'text-neon-red' : n.memPercent > 50 ? 'text-neon-amber' : fsA ? 'text-gray-300' : 'text-gray-400'}`}>{n.memPercent}%</Celld>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent warnings */}
      {warns.length > 0 && (
        <div className="rounded-xl border border-amber-900/30 bg-hull-900/80 overflow-hidden">
          <div className="border-b border-amber-900/30 bg-amber-950/20 px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-amber">⚠ Warnings</span>
            <span className="text-[9px] text-gray-600">last 30m · {warns.length}</span>
          </div>
          <div className="max-h-44 overflow-auto">
            {warns.map((e, i) => (
              <div key={i} className="flex gap-2 px-3 py-1.5 border-b border-hull-800/40 last:border-0 text-[11px]">
                <span className="text-gray-600 shrink-0 font-mono">{e.age}</span>
                <span className="text-neon-amber shrink-0 font-mono">{e.reason}</span>
                <span className="text-gray-500 truncate">{e.object} — {e.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Nodes ──────────────────────────────────────────────────────────
function NodesView({ onNode }: { onNode: (name: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const { data, err, loading, refetch } = useFetch<NodeDetail[]>('/api/nodes', 10000)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [poolFilter, setPoolFilter] = useState('')

  const act = async (name: string, action: string) => {
    setBusy(`${name}/${action}`)
    try { await post(`/api/nodes/${name}/${action}`); setToast(`${name} ${action}ed`); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const pools = Array.from(new Set((data ?? []).map(n => n.nodepool).filter(Boolean))).sort()
  const filtered = poolFilter ? (data ?? []).filter(n => n.nodepool === poolFilter) : (data ?? [])

  const all = data ?? []
  const readyCount = all.filter(n => n.ready && !n.cordoned).length
  const spotCount = all.filter(n => n.capacityType === 'spot').length
  const totalCpu = all.reduce((s, n) => s + n.allocCpuM, 0)
  const usedCpu = all.reduce((s, n) => s + n.usedCpuM, 0)
  const totalMem = all.reduce((s, n) => s + n.allocMemMi, 0)
  const usedMem = all.reduce((s, n) => s + n.usedMemMi, 0)
  const totalPods = all.reduce((s, n) => s + n.pods, 0)
  const totalPodCap = all.reduce((s, n) => s + n.podCapacity, 0)
  const zones = Array.from(new Set(all.map(n => n.zone).filter(Boolean)))

  return (
    <div className="space-y-2.5 p-3">
      {toast && <div className="glass rounded-lg px-3 py-2 text-xs text-gray-300 anim-in">{toast}</div>}

      {/* Aggregate summary */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-white tabular-nums">{readyCount}<span className="text-gray-600 font-normal text-xs">/{all.length}</span></p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Ready</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-orange-400 tabular-nums">{spotCount}</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Spot</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-neon-cyan tabular-nums">{totalCpu > 0 ? Math.round(usedCpu * 100 / totalCpu) : 0}%</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">CPU Avg</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-neon-cyan tabular-nums">{totalMem > 0 ? Math.round(usedMem * 100 / totalMem) : 0}%</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Mem Avg</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-neon-green tabular-nums">{totalPods}<span className="text-gray-600 font-normal text-xs">/{totalPodCap}</span></p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Pods</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-gray-300 tabular-nums">{zones.length}</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Zones</p>
        </div>
      </div>

      {/* Pool filters */}
      {pools.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
          <button onClick={() => setPoolFilter('')} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${!poolFilter ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All ({all.length})</button>
          {pools.map(p => {
            const count = all.filter(n => n.nodepool === p).length
            return (
              <button key={p} onClick={() => setPoolFilter(poolFilter === p ? '' : p)} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${poolFilter === p ? 'bg-purple-950/60 text-purple-300 border-purple-900/30' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>{p} ({count})</button>
            )
          })}
        </div>
      )}

      {filtered.map((n, i) => {
        const cpuPct = n.allocCpuM > 0 ? Math.round(n.usedCpuM * 100 / n.allocCpuM) : 0
        const memPct = n.allocMemMi > 0 ? Math.round(n.usedMemMi * 100 / n.allocMemMi) : 0
        const podPct = n.podCapacity > 0 ? Math.round(n.pods * 100 / n.podCapacity) : 0
        const hasPressure = n.conditions && n.conditions.length > 0
        return (
          <div key={n.name} className="stat-card p-3 anim-in cursor-pointer hover:ring-1 hover:ring-hull-600 transition-all" style={{ animationDelay: `${i * 40}ms` }} onClick={() => onNode(n.name)}>
            {/* Row 1: identity */}
            <div className="flex items-center gap-2.5">
              <StatusDot ok={n.ready && !n.cordoned && !hasPressure} />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{n.name}</span>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  {n.instanceType && <span className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-px text-[9px] font-mono text-neon-cyan">{n.instanceType}</span>}
                  {n.nodepool && <span className="rounded bg-purple-950/50 border border-purple-900/20 px-1.5 py-px text-[9px] font-medium text-purple-400">{n.nodepool}</span>}
                  {n.capacityType && (
                    <span className={`rounded border px-1.5 py-px text-[9px] font-medium ${n.capacityType === 'spot' ? 'bg-orange-950/40 border-orange-900/20 text-orange-400' : 'bg-hull-800 border-hull-700/50 text-gray-400'}`}>{n.capacityType}</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                {n.cordoned && <Pill color="bg-amber-950/40 text-neon-amber border border-amber-900/20">CORDONED</Pill>}
                <span className="text-[9px] text-gray-600">{n.age}</span>
              </div>
            </div>

            {/* Row 2: conditions / pressure warnings */}
            {hasPressure && (
              <div className="mt-2 flex gap-1.5 flex-wrap">
                {n.conditions.map(c => (
                  <span key={c} className="rounded bg-red-950/40 border border-red-900/20 px-1.5 py-0.5 text-[9px] font-bold text-neon-red animate-pulse">{c}</span>
                ))}
              </div>
            )}

            {/* Row 3: metadata grid */}
            <div className="mt-2.5 grid grid-cols-3 gap-x-2 gap-y-1 text-[9px]">
              <div><span className="text-gray-600 uppercase tracking-wider">Zone</span><p className="font-mono text-gray-300 truncate">{n.zone || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Arch</span><p className="font-mono text-gray-300">{n.arch || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">IP</span><p className="font-mono text-gray-300 truncate">{n.internalIp || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Kubelet</span><p className="font-mono text-gray-300 truncate">{n.kubelet || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Runtime</span><p className="font-mono text-gray-300 truncate">{n.runtime || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Taints</span><p className={`font-mono ${n.taints > 0 ? 'text-neon-amber' : 'text-gray-300'}`}>{n.taints}</p></div>
            </div>

            {/* Row 4: resource bars */}
            <div className="mt-3 space-y-1.5">
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">CPU</span>
                  <span className="font-mono text-[10px] text-gray-400">{n.usedCpuM}m / {n.allocCpuM}m <span className={`font-bold ${cpuPct > 80 ? 'text-neon-red' : cpuPct > 50 ? 'text-neon-amber' : 'text-neon-cyan'}`}>{cpuPct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className={`h-full rounded-full bg-gradient-to-r ${cpuPct > 80 ? 'from-red-500 to-red-400' : cpuPct > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'} transition-all duration-700`} style={{ width: `${Math.min(cpuPct, 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">Memory</span>
                  <span className="font-mono text-[10px] text-gray-400">{Math.round(n.usedMemMi / 1024 * 10) / 10}Gi / {Math.round(n.allocMemMi / 1024 * 10) / 10}Gi <span className={`font-bold ${memPct > 80 ? 'text-neon-red' : memPct > 50 ? 'text-neon-amber' : 'text-neon-cyan'}`}>{memPct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className={`h-full rounded-full bg-gradient-to-r ${memPct > 80 ? 'from-red-500 to-red-400' : memPct > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'} transition-all duration-700`} style={{ width: `${Math.min(memPct, 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">Pods</span>
                  <span className="font-mono text-[10px] text-gray-400">{n.pods} / {n.podCapacity || '?'} <span className={`font-bold ${podPct > 80 ? 'text-neon-red' : podPct > 50 ? 'text-neon-amber' : 'text-neon-green'}`}>{podPct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className={`h-full rounded-full bg-gradient-to-r ${podPct > 80 ? 'from-red-500 to-red-400' : podPct > 50 ? 'from-amber-500 to-amber-400' : 'from-green-500 to-green-400'} transition-all duration-700`} style={{ width: `${Math.min(podPct, 100)}%` }} />
                </div>
              </div>
            </div>

            {/* Row 5: actions */}
            {isAdmin && <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
              {n.cordoned ? (
                <Btn small variant="success" onClick={() => act(n.name, 'uncordon')} disabled={!!busy}>
                  {busy === `${n.name}/uncordon` ? '…' : 'Uncordon'}
                </Btn>
              ) : (
                <>
                  <Btn small onClick={() => act(n.name, 'cordon')} disabled={!!busy}>
                    {busy === `${n.name}/cordon` ? '…' : 'Cordon'}
                  </Btn>
                  <Btn small variant="danger" onClick={() => act(n.name, 'drain')} disabled={!!busy}>
                    {busy === `${n.name}/drain` ? '…' : 'Drain'}
                  </Btn>
                </>
              )}
            </div>}
          </div>
        )
      })}
    </div>
  )
}

// ─── Workloads ──────────────────────────────────────────────────────
function WorkloadsView({ namespace, initialKind, onWorkload }: { namespace: string; initialKind?: string; onWorkload: (ns: string, name: string, kind: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading, refetch } = useFetch<Workload[]>(`/api/workloads${q}`, 10000)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [scaleTarget, setScaleTarget] = useState<{ ns: string; name: string; current: number } | null>(null)
  const [scaleVal, setScaleVal] = useState(0)
  const [kindFilter, setKindFilter] = useState(initialKind || '')

  const restart = async (ns: string, name: string) => {
    const key = `restart:${ns}/${name}`
    setBusy(key)
    try { await post(`/api/workloads/${ns}/${name}/restart`); setToast(`${name} restarting`); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  const scale = async () => {
    if (!scaleTarget) return
    const key = `scale:${scaleTarget.ns}/${scaleTarget.name}`
    setBusy(key)
    try {
      await post(`/api/workloads/${scaleTarget.ns}/${scaleTarget.name}/scale?replicas=${scaleVal}`)
      setToast(`${scaleTarget.name} scaled to ${scaleVal}`)
      setScaleTarget(null)
      refetch()
    } catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const kinds = Array.from(new Set((data ?? []).map(w => w.kind))).sort()
  const filtered = kindFilter ? (data ?? []).filter(w => w.kind === kindFilter) : (data ?? [])

  return (
    <div className="space-y-2 p-4">
      {toast && <div className="rounded-md border border-hull-600 bg-hull-800 px-3 py-2 text-xs text-gray-300">{toast}</div>}

      {/* Kind filter */}
      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
        <button onClick={() => setKindFilter('')} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${!kindFilter ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All ({(data ?? []).length})</button>
        {kinds.map(k => {
          const count = (data ?? []).filter(w => w.kind === k).length
          return (
            <button key={k} onClick={() => setKindFilter(kindFilter === k ? '' : k)} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${kindFilter === k ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>{k} ({count})</button>
          )
        })}
      </div>

      {/* Scale Modal */}
      {scaleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-hull-950/80 backdrop-blur-sm" onClick={() => setScaleTarget(null)}>
          <div className="mx-4 w-full max-w-xs rounded-xl border border-hull-600 bg-hull-900 p-5" onClick={e => e.stopPropagation()}>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Scale Deployment</p>
            <p className="mt-1 truncate text-sm font-bold text-white">{scaleTarget.name}</p>
            <p className="mt-0.5 text-[10px] text-gray-600">{scaleTarget.ns}</p>
            <div className="mt-4 flex items-center justify-center gap-4">
              <button onClick={() => setScaleVal(Math.max(0, scaleVal - 1))} className="flex h-10 w-10 items-center justify-center rounded-lg border border-hull-600 bg-hull-800 text-lg font-bold text-white transition-colors hover:bg-hull-700 active:bg-hull-600">−</button>
              <span className="min-w-[3rem] text-center text-3xl font-bold tabular-nums text-neon-cyan">{scaleVal}</span>
              <button onClick={() => setScaleVal(Math.min(100, scaleVal + 1))} className="flex h-10 w-10 items-center justify-center rounded-lg border border-hull-600 bg-hull-800 text-lg font-bold text-white transition-colors hover:bg-hull-700 active:bg-hull-600">+</button>
            </div>
            <p className="mt-2 text-center text-[10px] text-gray-600">current: {scaleTarget.current}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setScaleTarget(null)} className="flex-1 rounded-lg border border-hull-600 bg-hull-800 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-hull-700">Cancel</button>
              <button onClick={scale} disabled={!!busy} className="flex-1 rounded-lg border border-blue-900/50 bg-blue-950/60 py-2 text-xs font-medium text-neon-blue transition-colors hover:bg-blue-900/40 disabled:opacity-40">
                {busy ? 'Scaling…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
      {filtered.map(w => {
        const ok = w.kind === 'CronJob' ? true : w.ready >= w.desired
        return (
          <div key={`${w.kind}-${w.namespace}-${w.name}`} className="stat-card p-3 cursor-pointer hover:ring-1 hover:ring-hull-600 transition-all" onClick={() => onWorkload(w.namespace, w.name, w.kind)}>
            <div className="flex items-center gap-2.5">
              <StatusDot ok={ok} />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{w.name}</span>
                <div className="flex items-center gap-2 mt-0.5 text-[10px]">
                  <span className="text-gray-500">{w.namespace}</span>
                  <span className="text-gray-700">·</span>
                  <span className={ok ? 'text-neon-green font-medium' : 'text-neon-amber font-medium'}>{w.kind === 'CronJob' ? `${w.ready} active` : `${w.ready}/${w.desired} ready`}</span>
                  <span className="text-gray-700">·</span>
                  <span className="text-gray-600">{w.age}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {w.pdb && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase border ${w.pdb.status === 'blocking' ? 'bg-red-950/50 text-neon-red border-red-900/40' : w.pdb.status === 'degraded' ? 'bg-amber-950/50 text-neon-amber border-amber-900/40' : 'bg-green-950/50 text-neon-green border-green-900/40'}`} title={`PDB: ${w.pdb.name} — ${w.pdb.disruptionsAllowed} disruptions allowed`}>
                    PDB {w.pdb.status === 'healthy' ? '✓' : w.pdb.status === 'blocking' ? '✗' : '!'}
                  </span>
                )}
                <Pill color={`border ${w.kind === 'Deployment' ? 'bg-blue-950/30 text-blue-400 border-blue-900/30' : w.kind === 'StatefulSet' ? 'bg-purple-950/30 text-purple-400 border-purple-900/30' : w.kind === 'Job' ? 'bg-sky-950/30 text-sky-400 border-sky-900/30' : w.kind === 'CronJob' ? 'bg-sky-950/30 text-sky-300 border-sky-900/30' : 'bg-hull-700/50 text-gray-400 border-hull-600/50'}`}>{w.kind === 'CronJob' ? 'CRON' : w.kind.slice(0, 3).toUpperCase()}</Pill>
              </div>
            </div>
            <p className="mt-1 truncate text-gray-600 font-mono text-[9px]">{w.images}</p>
            {(w.cpuReqM > 0 || w.cpuUsedM > 0 || w.memReqMi > 0 || w.memUsedMi > 0) && (
              <div className="mt-1.5 grid grid-cols-2 gap-3">
                <ResourceBar used={w.cpuUsedM} req={w.cpuReqM} lim={w.cpuLimM} label="CPU" unit="m" />
                <ResourceBar used={w.memUsedMi} req={w.memReqMi} lim={w.memLimMi} label="Mem" unit="Mi" />
              </div>
            )}
            {w.kind === 'Deployment' && isAdmin && (
              <div className="mt-2 flex gap-2" onClick={e => e.stopPropagation()}>
                <Btn small variant="primary" onClick={() => restart(w.namespace, w.name)} disabled={busy === `restart:${w.namespace}/${w.name}`}>
                  {busy === `restart:${w.namespace}/${w.name}` ? 'Restarting…' : '↻ Restart'}
                </Btn>
                <Btn small onClick={() => { setScaleTarget({ ns: w.namespace, name: w.name, current: w.desired }); setScaleVal(w.desired) }}>
                  ⇕ Scale
                </Btn>
              </div>
            )}
          </div>
        )
      })}

    </div>
  )
}

// ─── Workload Detail ─────────────────────────────────────────────────

function WorkloadDetailView({ ns, name, kind, onBack, onPod }: { ns: string; name: string; kind: string; onBack: () => void; onPod: (ns: string, name: string) => void }) {
  const { data, err, loading } = useFetch<any>(`/api/workloads/${ns}/${name}/describe?kind=${kind}`, 10000)
  const [activeSection, setActiveSection] = useState<'overview' | 'pods' | 'containers' | 'events' | 'labels' | 'metrics' | 'replicasets'>('overview')

  if (loading) return <div className="p-4"><Spinner /></div>
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  if (!data) return null

  const containers = data.containers || []
  const events = data.events || []
  const conditions = data.conditions || []
  const labels = data.labels || {}
  const annotations = data.annotations || {}
  const wlPods: { name: string; namespace: string; status: string; ready: string; restarts: number; age: string; node: string }[] = data.pods || []
  const replicaSets: { name: string; desired: number; ready: number; available: number; age: string; revision: string; current: boolean }[] = data.replicaSets || []

  const sections = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'metrics' as const, label: 'Metrics' },
    ...(kind === 'Deployment' && replicaSets.length > 0 ? [{ id: 'replicasets' as const, label: `ReplicaSets (${replicaSets.length})` }] : []),
    { id: 'pods' as const, label: `Pods (${wlPods.length})` },
    { id: 'containers' as const, label: `Containers (${containers.length})` },
    { id: 'events' as const, label: `Events (${events.length})` },
    { id: 'labels' as const, label: 'Labels' },
  ]

  const kindColor = kind === 'Deployment' ? 'text-blue-400' : kind === 'StatefulSet' ? 'text-purple-400' : kind === 'DaemonSet' ? 'text-indigo-400' : kind === 'CronJob' ? 'text-sky-300' : 'text-sky-400'

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-hull-700/40 bg-hull-900/60 px-3 py-2 flex items-center gap-2">
        <button onClick={onBack} className="rounded-lg bg-hull-800 border border-hull-700/50 px-2.5 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">← Back</button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-white truncate">{name}</p>
          <p className="text-[10px] text-gray-500">{ns} · <span className={kindColor}>{kind}</span>{data.age ? ` · ${data.age}` : ''}</p>
        </div>
      </div>

      <div className="flex gap-1 px-3 py-2 overflow-x-auto scrollbar-hide border-b border-hull-800/50">
        {sections.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${activeSection === s.id ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>{s.label}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeSection === 'overview' && (
          <>
            {/* Status */}
            <div className="stat-card p-3 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Status</p>
              {kind === 'Deployment' && (
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Replicas</span><p className="font-mono text-white">{data.readyReplicas ?? 0}/{data.replicas}</p></div>
                  <div><span className="text-gray-500">Updated</span><p className="font-mono text-white">{data.updatedReplicas ?? 0}</p></div>
                  <div><span className="text-gray-500">Available</span><p className="font-mono text-white">{data.availableReplicas ?? 0}</p></div>
                  <div><span className="text-gray-500">Strategy</span><p className="font-mono text-gray-300">{data.strategy}</p></div>
                </div>
              )}
              {kind === 'StatefulSet' && (
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Replicas</span><p className="font-mono text-white">{data.readyReplicas ?? 0}/{data.replicas}</p></div>
                  <div><span className="text-gray-500">Service</span><p className="font-mono text-gray-300">{data.serviceName}</p></div>
                </div>
              )}
              {kind === 'DaemonSet' && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Desired</span><p className="font-mono text-white">{data.desiredNumberScheduled}</p></div>
                  <div><span className="text-gray-500">Current</span><p className="font-mono text-white">{data.currentNumberScheduled}</p></div>
                  <div><span className="text-gray-500">Ready</span><p className="font-mono text-neon-green">{data.numberReady}</p></div>
                </div>
              )}
              {kind === 'CronJob' && (
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Schedule</span><p className="font-mono text-neon-cyan">{data.schedule}</p></div>
                  <div><span className="text-gray-500">Suspend</span><p className={`font-mono ${data.suspend ? 'text-neon-amber' : 'text-neon-green'}`}>{data.suspend ? 'Yes' : 'No'}</p></div>
                  <div><span className="text-gray-500">Active Jobs</span><p className="font-mono text-white">{data.activeJobs}</p></div>
                  {data.lastSchedule && <div><span className="text-gray-500">Last Run</span><p className="font-mono text-gray-300">{data.lastSchedule}</p></div>}
                  {data.lastSuccess && <div><span className="text-gray-500">Last Success</span><p className="font-mono text-neon-green">{data.lastSuccess}</p></div>}
                </div>
              )}
              {kind === 'Job' && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Completed</span><p className="font-mono text-neon-green">{data.completions ?? 0}</p></div>
                  <div><span className="text-gray-500">Active</span><p className="font-mono text-white">{data.active ?? 0}</p></div>
                  <div><span className="text-gray-500">Failed</span><p className={`font-mono ${(data.failed ?? 0) > 0 ? 'text-neon-red' : 'text-gray-500'}`}>{data.failed ?? 0}</p></div>
                </div>
              )}
            </div>
            {/* Selector */}
            {data.selector && Object.keys(data.selector).length > 0 && (
              <div className="stat-card p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Selector</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.selector).map(([k, v]) => (
                    <span key={k} className="rounded bg-hull-800 border border-hull-700/50 px-2 py-0.5 text-[10px] font-mono text-gray-300">{k}=<span className="text-neon-cyan">{v as string}</span></span>
                  ))}
                </div>
              </div>
            )}
            {/* Conditions */}
            {conditions.length > 0 && (
              <div className="stat-card p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Conditions</p>
                <div className="space-y-1.5">
                  {conditions.map((c: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-[11px]">
                      <span className={`shrink-0 mt-0.5 w-2 h-2 rounded-full ${c.status === 'True' ? 'bg-neon-green' : 'bg-neon-red'}`} />
                      <div className="min-w-0">
                        <span className="font-medium text-white">{c.type}</span>
                        {c.reason && <span className="text-gray-500 ml-2">{c.reason}</span>}
                        {c.age && <span className="text-gray-600 ml-2">{c.age}</span>}
                        {c.message && <p className="text-[10px] text-gray-500 mt-0.5 break-words">{c.message}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Prometheus Right-Sizing Recommendations */}
            {(kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') && (
              <SizingPanel namespace={ns} name={name} kind={kind} />
            )}
            {/* Dependent Resource Map */}
            <DependencyGraph ns={ns} name={name} kind={kind} />
          </>
        )}

        {activeSection === 'metrics' && (
          <WorkloadMetricsPanel namespace={ns} name={name} kind={kind} />
        )}

        {activeSection === 'pods' && (
          wlPods.length > 0 ? (
            <div className="space-y-1">
              {wlPods.map(p => {
                const stColor = p.status === 'Running' ? 'bg-neon-green' : p.status === 'Completed' || p.status === 'Succeeded' ? 'bg-neon-cyan' : p.status === 'Pending' || p.status === 'ContainerCreating' ? 'bg-neon-amber' : 'bg-neon-red'
                return (
                  <button key={p.name} onClick={() => onPod(p.namespace, p.name)} className="w-full stat-card px-3 py-2.5 text-left hover:bg-hull-800/40 transition-colors">
                    <div className="flex items-center gap-2.5">
                      <span className={`shrink-0 h-2.5 w-2.5 rounded-full ${stColor}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-white truncate">{p.name}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-500">
                          <span>{p.ready} ready</span>
                          <span className="text-gray-700">·</span>
                          <span className={p.restarts > 0 ? 'text-neon-amber' : ''}>{p.restarts} restart{p.restarts !== 1 ? 's' : ''}</span>
                          <span className="text-gray-700">·</span>
                          <span>{p.age}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`text-[11px] font-mono font-medium ${p.status === 'Running' ? 'text-neon-green' : p.status === 'Completed' || p.status === 'Succeeded' ? 'text-neon-cyan' : p.status === 'Pending' || p.status === 'ContainerCreating' ? 'text-neon-amber' : 'text-neon-red'}`}>{p.status}</span>
                        {p.node && <p className="text-[9px] text-gray-600 mt-0.5 truncate max-w-[120px]">{p.node}</p>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : <p className="text-center text-[11px] text-gray-600 py-8">No pods found for this workload</p>
        )}

        {activeSection === 'containers' && (
          <div className="space-y-2">
            {containers.map((ct: any, i: number) => (
              <div key={i} className="stat-card p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-bold text-white">{ct.name}</span>
                </div>
                <p className="text-[10px] font-mono text-neon-cyan break-all">{ct.image}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  {ct.cpuReq && <div><span className="text-gray-500">CPU Req</span><p className="font-mono text-gray-300">{ct.cpuReq}</p></div>}
                  {ct.cpuLim && <div><span className="text-gray-500">CPU Lim</span><p className="font-mono text-gray-300">{ct.cpuLim}</p></div>}
                  {ct.memReq && <div><span className="text-gray-500">Mem Req</span><p className="font-mono text-gray-300">{ct.memReq}</p></div>}
                  {ct.memLim && <div><span className="text-gray-500">Mem Lim</span><p className="font-mono text-gray-300">{ct.memLim}</p></div>}
                </div>
                {ct.ports?.length > 0 && (
                  <div className="mt-2 text-[10px]">
                    <span className="text-gray-500">Ports: </span>
                    <span className="font-mono text-gray-300">{ct.ports.join(', ')}</span>
                  </div>
                )}
                {ct.envCount > 0 && <p className="mt-1 text-[10px] text-gray-500">{ct.envCount} env vars</p>}
              </div>
            ))}
          </div>
        )}

        {activeSection === 'events' && (
          events.length > 0 ? (
            <div className="space-y-1">
              {events.map((e: any, i: number) => (
                <div key={i} className={`flex gap-2 px-3 py-1.5 rounded-lg text-[11px] ${e.type === 'Warning' ? 'bg-amber-950/20 border border-amber-900/20' : 'bg-hull-800/40 border border-hull-700/20'}`}>
                  <span className="text-gray-600 shrink-0 font-mono">{e.age}</span>
                  <span className={`shrink-0 font-mono ${e.type === 'Warning' ? 'text-neon-amber' : 'text-gray-400'}`}>{e.reason}</span>
                  <span className="text-gray-500 break-words">{e.message}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-center text-[11px] text-gray-600 py-8">No recent events</p>
        )}

        {activeSection === 'replicasets' && (
          replicaSets.length > 0 ? (
            <div className="space-y-1.5">
              {replicaSets.map(rs => (
                <div key={rs.name} className="stat-card p-3">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 h-2.5 w-2.5 rounded-full ${rs.current ? 'bg-neon-green' : 'bg-gray-600'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-medium text-white truncate">{rs.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-500">
                        <span className={rs.current ? 'text-neon-green font-medium' : ''}>{rs.ready}/{rs.desired} ready</span>
                        <span className="text-gray-700">·</span>
                        <span>{rs.available} available</span>
                        <span className="text-gray-700">·</span>
                        <span>{rs.age}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {rs.revision && <span className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-0.5 text-[9px] font-mono text-gray-400">rev {rs.revision}</span>}
                      {rs.current && <span className="rounded bg-green-950/50 border border-green-900/40 px-1.5 py-0.5 text-[8px] font-bold uppercase text-neon-green">active</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-center text-[11px] text-gray-600 py-8">No ReplicaSets found</p>
        )}

        {activeSection === 'labels' && (
          <>
            {Object.keys(labels).length > 0 && (
              <div className="stat-card p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Labels</p>
                <div className="space-y-1">
                  {Object.entries(labels).map(([k, v]) => (
                    <div key={k} className="text-[10px] font-mono break-all">
                      <span className="text-gray-500">{k}: </span><span className="text-gray-300">{v as string}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(annotations).length > 0 && (
              <div className="stat-card p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Annotations</p>
                <div className="space-y-1">
                  {Object.entries(annotations).map(([k, v]) => (
                    <div key={k} className="text-[10px] font-mono break-all">
                      <span className="text-gray-500">{k}: </span><span className="text-gray-300">{(v as string).length > 200 ? (v as string).slice(0, 200) + '…' : v as string}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(labels).length === 0 && Object.keys(annotations).length === 0 && (
              <p className="text-center text-[11px] text-gray-600 py-8">No labels or annotations</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Dependency Resource Map ─────────────────────────────────────────
function DependencyGraph({ ns, name, kind }: { ns: string; name: string; kind: string }) {
  const { data, err, loading } = useFetch<any>(`/api/workloads/${ns}/${name}/dependencies?kind=${kind}`, 30000)

  if (loading) return <div className="stat-card p-3"><Spinner /></div>
  if (err) return null
  if (!data) return null

  const svcs: any[] = data.services || []
  const ings: any[] = data.ingresses || []
  const hpas: any[] = data.hpas || []
  const cfgs: any[] = data.configRefs || []
  const pdb = data.pdb
  const empty = svcs.length === 0 && ings.length === 0 && hpas.length === 0 && cfgs.length === 0 && !pdb
  if (empty) return null

  const navigate = (path: string) => {
    window.history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const kindStyle = (k: string) => {
    switch (k) {
      case 'Ingress':   return { bg: 'bg-cyan-950/40', border: 'border-cyan-800/40', dot: 'bg-cyan-400', text: 'text-cyan-300' }
      case 'Service':   return { bg: 'bg-purple-950/40', border: 'border-purple-800/40', dot: 'bg-purple-400', text: 'text-purple-300' }
      case 'HPA':       return { bg: 'bg-amber-950/40', border: 'border-amber-800/40', dot: 'bg-amber-400', text: 'text-amber-300' }
      case 'PDB':       return { bg: 'bg-green-950/40', border: 'border-green-800/40', dot: 'bg-green-400', text: 'text-green-300' }
      case 'ConfigMap': return { bg: 'bg-slate-900/60', border: 'border-slate-700/40', dot: 'bg-slate-400', text: 'text-slate-300' }
      case 'Secret':    return { bg: 'bg-amber-950/30', border: 'border-amber-800/30', dot: 'bg-amber-500', text: 'text-amber-300' }
      default:          return { bg: 'bg-hull-800/40', border: 'border-hull-700/40', dot: 'bg-gray-400', text: 'text-gray-300' }
    }
  }

  type DepItem = { kind: string; name: string; relation: string; detail: string; onClick?: () => void }
  const items: DepItem[] = []

  ings.forEach((ing: any) => {
    items.push({
      kind: 'Ingress', name: ing.name, relation: '→ routes traffic',
      detail: `${ing.host || '*'}${ing.path}${ing.tls ? ' (TLS)' : ''} → ${ing.serviceName}`,
      onClick: () => navigate(`/ingress/${ns}/${ing.name}`),
    })
  })
  svcs.forEach((s: any) => {
    items.push({
      kind: 'Service', name: s.name, relation: '→ exposes',
      detail: `${s.type} · ${s.clusterIP} · ${s.ports}`,
      onClick: () => navigate(`/services`),
    })
  })
  hpas.forEach((h: any) => {
    items.push({
      kind: 'HPA', name: h.name, relation: '↔ scales',
      detail: `${h.currentReplicas}/${h.desiredReplicas} replicas (${h.minReplicas}–${h.maxReplicas}) ${h.metrics || ''}`,
      onClick: () => navigate(`/hpa`),
    })
  })
  if (pdb) {
    items.push({
      kind: 'PDB', name: pdb.name, relation: '⛨ protects',
      detail: `${pdb.status} · ${pdb.disruptionsAllowed} disruptions allowed${pdb.minAvailable ? ` · min: ${pdb.minAvailable}` : ''}${pdb.maxUnavailable ? ` · maxUnavail: ${pdb.maxUnavailable}` : ''}`,
    })
  }
  cfgs.forEach((c: any) => {
    items.push({
      kind: c.kind, name: c.name, relation: `← ${c.source}`,
      detail: `${c.kind} mounted via ${c.source}`,
      onClick: () => navigate(`/config`),
    })
  })

  return (
    <div className="stat-card p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Resource Map</p>

      {/* Central workload node */}
      <div className="flex items-center justify-center mb-3">
        <div className={`rounded-lg border-2 px-4 py-2 text-center ${kind === 'Deployment' ? 'border-blue-600/60 bg-blue-950/30' : kind === 'StatefulSet' ? 'border-purple-600/60 bg-purple-950/30' : 'border-indigo-600/60 bg-indigo-950/30'}`}>
          <p className="text-[11px] font-bold text-white">{name}</p>
          <p className={`text-[9px] font-mono ${kind === 'Deployment' ? 'text-blue-400' : kind === 'StatefulSet' ? 'text-purple-400' : 'text-indigo-400'}`}>{kind}</p>
        </div>
      </div>

      {/* Connected resources */}
      <div className="space-y-1.5">
        {items.map((item, i) => {
          const s = kindStyle(item.kind)
          return (
            <div key={`${item.kind}-${item.name}-${i}`}
              onClick={item.onClick}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all ${s.bg} ${s.border} ${item.onClick ? 'cursor-pointer hover:brightness-125 hover:border-opacity-80 active:scale-[0.99]' : ''}`}>
              <span className={`shrink-0 h-2.5 w-2.5 rounded-full ${s.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] font-bold uppercase ${s.text}`}>{item.kind}</span>
                  <span className="text-[9px] text-gray-600">{item.relation}</span>
                </div>
                <p className="text-[11px] font-mono text-white font-medium truncate">{item.name}</p>
                <p className="text-[10px] text-gray-500 truncate">{item.detail}</p>
              </div>
              {item.onClick && <span className="text-gray-600 text-sm shrink-0">›</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Sizing Panel (Prometheus 7-day recommendations) ────────────────
function SizingPanel({ namespace, name, kind }: { namespace: string; name: string; kind: string }) {
  const { data, err, loading } = useFetch<any>(`/api/workload-sizing?namespace=${namespace}&name=${name}&kind=${kind}`, 60000)

  if (loading) return <div className="stat-card p-3"><Spinner /><p className="text-[10px] text-gray-500 mt-1">Loading 7-day recommendations…</p></div>
  if (err) return <div className="stat-card p-3"><p className="text-[10px] text-neon-red">{err}</p></div>
  if (!data || !data.current) return null

  const cur = data.current
  const rec = data.recommended
  const obs = data.observed
  const sizing = data.sizing

  const rows: { label: string; curVal: string; obsVal: string; recVal: string; diff: number }[] = [
    { label: 'CPU Request', curVal: `${cur.cpuReqM}m`, obsVal: `Avg: ${obs.cpuAvgM}m`, recVal: `${rec.cpuReqM}m`, diff: cur.cpuReqM > 0 ? rec.cpuReqM - cur.cpuReqM : 0 },
    { label: 'CPU Limit', curVal: `${cur.cpuLimM}m`, obsVal: `Max: ${obs.cpuMaxM}m`, recVal: `${rec.cpuLimM}m`, diff: cur.cpuLimM > 0 ? rec.cpuLimM - cur.cpuLimM : 0 },
    { label: 'Mem Request', curVal: `${cur.memReqMi}Mi`, obsVal: `Avg: ${obs.memAvgMi}Mi`, recVal: `${rec.memReqMi}Mi`, diff: cur.memReqMi > 0 ? rec.memReqMi - cur.memReqMi : 0 },
    { label: 'Mem Limit', curVal: `${cur.memLimMi}Mi`, obsVal: `Max: ${obs.memMaxMi}Mi`, recVal: `${rec.memLimMi}Mi`, diff: cur.memLimMi > 0 ? rec.memLimMi - cur.memLimMi : 0 },
  ]

  const verdictColor = sizing === 'over' ? 'text-neon-amber' : sizing === 'under' ? 'text-neon-red' : 'text-neon-green'
  const verdictText = sizing === 'over' ? 'Over-provisioned — potential savings' : sizing === 'under' ? 'Under-provisioned — consider increasing' : 'Right-sized'

  return (
    <div className="stat-card p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Right-Sizing Recommendations</p>
        <span className={`text-[10px] font-bold ${verdictColor}`}>{verdictText}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-gray-500 border-b border-hull-700/30">
              <th className="text-left py-1 font-medium">Resource</th>
              <th className="text-right py-1 font-medium">Current</th>
              <th className="text-right py-1 font-medium">Observed (7d)</th>
              <th className="text-right py-1 font-medium">Recommended</th>
              <th className="text-right py-1 font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label} className="border-b border-hull-800/30">
                <td className="py-1.5 text-gray-400 font-medium">{r.label}</td>
                <td className="py-1.5 text-right font-mono text-gray-300">{r.curVal}</td>
                <td className="py-1.5 text-right font-mono text-gray-500">{r.obsVal}</td>
                <td className="py-1.5 text-right font-mono text-white font-medium">{r.recVal}</td>
                <td className={`py-1.5 text-right font-mono font-medium ${r.diff < 0 ? 'text-neon-green' : r.diff > 0 ? 'text-neon-red' : 'text-gray-600'}`}>
                  {r.diff === 0 ? '—' : r.diff > 0 ? `+${r.diff}` : r.diff}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[9px] text-gray-600 mt-2">Source: Prometheus 7-day average usage · Headroom: 20% Req, 30% CPU Limit, 20% Mem Limit</p>
    </div>
  )
}

// ─── Resource mini bar (used/request/limit) ─────────────────────────
function ResourceBar({ used, req, lim, label, unit }: { used: number; req: number; lim: number; label: string; unit: string }) {
  const cap = lim || req || used || 1
  const usedPct = Math.min((used / cap) * 100, 100)
  const reqPct = req ? Math.min((req / cap) * 100, 100) : 0
  const overLim = lim > 0 && used >= lim
  const barColor = overLim ? 'bg-neon-red' : 'bg-neon-cyan'
  return (
    <div className="min-w-[80px]">
      <div className="flex justify-between text-[9px]">
        <span className="text-gray-500">{label}</span>
        <span className={`tabular-nums ${overLim ? 'text-neon-red' : 'text-gray-400'}`}>{used}{unit}</span>
      </div>
      <div className="relative mt-0.5 h-1.5 w-full rounded-full bg-hull-700">
        {reqPct > 0 && <div className="absolute top-0 h-full rounded-full bg-hull-600 opacity-40" style={{ width: `${reqPct}%` }} />}
        <div className={`absolute top-0 h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${usedPct}%` }} />
      </div>
      <div className="flex justify-between text-[8px] text-gray-600 mt-px">
        {req > 0 ? <span>req:{req}{unit}</span> : <span />}
        {lim > 0 ? <span>lim:{lim}{unit}</span> : <span />}
      </div>
    </div>
  )
}

// ─── Pods ────────────────────────────────────────────────────────────
function PodsView({ namespace, onPod }: { namespace: string; onPod: (ns: string, name: string) => void }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<Pod[]>(`/api/pods${q}`, 8000)
  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  const statusColor = (s: string) => s === 'Running' ? 'text-neon-green' : s === 'Succeeded' || s === 'Completed' ? 'text-gray-500' : s === 'Pending' || s === 'ContainerCreating' ? 'text-neon-amber' : 'text-neon-red'
  return (
    <div className="space-y-2 p-3">
      {data?.map((p, i) => (
        <button key={`${p.namespace}-${p.name}`} onClick={() => onPod(p.namespace, p.name)} className="w-full stat-card px-3 py-2.5 text-left anim-in" style={{ animationDelay: `${i * 25}ms` }}>
          <div className="flex items-center gap-2.5">
            <StatusDot ok={p.status === 'Running'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{p.name}</p>
              <p className="text-[10px] text-gray-600">{p.namespace} · {p.node}</p>
            </div>
            <div className="shrink-0 text-right text-[10px]">
              <span className={`font-medium ${statusColor(p.status)}`}>{p.status}</span>
              <p className="text-gray-600">{p.ready} · {p.age}</p>
              {p.restarts > 0 && <p className="text-neon-amber font-medium">{p.restarts}x restart</p>}
            </div>
            <span className="text-gray-700 text-sm">›</span>
          </div>
          {(p.cpuUsedM > 0 || p.memUsedMi > 0 || p.cpuReqM > 0 || p.memReqMi > 0) && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <ResourceBar used={p.cpuUsedM} req={p.cpuReqM} lim={p.cpuLimM} label="CPU" unit="m" />
              <ResourceBar used={p.memUsedMi} req={p.memReqMi} lim={p.memLimMi} label="MEM" unit="Mi" />
            </div>
          )}
          {(p.cpuSizing !== 'unknown' || p.memSizing !== 'unknown') && (
            <div className="mt-1.5 flex gap-1.5">
              {p.cpuSizing !== 'unknown' && <SizingBadge resource="CPU" sizing={p.cpuSizing} />}
              {p.memSizing !== 'unknown' && <SizingBadge resource="MEM" sizing={p.memSizing} />}
            </div>
          )}
        </button>
      ))}
    </div>
  )
}

// ─── Container State Badge ──────────────────────────────────────────
function ContainerStateBadge({ state, reason }: { state: string; reason: string }) {
  const label = reason || state
  if (state === 'running') return <span className="rounded-full bg-green-950/50 px-2 py-0.5 text-[10px] font-medium text-neon-green">{label}</span>
  if (state === 'waiting') {
    const isDanger = /CrashLoop|OOMKill|Error|BackOff|ImagePull/i.test(reason)
    return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${isDanger ? 'bg-red-950/50 text-neon-red' : 'bg-amber-950/50 text-neon-amber'}`}>{label}</span>
  }
  return <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-medium text-gray-400">{label}</span>
}

// ─── Metrics Charts (Prometheus) ─────────────────────────────────────

type MetricSeries = { name: string; values: [number, number][] }
type MetricsData = Record<string, MetricSeries[]>

const CHART_COLORS = ['#06b6d4', '#f59e0b', '#22c55e', '#a78bfa', '#f87171', '#38bdf8', '#facc15', '#4ade80', '#c084fc', '#fb923c']

function useMetrics(url: string, timeRange: string) {
  const [data, setData] = useState<MetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    setData(null)
    const fullUrl = `${url}${url.includes('?') ? '&' : '?'}range=${timeRange}`
    fetch(fullUrl)
      .then(r => {
        if (!r.ok) {
          return r.json().catch(() => ({})).then(body => {
            throw new Error(body.error || `HTTP ${r.status}`)
          })
        }
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        if (d.error) { setErr(d.error); setLoading(false); return }
        setData(d)
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setErr(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [url, timeRange])

  return { data, loading, err }
}

type RefLine = { value: number; label: string; color: string }

function MetricChart({ title, series, unit, height = 120, refLines }: { title: string; series: MetricSeries[]; unit: string; height?: number; refLines?: RefLine[] }) {
  const chartData = useMemo(() => {
    if (!series || series.length === 0) return []
    const allTimestamps = new Set<number>()
    for (const s of series) for (const [ts] of s.values) allTimestamps.add(ts)
    const sorted = Array.from(allTimestamps).sort((a, b) => a - b)
    return sorted.map(ts => {
      const point: Record<string, number> = { ts: ts * 1000 }
      for (const s of series) {
        const match = s.values.find(v => v[0] === ts)
        if (match) point[s.name] = Math.round(match[1] * 100) / 100
      }
      return point
    })
  }, [series])

  if (!series || series.length === 0) return null

  const seriesNames = series.map(s => s.name)
  const isSingleSeries = seriesNames.length === 1
  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const formatVal = (v: number) => {
    if (unit === 'bytes' || unit === 'bytes/s') {
      const suffix = unit === 'bytes/s' ? '/s' : ''
      if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GiB${suffix}`
      if (v >= 1048576) return `${(v / 1048576).toFixed(0)} MiB${suffix}`
      if (v >= 1024) return `${(v / 1024).toFixed(0)} KiB${suffix}`
      return `${v.toFixed(0)} B${suffix}`
    }
    if (unit === 'cores') return v >= 1 ? `${v.toFixed(1)} cores` : `${(v * 1000).toFixed(0)}m`
    if (unit === 'MiB') return v > 1024 ? `${(v / 1024).toFixed(1)} GiB` : `${v.toFixed(0)} MiB`
    if (unit === 'millicores') return v > 1000 ? `${(v / 1000).toFixed(2)} cores` : `${v.toFixed(0)}m`
    if (unit === '%') return `${v.toFixed(1)}%`
    return `${v.toFixed(1)}${unit ? ' ' + unit : ''}`
  }

  const stableGradId = title.replace(/[^a-zA-Z0-9]/g, '_')

  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500 mb-1">{title}</p>
      {!isSingleSeries && seriesNames.length <= 8 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1">
          {seriesNames.slice(0, 8).map((name, i) => (
            <span key={name} className="flex items-center gap-1 text-[8px] font-mono text-gray-500">
              <span className="inline-block w-2.5 h-0.5 rounded" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              {name}
            </span>
          ))}
          {seriesNames.length > 8 && <span className="text-[8px] text-gray-600">+{seriesNames.length - 8} more</span>}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            {seriesNames.slice(0, 10).map((name, i) => (
              <linearGradient key={name} id={`grad-${stableGradId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="ts" tickFormatter={formatTime} tick={{ fontSize: 9, fill: '#4b5563' }} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tickFormatter={formatVal} tick={{ fontSize: 9, fill: '#4b5563' }} tickLine={false} axisLine={false} width={52} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }}
            labelFormatter={(ts) => new Date(Number(ts)).toLocaleTimeString()}
            formatter={(value) => [formatVal(Number(value))]}
          />
          {seriesNames.slice(0, 10).map((name, i) => (
            <Area key={name} type="monotone" dataKey={name} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={`url(#grad-${stableGradId}-${i})`}
              strokeWidth={1.5} dot={false} isAnimationActive={false}
              name={isSingleSeries ? title : name} />
          ))}
          {refLines?.map(rl => (
            <ReferenceLine key={rl.label} y={rl.value} stroke={rl.color} strokeDasharray="6 3" strokeWidth={1.5}
              label={{ value: rl.label, position: 'right', fill: rl.color, fontSize: 9, fontFamily: 'monospace' }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

const METRIC_RANGES = ['1h', '3h', '6h', '12h', '24h'] as const

function seriesLastVal(series?: MetricSeries[]): number {
  if (!series || series.length === 0) return 0
  const vals = series[0].values
  return vals.length > 0 ? vals[vals.length - 1][1] : 0
}


function fmtBytes(v: number): string {
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GiB`
  if (v >= 1048576) return `${(v / 1048576).toFixed(0)} MiB`
  return `${(v / 1024).toFixed(0)} KiB`
}

function NodeMetricsPanel({ nodeName }: { nodeName: string }) {
  const [timeRange, setTimeRange] = useState('1h')
  const { data, loading, err } = useMetrics(`/api/metrics/node?node=${encodeURIComponent(nodeName)}`, timeRange)

  const hasData = data && Object.keys(data).length > 0
  const hasRR = !!(data?.rr_cpu_used || data?.rr_mem_used)
  const hasRawMetrics = !!(data?.cpu || data?.memory)

  const cpuUsed = useMemo(() => seriesLastVal(data?.rr_cpu_used), [data?.rr_cpu_used])
  const cpuCapacity = useMemo(() => seriesLastVal(data?.cpu_capacity), [data?.cpu_capacity])
  const cpuReq = useMemo(() => seriesLastVal(data?.rr_cpu_requests), [data?.rr_cpu_requests])
  const cpuLim = useMemo(() => seriesLastVal(data?.rr_cpu_limits), [data?.rr_cpu_limits])
  const memUsed = useMemo(() => seriesLastVal(data?.rr_mem_used), [data?.rr_mem_used])
  const memCapacity = useMemo(() => seriesLastVal(data?.mem_capacity), [data?.mem_capacity])
  const memReq = useMemo(() => seriesLastVal(data?.rr_mem_requests), [data?.rr_mem_requests])
  const memLim = useMemo(() => seriesLastVal(data?.rr_mem_limits), [data?.rr_mem_limits])

  const cpuPct = cpuCapacity > 0 ? (cpuUsed / cpuCapacity) * 100 : 0
  const memPct = memCapacity > 0 ? (memUsed / memCapacity) * 100 : 0

  const cpuRefLines: RefLine[] = useMemo(() => {
    const lines: RefLine[] = []
    if (cpuCapacity > 0) lines.push({ value: cpuCapacity, label: `Capacity ${cpuCapacity} cores`, color: '#F2495C' })
    if (cpuReq > 0) lines.push({ value: cpuReq, label: `Requests ${cpuReq.toFixed(1)}`, color: '#facc15' })
    if (cpuLim > 0) lines.push({ value: cpuLim, label: `Limits ${cpuLim.toFixed(1)}`, color: '#fb923c' })
    return lines
  }, [cpuCapacity, cpuReq, cpuLim])

  const memRefLines: RefLine[] = useMemo(() => {
    const lines: RefLine[] = []
    if (memCapacity > 0) lines.push({ value: memCapacity, label: `Capacity ${fmtBytes(memCapacity)}`, color: '#F2495C' })
    if (memReq > 0) lines.push({ value: memReq, label: `Requests ${fmtBytes(memReq)}`, color: '#facc15' })
    if (memLim > 0) lines.push({ value: memLim, label: `Limits ${fmtBytes(memLim)}`, color: '#fb923c' })
    return lines
  }, [memCapacity, memReq, memLim])

  return (
    <div className="rounded border border-hull-700 bg-hull-900">
      <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Node Metrics</span>
        <div className="flex gap-1">
          {METRIC_RANGES.map(r => (
            <button key={r} onClick={() => setTimeRange(r)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${timeRange === r ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-gray-600 hover:text-gray-400'}`}>{r}</button>
          ))}
        </div>
      </div>
      <div className="p-3 space-y-3">
        {loading && <div className="flex items-center justify-center py-6"><span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse mr-2" /><span className="text-[10px] text-gray-500">Loading metrics...</span></div>}
        {err && <p className="text-[10px] text-neon-amber text-center py-4">{err}</p>}
        {!loading && !err && !hasData && <p className="text-[10px] text-gray-500 text-center py-4">No metric data returned for this node</p>}
        {hasData && hasRR && (
          <>
            {/* Summary stat cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="stat-card p-2.5">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">CPU — All Pods on Node</span>
                  <span className={`text-[11px] font-bold font-mono ${cpuPct > 80 ? 'text-red-400' : cpuPct > 60 ? 'text-yellow-400' : 'text-neon-green'}`}>{cpuPct.toFixed(0)}%</span>
                </div>
                <div className="w-full h-1.5 bg-hull-700 rounded-full overflow-hidden mb-1.5">
                  <div className={`h-full rounded-full transition-all ${cpuPct > 80 ? 'bg-red-500' : cpuPct > 60 ? 'bg-yellow-500' : 'bg-neon-green'}`} style={{ width: `${Math.min(cpuPct, 100)}%` }} />
                </div>
                <div className="flex justify-between text-[9px] font-mono text-gray-500">
                  <span>Used: <span className="text-gray-300">{cpuUsed.toFixed(1)} cores</span></span>
                  <span>of <span className="text-gray-300">{cpuCapacity} cores</span></span>
                </div>
                {cpuReq > 0 && <div className="text-[8px] font-mono text-gray-600 mt-0.5">Requests: {cpuReq.toFixed(1)} cores · Limits: {cpuLim > 0 ? cpuLim.toFixed(1) + ' cores' : '—'}</div>}
              </div>
              <div className="stat-card p-2.5">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Memory — All Pods on Node</span>
                  <span className={`text-[11px] font-bold font-mono ${memPct > 80 ? 'text-red-400' : memPct > 60 ? 'text-yellow-400' : 'text-neon-green'}`}>{memPct.toFixed(0)}%</span>
                </div>
                <div className="w-full h-1.5 bg-hull-700 rounded-full overflow-hidden mb-1.5">
                  <div className={`h-full rounded-full transition-all ${memPct > 80 ? 'bg-red-500' : memPct > 60 ? 'bg-yellow-500' : 'bg-neon-green'}`} style={{ width: `${Math.min(memPct, 100)}%` }} />
                </div>
                <div className="flex justify-between text-[9px] font-mono text-gray-500">
                  <span>Used: <span className="text-gray-300">{fmtBytes(memUsed)}</span></span>
                  <span>of <span className="text-gray-300">{fmtBytes(memCapacity)}</span></span>
                </div>
                {memReq > 0 && <div className="text-[8px] font-mono text-gray-600 mt-0.5">Requests: {fmtBytes(memReq)} · Limits: {memLim > 0 ? fmtBytes(memLim) : '—'}</div>}
              </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-2 gap-3">
              {data.rr_cpu_used && (
                <MetricChart title="CPU — Total usage over time (all pods combined)" series={data.rr_cpu_used} unit="cores" refLines={cpuRefLines} />
              )}
              {data.rr_mem_used && (
                <MetricChart title="Memory — Total working set over time" series={data.rr_mem_used} unit="bytes" refLines={memRefLines} />
              )}
            </div>
            {(data.rr_mem_rss || data.rr_mem_cache) && (
              <div className="grid grid-cols-2 gap-3">
                {data.rr_mem_rss && <MetricChart title="Memory RSS (actual physical memory)" series={data.rr_mem_rss} unit="bytes" height={90} />}
                {data.rr_mem_cache && <MetricChart title="Memory Cache (reclaimable)" series={data.rr_mem_cache} unit="bytes" height={90} />}
              </div>
            )}
          </>
        )}

        {/* Raw metric fallbacks (self-hosted Prometheus) */}
        {hasData && !hasRR && hasRawMetrics && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {data.cpu && <MetricChart title="CPU Usage %" series={data.cpu} unit="%" />}
              {data.memory && <MetricChart title="Memory Usage %" series={data.memory} unit="%" />}
            </div>
            {data.fs_used && <MetricChart title="Disk Usage %" series={data.fs_used} unit="%" height={90} />}
          </>
        )}
      </div>
    </div>
  )
}

type ContainerResources = { container: string; cpuReqM: number; cpuLimM: number; memReqMi: number; memLimMi: number }
type PodMetricsResponse = MetricsData & { resources?: ContainerResources[] }

function PodMetricsPanel({ namespace, pod }: { namespace: string; pod: string }) {
  const [timeRange, setTimeRange] = useState('1h')
  const { data, loading, err } = useMetrics(`/api/metrics/pod?namespace=${encodeURIComponent(namespace)}&pod=${encodeURIComponent(pod)}`, timeRange)

  const podData = data as PodMetricsResponse | null
  const hasData = podData && Object.keys(podData).filter(k => k !== 'resources').length > 0

  const cpuRefLines = useMemo(() => {
    if (!podData?.resources) return []
    const lines: RefLine[] = []
    let totalReq = 0, totalLim = 0
    for (const r of podData.resources) {
      totalReq += r.cpuReqM || 0
      totalLim += r.cpuLimM || 0
    }
    if (totalReq > 0) lines.push({ value: totalReq, label: `req ${totalReq}m`, color: '#facc15' })
    if (totalLim > 0) lines.push({ value: totalLim, label: `lim ${totalLim}m`, color: '#f87171' })
    return lines
  }, [podData?.resources])

  const memRefLines = useMemo(() => {
    if (!podData?.resources) return []
    const lines: RefLine[] = []
    let totalReq = 0, totalLim = 0
    for (const r of podData.resources) {
      totalReq += r.memReqMi || 0
      totalLim += r.memLimMi || 0
    }
    if (totalReq > 0) lines.push({ value: totalReq, label: `req ${totalReq > 1024 ? (totalReq/1024).toFixed(1)+'Gi' : Math.round(totalReq)+'Mi'}`, color: '#facc15' })
    if (totalLim > 0) lines.push({ value: totalLim, label: `lim ${totalLim > 1024 ? (totalLim/1024).toFixed(1)+'Gi' : Math.round(totalLim)+'Mi'}`, color: '#f87171' })
    return lines
  }, [podData?.resources])

  return (
    <div className="rounded border border-hull-700 bg-hull-900">
      <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Metrics</span>
        <div className="flex gap-1">
          {METRIC_RANGES.map(r => (
            <button key={r} onClick={() => setTimeRange(r)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${timeRange === r ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-gray-600 hover:text-gray-400'}`}>{r}</button>
          ))}
        </div>
      </div>
      <div className="p-3 space-y-3">
        {loading && <div className="flex items-center justify-center py-6"><span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse mr-2" /><span className="text-[10px] text-gray-500">Loading metrics...</span></div>}
        {err && <p className="text-[10px] text-neon-amber text-center py-4">{err}</p>}
        {!loading && !err && !hasData && <p className="text-[10px] text-gray-500 text-center py-4">No metric data returned for this pod</p>}
        {hasData && (() => {
          const cpuSeries = podData.rr_cpu || podData.cpu
          const memSeries = podData.rr_memory || podData.memory
          const totalCpuReq = podData.resources?.reduce((a, r) => a + (r.cpuReqM || 0), 0) || 0
          const totalCpuLim = podData.resources?.reduce((a, r) => a + (r.cpuLimM || 0), 0) || 0
          const totalMemReq = podData.resources?.reduce((a, r) => a + (r.memReqMi || 0), 0) || 0
          const totalMemLim = podData.resources?.reduce((a, r) => a + (r.memLimMi || 0), 0) || 0
          const fmtMem = (v: number) => v > 1024 ? `${(v/1024).toFixed(1)} GiB` : `${Math.round(v)} MiB`
          const fmtCpu = (v: number) => v >= 1000 ? `${(v/1000).toFixed(1)} cores` : `${v}m`
          return (
          <>
            {podData.resources && podData.resources.length > 0 && (
              <div className="stat-card p-2.5">
                <div className="text-[9px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Container Resources</div>
                <div className="space-y-1">
                  {podData.resources.map(r => (
                    <div key={r.container} className="flex items-center gap-2 text-[9px] font-mono">
                      <span className="text-neon-cyan font-bold min-w-[80px] truncate">{r.container}</span>
                      <span className="text-gray-500">CPU:</span>
                      <span className="text-yellow-400">{r.cpuReqM ? fmtCpu(r.cpuReqM) : '—'} req</span>
                      <span className="text-gray-700">/</span>
                      <span className="text-red-400">{r.cpuLimM ? fmtCpu(r.cpuLimM) : '—'} lim</span>
                      <span className="text-gray-700 ml-2">|</span>
                      <span className="text-gray-500 ml-1">Mem:</span>
                      <span className="text-yellow-400">{r.memReqMi ? fmtMem(r.memReqMi) : '—'} req</span>
                      <span className="text-gray-700">/</span>
                      <span className="text-red-400">{r.memLimMi ? fmtMem(r.memLimMi) : '—'} lim</span>
                    </div>
                  ))}
                </div>
                {podData.resources.length > 1 && (
                  <div className="flex items-center gap-2 text-[9px] font-mono mt-1 pt-1 border-t border-hull-700">
                    <span className="text-gray-400 font-bold min-w-[80px]">Total</span>
                    <span className="text-gray-500">CPU:</span>
                    <span className="text-yellow-400">{totalCpuReq ? fmtCpu(totalCpuReq) : '—'}</span>
                    <span className="text-gray-700">/</span>
                    <span className="text-red-400">{totalCpuLim ? fmtCpu(totalCpuLim) : '—'}</span>
                    <span className="text-gray-700 ml-2">|</span>
                    <span className="text-gray-500 ml-1">Mem:</span>
                    <span className="text-yellow-400">{totalMemReq ? fmtMem(totalMemReq) : '—'}</span>
                    <span className="text-gray-700">/</span>
                    <span className="text-red-400">{totalMemLim ? fmtMem(totalMemLim) : '—'}</span>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {cpuSeries && <MetricChart title="CPU — actual usage vs request/limit" series={cpuSeries} unit="millicores" refLines={cpuRefLines} />}
              {memSeries && <MetricChart title="Memory — working set vs request/limit" series={memSeries} unit="MiB" refLines={memRefLines} />}
            </div>
            {(podData.rr_rss || podData.rr_cache) && (
              <div className="grid grid-cols-2 gap-3">
                {podData.rr_rss && <MetricChart title="Memory RSS (non-reclaimable physical memory)" series={podData.rr_rss} unit="MiB" height={90} />}
                {podData.rr_cache && <MetricChart title="Memory Cache (reclaimable page cache)" series={podData.rr_cache} unit="MiB" height={90} />}
              </div>
            )}
            {podData.throttle && podData.throttle.length > 0 && (
              <MetricChart title="CPU Throttling — % of time this pod is being throttled" series={podData.throttle} unit="%" height={90}
                refLines={[{ value: 25, label: '25% warn', color: '#f59e0b' }]} />
            )}
            <div className="grid grid-cols-2 gap-3">
              {podData.net_rx && <MetricChart title="Network In — bytes received per second" series={podData.net_rx} unit="bytes/s" height={90} />}
              {podData.net_tx && <MetricChart title="Network Out — bytes sent per second" series={podData.net_tx} unit="bytes/s" height={90} />}
            </div>
            {podData.restarts && podData.restarts.length > 0 && (
              <MetricChart title="Container Restarts — increasing = crash loop" series={podData.restarts} unit="" height={80} />
            )}
          </>
          )
        })()}
      </div>
    </div>
  )
}

type WorkloadResources = { replicas: number; cpuReqM: number; cpuLimM: number; memReqMi: number; memLimMi: number }
type WorkloadMetricsResponse = MetricsData & { resources?: WorkloadResources }

function WorkloadMetricsPanel({ namespace, name, kind }: { namespace: string; name: string; kind: string }) {
  const [timeRange, setTimeRange] = useState('1h')
  const { data, loading, err } = useMetrics(`/api/metrics/workload?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}&kind=${encodeURIComponent(kind)}`, timeRange)

  const wlData = data as WorkloadMetricsResponse | null
  const hasData = wlData && Object.keys(wlData).filter(k => k !== 'resources').length > 0
  const kindLower = kind.toLowerCase()

  const hasRR = !!(wlData?.rr_cpu_per_pod || wlData?.rr_mem_per_pod)
  const cpuPerPod = wlData?.rr_cpu_per_pod || wlData?.cpu_per_pod
  const memPerPod = wlData?.rr_mem_per_pod || wlData?.mem_per_pod
  const cpuTotal = wlData?.rr_cpu_total || wlData?.cpu_total
  const memTotal = wlData?.rr_mem_total || wlData?.mem_total

  const res = wlData?.resources

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">{kindLower} Metrics — {name}</span>
        <div className="flex gap-1">
          {METRIC_RANGES.map(r => (
            <button key={r} onClick={() => setTimeRange(r)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${timeRange === r ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-gray-600 hover:text-gray-400'}`}>{r}</button>
          ))}
        </div>
      </div>
      {loading && <div className="flex items-center justify-center py-8"><span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse mr-2" /><span className="text-[10px] text-gray-500">Loading metrics...</span></div>}
      {err && <p className="text-[10px] text-neon-amber text-center py-6">{err}</p>}
      {!loading && !err && !hasData && <p className="text-[10px] text-gray-500 text-center py-6">No metric data returned for this workload</p>}
      {hasData && (
        <>
          {/* Summary: resource overview */}
          {res && (
            <div className="grid grid-cols-3 gap-2">
              <div className="stat-card p-2 text-center">
                <div className="text-[9px] text-gray-500 uppercase tracking-wider">Pods</div>
                <div className="text-[14px] font-bold font-mono text-neon-cyan">{res.replicas}</div>
              </div>
              <div className="stat-card p-2">
                <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">CPU (total all pods)</div>
                <div className="flex justify-between text-[9px] font-mono">
                  <span className="text-yellow-400">Req: {res.cpuReqM > 0 ? (res.cpuReqM > 1000 ? (res.cpuReqM/1000).toFixed(1) + ' cores' : res.cpuReqM + 'm') : '—'}</span>
                  <span className="text-red-400">Lim: {res.cpuLimM > 0 ? (res.cpuLimM > 1000 ? (res.cpuLimM/1000).toFixed(1) + ' cores' : res.cpuLimM + 'm') : '—'}</span>
                </div>
              </div>
              <div className="stat-card p-2">
                <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Memory (total all pods)</div>
                <div className="flex justify-between text-[9px] font-mono">
                  <span className="text-yellow-400">Req: {res.memReqMi > 0 ? (res.memReqMi > 1024 ? (res.memReqMi/1024).toFixed(1) + ' GiB' : Math.round(res.memReqMi) + ' MiB') : '—'}</span>
                  <span className="text-red-400">Lim: {res.memLimMi > 0 ? (res.memLimMi > 1024 ? (res.memLimMi/1024).toFixed(1) + ' GiB' : Math.round(res.memLimMi) + ' MiB') : '—'}</span>
                </div>
              </div>
            </div>
          )}

          {/* CPU Usage — aggregated total */}
          {cpuTotal && cpuTotal.length > 0 && (
            <MetricChart title="CPU Usage — total across all pods" series={cpuTotal.map(s => ({ ...s, name: 'CPU Used' }))} unit="millicores" height={140} />
          )}
          {!cpuTotal?.length && cpuPerPod && cpuPerPod.length > 0 && (
            <MetricChart title={`CPU Usage — per pod (${cpuPerPod.length} pods)`} series={cpuPerPod} unit={hasRR ? 'cores' : 'millicores'} height={140} />
          )}

          {/* Memory Usage — aggregated total */}
          {memTotal && memTotal.length > 0 && (
            <MetricChart title="Memory Usage — total across all pods" series={memTotal.map(s => ({ ...s, name: 'Mem Used' }))} unit="MiB" height={140} />
          )}
          {!memTotal?.length && memPerPod && memPerPod.length > 0 && (
            <MetricChart title={`Memory Usage — per pod (${memPerPod.length} pods)`} series={memPerPod} unit={hasRR ? 'bytes' : 'MiB'} height={140} />
          )}

          {wlData.throttle && wlData.throttle.length > 0 && (
            <MetricChart title="CPU Throttling — % of time pods are being throttled (>25% needs attention)" series={wlData.throttle} unit="%" height={90}
              refLines={[{ value: 25, label: '25% warn', color: '#f59e0b' }]} />
          )}

          {/* Replica status */}
          {kindLower === 'deployment' && (wlData.replicas_desired || wlData.replicas || wlData.replicas_avl) && (
            <MetricChart title="Replica Count — desired vs available (gap = problem)" series={[
              ...(wlData.replicas_desired || []).map(s => ({ ...s, name: 'Desired' })),
              ...(wlData.replicas || []).map(s => ({ ...s, name: 'Current' })),
              ...(wlData.replicas_avl || []).map(s => ({ ...s, name: 'Available' })),
            ]} unit="" height={80} />
          )}

          {kindLower === 'statefulset' && (wlData.replicas_desired || wlData.replicas || wlData.replicas_avl) && (
            <MetricChart title="Replica Count — desired vs ready" series={[
              ...(wlData.replicas_desired || []).map(s => ({ ...s, name: 'Desired' })),
              ...(wlData.replicas || []).map(s => ({ ...s, name: 'Current' })),
              ...(wlData.replicas_avl || []).map(s => ({ ...s, name: 'Ready' })),
            ]} unit="" height={80} />
          )}

          {kindLower === 'daemonset' && (wlData.ds_desired || wlData.ds_ready) && (
            <MetricChart title="DaemonSet — desired vs ready (gap = nodes without the pod)" series={[
              ...(wlData.ds_desired || []).map(s => ({ ...s, name: 'Desired' })),
              ...(wlData.ds_ready || []).map(s => ({ ...s, name: 'Ready' })),
              ...(wlData.ds_available || []).map(s => ({ ...s, name: 'Available' })),
            ]} unit="" height={80} />
          )}

          {/* Restarts — spikes indicate crash loops */}
          {wlData.restarts && wlData.restarts.length > 0 && (
            <MetricChart title="Container Restarts — each line is one pod (spikes = crash loops)" series={wlData.restarts} unit="" height={80} />
          )}
        </>
      )}
    </div>
  )
}

// ─── Pod Detail (Logs + Events + Containers + Delete) ───────────────
function PodDetailView({ ns, name, onBack }: { ns: string; name: string; onBack: () => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [tab, setTab] = useState<'logs' | 'events' | 'info' | 'metrics'>('info')
  const [logs, setLogs] = useState<string[]>([])
  const [logStatus, setLogStatus] = useState<'connecting' | 'streaming' | 'ended' | 'error'>('connecting')
  const logEndRef = useRef<HTMLDivElement>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const { data: events } = useFetch<Evt[]>(`/api/pods/${ns}/${name}/events`, 15000)
  const { data: desc } = useFetch<PodDescribe>(`/api/pods/${ns}/${name}/describe`, 10000)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showShell, setShowShell] = useState(false)
  const [logContainer, setLogContainer] = useState('')

  useEffect(() => {
    setLogs([])
    setLogStatus('connecting')
    const containerParam = logContainer ? `&container=${logContainer}` : ''
    const es = new EventSource(`/api/pods/${ns}/${name}/logs?tail=300&follow=true${containerParam}`)
    es.onmessage = (e) => {
      setLogs(prev => {
        const next = [...prev, e.data]
        return next.length > 5000 ? next.slice(-3000) : next
      })
      setLogStatus('streaming')
    }
    es.onerror = () => {
      setLogStatus(s => s === 'streaming' ? 'ended' : 'error')
      es.close()
    }
    return () => es.close()
  }, [ns, name, logContainer])

  useEffect(() => {
    if (autoScroll && tab === 'logs' && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, tab, autoScroll])

  const handleLogScroll = useCallback(() => {
    const el = logContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAutoScroll(atBottom)
  }, [])

  const deletePod = async () => {
    setDeleting(true)
    try {
      await post(`/api/pods/${ns}/${name}/delete`)
      setToast('Pod deleted')
      setTimeout(onBack, 1500)
    } catch (e: any) {
      setToast(`Error: ${e.message}`)
      setDeleting(false)
      setTimeout(() => setToast(null), 3000)
    }
  }

  const tabs = ['info', 'logs', 'events', 'metrics'] as const
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showShell && <PodShell ns={ns} name={name} onClose={() => setShowShell(false)} />}
      {toast && <div className="border-b border-hull-700 bg-hull-800 px-4 py-2 text-xs text-gray-300">{toast}</div>}
      <div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2">
        <button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{name}</p>
          <p className="text-[10px] text-gray-600">{ns}{desc ? ` · ${desc.status} · ${desc.node}` : ''}</p>
        </div>
        {isAdmin && (
          <div className="flex gap-1.5">
            <button onClick={() => setShowShell(true)} className="rounded-md border border-cyan-900/40 bg-cyan-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-cyan-900/30">Shell</button>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} className="rounded-md border border-red-900/40 bg-red-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-red transition-colors hover:bg-red-900/40">Delete</button>
            ) : (
              <>
                <button onClick={() => setConfirmDelete(false)} className="rounded-md border border-hull-600 bg-hull-800 px-2 py-1 text-[10px] text-gray-400">Cancel</button>
                <button onClick={deletePod} disabled={deleting} className="rounded-md border border-red-900/50 bg-red-950/60 px-2 py-1 text-[10px] font-bold text-neon-red transition-colors hover:bg-red-900/40 disabled:opacity-40">
                  {deleting ? '…' : 'Confirm'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex gap-1 border-b border-hull-700 bg-hull-900 px-4 py-1">
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${tab === t ? 'bg-hull-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'info' && desc && (
          <div className="space-y-3">
            {/* Summary row */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-hull-700 bg-hull-800 p-2">
                <p className="text-[9px] uppercase text-gray-600">Status</p>
                <p className={`text-sm font-bold ${desc.status === 'Running' ? 'text-neon-green' : desc.status === 'Pending' ? 'text-neon-amber' : 'text-neon-red'}`}>{desc.status}</p>
              </div>
              <div className="rounded-lg border border-hull-700 bg-hull-800 p-2">
                <p className="text-[9px] uppercase text-gray-600">QoS</p>
                <p className="text-sm font-bold text-gray-300">{desc.qos}</p>
              </div>
              <div className="rounded-lg border border-hull-700 bg-hull-800 p-2">
                <p className="text-[9px] uppercase text-gray-600">Age</p>
                <p className="text-sm font-bold text-gray-300">{desc.age}</p>
              </div>
            </div>
            {desc.ip && <p className="text-[10px] text-gray-600">Pod IP: <span className="font-mono text-gray-400">{desc.ip}</span></p>}

            {/* AI Diagnose */}
            {desc.status !== 'Running' && desc.status !== 'Completed' && desc.status !== 'Succeeded' && (
              <AIDiagnoseButton namespace={ns} pod={name} />
            )}

            {/* Containers */}
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Containers</h3>
            {desc.containers.map(ct => (
              <div key={ct.name} className="rounded-lg border border-hull-700 bg-hull-800 p-3">
                <div className="flex items-center gap-2">
                  <StatusDot ok={ct.ready} />
                  <span className="flex-1 truncate text-sm font-medium text-white">{ct.name}</span>
                  <ContainerStateBadge state={ct.state} reason={ct.reason} />
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{ct.image}</p>
                <div className="mt-1.5 flex gap-3 text-[10px]">
                  {ct.restarts > 0 && <span className="text-neon-amber">↻ {ct.restarts} restarts</span>}
                  {ct.message && <span className="truncate text-gray-500">{ct.message}</span>}
                </div>
                {(ct.cpuUsedM > 0 || ct.memUsedMi > 0 || ct.cpuReqM > 0 || ct.memReqMi > 0) && (
                  <div className="mt-2.5 grid grid-cols-2 gap-3">
                    <ResourceBar used={ct.cpuUsedM} req={ct.cpuReqM} lim={ct.cpuLimM} label="CPU" unit="m" />
                    <ResourceBar used={ct.memUsedMi} req={ct.memReqMi} lim={ct.memLimMi} label="MEM" unit="Mi" />
                  </div>
                )}
              </div>
            ))}

            {/* Init Containers */}
            {desc.initContainers && desc.initContainers.length > 0 && (
              <>
                <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Init Containers</h3>
                {desc.initContainers.map(ct => (
                  <div key={ct.name} className="rounded-lg border border-hull-700 bg-hull-800 p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={ct.state === 'terminated' && ct.reason !== 'Error'} />
                      <span className="flex-1 truncate text-sm font-medium text-white">{ct.name}</span>
                      <span className="rounded bg-amber-950/40 border border-amber-900/30 px-1.5 py-0.5 text-[8px] font-bold uppercase text-amber-400">init</span>
                      <ContainerStateBadge state={ct.state} reason={ct.reason} />
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{ct.image}</p>
                    {ct.restarts > 0 && <p className="mt-1 text-[10px] text-neon-amber">↻ {ct.restarts} restarts</p>}
                    {ct.message && <p className="mt-0.5 text-[10px] text-gray-500 truncate">{ct.message}</p>}
                  </div>
                ))}
              </>
            )}

            {/* Conditions */}
            {desc.conditions.length > 0 && (
              <>
                <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Conditions</h3>
                <div className="space-y-1">
                  {desc.conditions.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.status === 'True' ? 'bg-neon-green' : 'bg-neon-red'}`} />
                      <span className="text-gray-400">{c.type}</span>
                      <span className="text-gray-600">{c.status}</span>
                      {c.reason && <span className="text-gray-600">({c.reason})</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {tab === 'info' && !desc && <Spinner />}
        {tab === 'logs' && (
          <div className="relative">
            <div className="flex items-center justify-between mb-2 px-1 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${logStatus === 'streaming' ? 'bg-neon-green animate-pulse' : logStatus === 'connecting' ? 'bg-neon-amber animate-pulse' : logStatus === 'ended' ? 'bg-gray-600' : 'bg-neon-red'}`} />
                <span className="text-[10px] text-gray-600 uppercase tracking-wider">{logStatus === 'streaming' ? 'Live' : logStatus === 'connecting' ? 'Connecting…' : logStatus === 'ended' ? 'Stream ended' : 'Error'}</span>
                <span className="text-[10px] text-gray-700">{logs.length} lines</span>
              </div>
              <div className="flex items-center gap-2">
                {desc && ((desc.initContainers?.length ?? 0) > 0 || desc.containers.length > 1) && (
                  <select value={logContainer} onChange={e => setLogContainer(e.target.value)} className="rounded-lg border border-hull-600 bg-hull-800 px-2 py-0.5 text-[10px] text-gray-300 outline-none">
                    <option value="">All containers</option>
                    {desc.initContainers?.map(c => (
                      <option key={`init-${c.name}`} value={c.name}>[init] {c.name}</option>
                    ))}
                    {desc.containers.map(c => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                )}
                <button onClick={() => setAutoScroll(!autoScroll)} className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${autoScroll ? 'border-neon-cyan/30 text-neon-cyan bg-neon-cyan/5' : 'border-hull-600 text-gray-500 hover:text-gray-300'}`}>
                  {autoScroll ? '⬇ Auto-scroll' : '⬇ Scroll paused'}
                </button>
              </div>
            </div>
            <div ref={logContainerRef} onScroll={handleLogScroll} className="max-h-[60vh] overflow-y-auto rounded-lg bg-hull-950 border border-hull-700/30 p-2 scrollbar-hide">
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-gray-400">{logs.length > 0 ? logs.join('\n') : (logStatus === 'connecting' ? 'Connecting to log stream…' : 'No logs available')}</pre>
              <div ref={logEndRef} />
            </div>
          </div>
        )}
        {tab === 'events' && (
          <div className="space-y-1.5">
            {events?.length === 0 && <p className="text-xs text-gray-600">No events</p>}
            {events?.map((e, i) => (
              <div key={i} className="rounded border border-hull-700 bg-hull-800 p-2 text-[11px]">
                <div className="flex gap-2">
                  <span className={e.type === 'Warning' ? 'text-neon-amber' : 'text-neon-green'}>{e.type}</span>
                  <span className="font-medium text-white">{e.reason}</span>
                  <span className="text-gray-600">{e.age} · ×{e.count}</span>
                </div>
                <p className="mt-0.5 text-gray-500">{e.message}</p>
              </div>
            ))}
          </div>
        )}
        {tab === 'metrics' && <PodMetricsPanel namespace={ns} pod={name} />}
      </div>
    </div>
  )
}

// ─── Node Describe ──────────────────────────────────────────────────
function NodeDescribeView({ name, onBack, onPod }: { name: string; onBack: () => void; onPod: (ns: string, name: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const { data, err, loading, refetch } = useFetch<NodeDescData>(`/api/nodes/${name}/describe`)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const act = async (action: string) => {
    setBusy(action)
    try { await post(`/api/nodes/${name}/${action}`); setToast(`${name} ${action}ed`); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  if (loading) return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2"><button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button><p className="text-sm font-medium text-white">{name}</p></div><Spinner /></div>
  if (err) return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2"><button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button></div><p className="p-4 text-neon-red">{err}</p></div>
  if (!data) return null

  const statusColor = data.status.includes('NotReady') ? 'text-neon-red' : data.status.includes('SchedulingDisabled') ? 'text-neon-amber' : 'text-neon-green'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toast && <div className="border-b border-hull-700 bg-hull-800 px-4 py-2 text-xs text-gray-300">{toast}</div>}
      <div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2">
        <button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{data.name}</p>
          <p className="text-[10px] text-gray-600">{data.role} · {data.version} · {data.age}</p>
        </div>
        {isAdmin && <div className="flex gap-1.5">
          {data.cordoned ? (
            <Btn small variant="success" onClick={() => act('uncordon')} disabled={!!busy}>{busy === 'uncordon' ? '…' : 'Uncordon'}</Btn>
          ) : (
            <>
              <Btn small onClick={() => act('cordon')} disabled={!!busy}>{busy === 'cordon' ? '…' : 'Cordon'}</Btn>
              <Btn small variant="danger" onClick={() => act('drain')} disabled={!!busy}>{busy === 'drain' ? '…' : 'Drain'}</Btn>
            </>
          )}
        </div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
        {/* Status + Resources */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Status</div>
          <div className="p-3 font-mono text-[11px] space-y-1.5">
            <div className="flex gap-4">
              <span className="text-gray-500 w-16 shrink-0">Status</span>
              <span className={statusColor}>{data.status}</span>
            </div>
            {data.addresses.map((a, i) => (
              <div key={i} className="flex gap-4">
                <span className="text-gray-500 w-16 shrink-0">{a.type}</span>
                <span className="text-gray-300">{a.address}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Resource usage */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Resources</div>
          <div className="p-3 space-y-2">
            <div className="font-mono text-[11px]">
              <div className="flex items-center gap-3">
                <span className="text-gray-500 w-10">CPU</span>
                <div className="flex-1"><K9sBar pct={data.cpuPercent} /></div>
                <span className={`tabular-nums ${data.cpuPercent > 80 ? 'text-neon-red' : data.cpuPercent > 50 ? 'text-neon-amber' : 'text-gray-400'}`}>{data.cpuPercent}%</span>
                <span className="text-gray-600">{data.usedCpuM}m / {data.allocCpuM}m</span>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-gray-500 w-10">MEM</span>
                <div className="flex-1"><K9sBar pct={data.memPercent} /></div>
                <span className={`tabular-nums ${data.memPercent > 80 ? 'text-neon-red' : data.memPercent > 50 ? 'text-neon-amber' : 'text-gray-400'}`}>{data.memPercent}%</span>
                <span className="text-gray-600">{data.usedMemMi}Mi / {data.allocMemMi}Mi</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-[10px] mt-2 border-t border-hull-700 pt-2">
              <div>
                <p className="text-gray-600 uppercase">Capacity</p>
                <p className="text-gray-400">CPU: {data.capacity.cpu}</p>
                <p className="text-gray-400">Mem: {data.capacity.memory}</p>
                <p className="text-gray-400">Pods: {data.capacity.pods}</p>
              </div>
              <div>
                <p className="text-gray-600 uppercase">Allocatable</p>
                <p className="text-gray-400">CPU: {data.allocatable.cpu}</p>
                <p className="text-gray-400">Mem: {data.allocatable.memory}</p>
                <p className="text-gray-400">Pods: {data.allocatable.pods}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Metrics graphs */}
        <NodeMetricsPanel nodeName={data.name} />

        {/* Conditions */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Conditions</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px] font-mono text-[11px]">
              <thead>
                <tr className="border-b border-hull-700 text-left text-[10px] uppercase text-gray-500">
                  <th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 font-medium">Age</th>
                  <th className="px-2 py-1 font-medium">Reason</th>
                  <th className="px-2 py-1 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {data.conditions.map((c, i) => (
                  <tr key={i} className="border-b border-hull-800 last:border-0">
                    <td className="whitespace-nowrap px-2 py-1 text-gray-400">{c.type}</td>
                    <td className={`whitespace-nowrap px-2 py-1 ${c.status === 'True' && c.type === 'Ready' ? 'text-neon-green' : c.status === 'True' ? 'text-neon-amber' : 'text-gray-500'}`}>{c.status}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-600">{c.age}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-500">{c.reason}</td>
                    <td className="px-2 py-1 text-gray-600 truncate max-w-[200px]">{c.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Events */}
        {data.events && data.events.length > 0 && (
          <div className="rounded border border-hull-700 bg-hull-900">
            <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan flex items-center justify-between">
              <span>Events <span className="font-normal text-gray-600">({data.events.length})</span></span>
              {data.events.some(e => e.type === 'Warning') && <span className="text-neon-amber font-normal normal-case tracking-normal text-[9px]">⚠ has warnings</span>}
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full min-w-[600px] font-mono text-[11px]">
                <thead className="sticky top-0 bg-hull-900 z-10">
                  <tr className="border-b border-hull-700 text-left text-[10px] uppercase text-gray-500">
                    <th className="px-2 py-1 font-medium w-12">Type</th>
                    <th className="px-2 py-1 font-medium">Reason</th>
                    <th className="px-2 py-1 font-medium w-16">Age</th>
                    <th className="px-2 py-1 font-medium">From</th>
                    <th className="px-2 py-1 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e, i) => (
                    <tr key={i} className="border-b border-hull-800 last:border-0">
                      <td className={`whitespace-nowrap px-2 py-1.5 font-bold ${e.type === 'Warning' ? 'text-neon-amber' : 'text-gray-500'}`}>{e.type === 'Warning' ? '⚠' : '●'}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 font-medium ${e.type === 'Warning' ? 'text-neon-amber' : 'text-gray-400'}`}>{e.reason}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-gray-500">{e.age}{e.count > 1 ? ` (x${e.count})` : ''}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-gray-600">{e.from}</td>
                      <td className="px-2 py-1.5 text-gray-400 break-words">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Taints */}
        {data.taints.length > 0 && (
          <div className="rounded border border-hull-700 bg-hull-900">
            <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Taints <span className="font-normal text-gray-600">({data.taints.length})</span></div>
            <div className="p-2 space-y-1">
              {data.taints.map((t, i) => (
                <div key={i} className="font-mono text-[11px]">
                  <span className="text-gray-400">{t.key}</span>
                  {t.value && <span className="text-gray-500">={t.value}</span>}
                  <span className="text-neon-amber">:{t.effect}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* System Info */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">System Info</div>
          <div className="p-2 font-mono text-[11px] space-y-0.5">
            {Object.entries({
              'OS': data.systemInfo.osImage,
              'Arch': data.systemInfo.arch,
              'Kernel': data.systemInfo.kernel,
              'Runtime': data.systemInfo.containerRuntime,
              'Kubelet': data.systemInfo.kubelet,
            }).map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <span className="text-gray-500 w-16 shrink-0">{k}</span>
                <span className="text-gray-400">{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Pods on node */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Pods <span className="font-normal text-gray-600">({data.pods.length})</span></div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px] font-mono text-[11px]">
              <thead>
                <tr className="border-b border-hull-700 text-left text-[10px] uppercase text-gray-500">
                  <th className="px-2 py-1 font-medium">Name</th>
                  <th className="px-2 py-1 font-medium">NS</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 font-medium">Ready</th>
                  <th className="px-2 py-1 font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {data.pods.map((p, i) => (
                  <tr key={i} onClick={() => onPod(p.namespace, p.name)} className="cursor-pointer border-b border-hull-800 transition-colors hover:bg-hull-800 active:bg-hull-700 last:border-0">
                    <td className="whitespace-nowrap px-2 py-1 text-white">{p.name}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-500">{p.namespace}</td>
                    <td className={`whitespace-nowrap px-2 py-1 ${p.status === 'Running' ? 'text-neon-green' : p.status === 'Pending' ? 'text-neon-amber' : 'text-neon-red'}`}>{p.status}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-400">{p.ready}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-600">{p.age}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Labels */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Labels <span className="font-normal text-gray-600">({Object.keys(data.labels).length})</span></div>
          <div className="p-2 space-y-0.5 max-h-40 overflow-auto">
            {Object.entries(data.labels).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => (
              <div key={k} className="font-mono text-[10px]">
                <span className="text-gray-500">{k}</span><span className="text-gray-600">=</span><span className="text-gray-400">{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Images */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Images <span className="font-normal text-gray-600">({data.images.length})</span></div>
          <div className="p-2 space-y-0.5 max-h-48 overflow-auto">
            {data.images.map((img, i) => (
              <div key={i} className="flex justify-between font-mono text-[10px]">
                <span className="truncate text-gray-400">{img.names[0]}</span>
                <span className="shrink-0 text-gray-600 ml-2">{img.size}Mi</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Services ───────────────────────────────────────────────────────
function ServicesView({ namespace }: { namespace: string }) {
  const url = namespace ? `/api/services?namespace=${namespace}` : '/api/services'
  const { data, err, loading } = useFetch<Service[]>(url, 10000)
  const [sortCol, setSortCol] = useState<'name' | 'ns' | 'type' | 'ports' | 'age'>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const toggle = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(true) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  const items = data ?? []
  const sorted = [...items].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'ns': cmp = a.namespace.localeCompare(b.namespace); break
      case 'type': cmp = a.type.localeCompare(b.type); break
      case 'ports': cmp = a.ports.localeCompare(b.ports); break
      case 'age': cmp = a.age.localeCompare(b.age); break
    }
    return sortAsc ? cmp : -cmp
  })

  const thCls = (col: typeof sortCol) =>
    `px-2 py-1.5 text-left font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''}`
  const arrow = (col: typeof sortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''
  const typeColor = (t: string) => t === 'LoadBalancer' ? 'text-neon-cyan' : t === 'NodePort' ? 'text-neon-amber' : t === 'ExternalName' ? 'text-purple-400' : 'text-gray-400'

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">⇌ SERVICES</span>
        <span className="ml-auto tabular-nums text-gray-600">{items.length} svc{items.length !== 1 ? 's' : ''}</span>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">⇌</span>
          <p className="text-gray-500 text-sm">No services found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hull-700/60">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-hull-800/80 text-gray-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className={thCls('ns')} onClick={() => toggle('ns')}>NS{arrow('ns')}</th>
                <th className={thCls('name')} onClick={() => toggle('name')}>Name{arrow('name')}</th>
                <th className={thCls('type')} onClick={() => toggle('type')}>Type{arrow('type')}</th>
                <th className="px-2 py-1.5 text-left font-medium">ClusterIP</th>
                <th className="px-2 py-1.5 text-left font-medium">External</th>
                <th className={thCls('ports')} onClick={() => toggle('ports')}>Ports{arrow('ports')}</th>
                <th className={thCls('age')} onClick={() => toggle('age')}>Age{arrow('age')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(s => (
                <tr key={`${s.namespace}/${s.name}`} className="border-t border-hull-800 transition-colors hover:bg-hull-800/60">
                  <td className="px-2 py-1.5 text-gray-500 max-w-[80px] truncate">{s.namespace}</td>
                  <td className="px-2 py-1.5 text-white font-semibold">{s.name}</td>
                  <td className={`px-2 py-1.5 font-bold ${typeColor(s.type)}`}>{s.type}</td>
                  <td className="px-2 py-1.5 text-gray-400 font-mono">{s.clusterIP || '-'}</td>
                  <td className="px-2 py-1.5 text-neon-amber max-w-[120px] truncate text-[10px]">{s.externalIP || <span className="text-gray-700">-</span>}</td>
                  <td className="px-2 py-1.5 text-gray-300 max-w-[180px] truncate">{s.ports || '-'}</td>
                  <td className="px-2 py-1.5 text-gray-500">{s.age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Events ─────────────────────────────────────────────────────────
function EventsView({ namespace }: { namespace: string }) {
  const [typeFilter, setTypeFilter] = useState<'' | 'Warning' | 'Normal'>('')
  const params = new URLSearchParams()
  if (typeFilter) params.set('type', typeFilter)
  if (namespace) params.set('namespace', namespace)
  const qs = params.toString() ? '?' + params.toString() : ''
  const { data, err, loading } = useFetch<ClusterEvent[]>(`/api/events${qs}`, 10000)
  const [search, setSearch] = useState('')

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const items = (data ?? []).filter(e => {
    if (!search) return true
    const q = search.toLowerCase()
    return e.object.toLowerCase().includes(q) || e.message.toLowerCase().includes(q) || e.reason.toLowerCase().includes(q) || e.namespace.toLowerCase().includes(q)
  })

  const warnCount = items.filter(e => e.type === 'Warning').length
  const normalCount = items.filter(e => e.type === 'Normal').length

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
        <span className="rounded bg-hull-800 border border-hull-700 px-2 py-0.5 text-gray-300 font-bold tracking-wide">◷ EVENTS</span>
        <span className={`text-[10px] tabular-nums ${warnCount > 0 ? 'text-neon-amber' : 'text-gray-600'}`}>{warnCount} warn</span>
        <span className="text-[10px] tabular-nums text-gray-600">{normalCount} normal</span>
        <span className="ml-auto text-gray-600">{items.length} total</span>
      </div>

      <div className="flex gap-2 items-center">
        <div className="flex rounded-lg border border-hull-700/60 overflow-hidden text-[10px]">
          {(['', 'Warning', 'Normal'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)} className={`px-2.5 py-1 transition-colors ${typeFilter === t ? 'bg-hull-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              {t || 'All'}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter events..."
          className="flex-1 rounded-lg border border-hull-700/60 bg-hull-900 px-2.5 py-1 text-[11px] text-gray-300 placeholder-gray-700 outline-none focus:border-neon-cyan/40" />
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◷</span>
          <p className="text-gray-500 text-sm">No events found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hull-700/60">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-hull-800/80 text-gray-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Age</th>
                <th className="px-2 py-1.5 text-left font-medium">Type</th>
                <th className="px-2 py-1.5 text-left font-medium">Reason</th>
                <th className="px-2 py-1.5 text-left font-medium">Kind</th>
                <th className="px-2 py-1.5 text-left font-medium">Object</th>
                <th className="px-2 py-1.5 text-left font-medium">NS</th>
                <th className="px-2 py-1.5 text-left font-medium">#</th>
                <th className="px-2 py-1.5 text-left font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 200).map((e, i) => (
                <tr key={i} className="border-t border-hull-800 transition-colors hover:bg-hull-800/60">
                  <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{e.age}</td>
                  <td className={`px-2 py-1.5 font-bold whitespace-nowrap ${e.type === 'Warning' ? 'text-neon-amber' : 'text-neon-green'}`}>{e.type === 'Warning' ? '⚠' : '✓'}</td>
                  <td className="px-2 py-1.5 text-white whitespace-nowrap">{e.reason}</td>
                  <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{e.kind}</td>
                  <td className="px-2 py-1.5 text-gray-400 max-w-[140px] truncate">{e.object.split('/')[1] || e.object}</td>
                  <td className="px-2 py-1.5 text-gray-600 max-w-[80px] truncate">{e.namespace}</td>
                  <td className="px-2 py-1.5 text-gray-600 tabular-nums">{e.count > 1 ? e.count : ''}</td>
                  <td className="px-2 py-1.5 text-gray-500 max-w-[250px] truncate">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Troubled Pods (non-healthy watch) ───────────────────────────────
function TroubledPodsView({ onPod }: { onPod: (ns: string, name: string) => void }) {
  const { data, err, loading } = useFetch<Pod[]>('/api/pods', 5000)
  const fs = useFullscreen()
  type TroubledSortCol = 'name' | 'ns' | 'status' | 'restarts' | 'age' | 'node'
  const [sortCol, setSortCol] = useState<TroubledSortCol>(() => {
    try { return (localStorage.getItem('troubled-sort-col') as TroubledSortCol) || 'status' } catch { return 'status' }
  })
  const [sortAsc, setSortAsc] = useState(() => {
    try { return localStorage.getItem('troubled-sort-asc') !== 'false' } catch { return true }
  })

  const toggle = (col: typeof sortCol) => {
    if (sortCol === col) {
      const next = !sortAsc
      setSortAsc(next)
      try { localStorage.setItem('troubled-sort-asc', String(next)) } catch {}
    } else {
      setSortCol(col); setSortAsc(true)
      try { localStorage.setItem('troubled-sort-col', col); localStorage.setItem('troubled-sort-asc', 'true') } catch {}
    }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const troubled = (data ?? []).filter(p => {
    const s = p.status
    if (s === 'Running' || s === 'Succeeded' || s === 'Completed') return false
    return true
  })

  const sorted = [...troubled].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'ns': cmp = a.namespace.localeCompare(b.namespace); break
      case 'status': cmp = a.status.localeCompare(b.status); break
      case 'restarts': cmp = a.restarts - b.restarts; break
      case 'age': cmp = a.age.localeCompare(b.age); break
      case 'node': cmp = a.node.localeCompare(b.node); break
    }
    return sortAsc ? cmp : -cmp
  })

  const f = fs.active
  const thCls = (col: typeof sortCol) =>
    `${f ? 'px-3 py-2.5' : 'px-2 py-1.5'} text-left font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''}`
  const arrow = (col: typeof sortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''

  const statusColor = (s: string) => {
    if (s === 'Pending') return 'text-neon-amber'
    if (s === 'Terminating') return 'text-gray-500'
    if (/CrashLoop|OOMKill|Error|BackOff|ImagePull|ErrImage/i.test(s)) return 'text-neon-red animate-pulse'
    if (s === 'Failed' || s === 'Unknown') return 'text-neon-red'
    return 'text-neon-amber'
  }

  return (
    <div ref={fs.ref} className={`space-y-2 ${f ? 'bg-hull-950 h-screen overflow-auto p-5' : 'p-3'}`}>
      <div className={`flex items-center gap-2 font-mono ${f ? 'text-sm' : 'text-[11px]'}`}>
        <span className={`rounded bg-red-950/60 border border-red-900/50 text-neon-red font-bold tracking-wide ${f ? 'px-3 py-1' : 'px-2 py-0.5'}`}>⚠ TROUBLED</span>
        <span className={f ? 'text-gray-400' : 'text-gray-500'}>pods not Running / Completed</span>
        <span className={`ml-auto tabular-nums ${f ? 'text-gray-400' : 'text-gray-600'}`}>{troubled.length} pod{troubled.length !== 1 ? 's' : ''}</span>
        <FullscreenBtn active={f} onEnter={fs.enter} onExit={fs.exit} />
      </div>

      {troubled.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2">✓</span>
          <p className="text-neon-green font-medium text-sm">All clear</p>
          <p className="text-gray-600 text-[11px] mt-1">No troubled pods in the cluster</p>
        </div>
      ) : (
        <div className="space-y-2">
        <p className={`text-gray-600 ${f ? 'text-xs' : 'text-[9px]'}`}>Click any pod for details, or use AI Diagnose in the pod detail view</p>
        <div className="overflow-x-auto rounded-lg border border-hull-700">
          <table className={`w-full font-mono ${f ? 'text-sm' : 'text-[11px]'}`}>
            <thead className={`bg-hull-800 uppercase tracking-wider sticky top-0 z-10 ${f ? 'text-gray-400 text-xs' : 'text-gray-500 text-[10px]'}`}>
              <tr>
                <th className={thCls('ns')} onClick={() => toggle('ns')}>NS{arrow('ns')}</th>
                <th className={thCls('name')} onClick={() => toggle('name')}>Name{arrow('name')}</th>
                <th className={thCls('status')} onClick={() => toggle('status')}>Status{arrow('status')}</th>
                <th className={`${f ? 'px-3 py-2.5' : 'px-2 py-1.5'} text-left font-medium`}>Ready</th>
                <th className={thCls('restarts')} onClick={() => toggle('restarts')}>Restarts{arrow('restarts')}</th>
                <th className={thCls('age')} onClick={() => toggle('age')}>Age{arrow('age')}</th>
                <th className={thCls('node')} onClick={() => toggle('node')}>Node{arrow('node')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const cp = f ? 'px-3 py-2.5' : 'px-2 py-1.5'
                return (
                <tr key={`${p.namespace}-${p.name}`}
                  onClick={() => onPod(p.namespace, p.name)}
                  className="border-t border-hull-800 cursor-pointer transition-colors hover:bg-hull-800/60 active:bg-hull-700"
                >
                  <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-500'} ${f ? '' : 'max-w-[90px]'} truncate`} title={p.namespace}>{p.namespace}</td>
                  <td className={`${cp} text-white ${f ? '' : 'max-w-[200px]'} truncate`} title={p.name}>{p.name}</td>
                  <td className={`${cp} font-bold ${statusColor(p.status)}`}>{p.status}</td>
                  <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-400'}`}>{p.ready}</td>
                  <td className={`${cp} tabular-nums ${p.restarts > 0 ? 'text-neon-amber font-bold' : f ? 'text-gray-400' : 'text-gray-600'}`}>{p.restarts}</td>
                  <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-500'}`}>{p.age}</td>
                  <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-400'} ${f ? '' : 'max-w-[200px]'} truncate`} title={p.node}>{p.node}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </div>
      )}
    </div>
  )
}

// ─── HPA View ────────────────────────────────────────────────────────

// ─── Topology Spread View ────────────────────────────────────────────

type TopologyConstraint = { topologyKey: string; topologyLabel: string; maxSkew: number; whenUnsatisfiable: string; enforcement: string; description: string; labelSelector: string }
type TopologyDomain = { domain: string; count: number }
type TopologyWorkload = { kind: string; name: string; namespace: string; replicas: number; constraint: TopologyConstraint; actualSkew: number; distribution: TopologyDomain[]; emptyDomains: number; totalDomains: number; status: string }
type TopologyData = { workloads: TopologyWorkload[] }

function TopologySpreadView() {
  const { data, err, loading } = useFetch<TopologyData>('/api/topology-spread', 15000)
  const [statusFilter, setStatusFilter] = useState<'all' | 'violated' | 'at-limit' | 'single-domain'>('all')
  const [keyFilter, setKeyFilter] = useState<string>('all')
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const workloads = data?.workloads || []
  const violated = workloads.filter(w => w.status === 'violated')
  const atLimit = workloads.filter(w => w.status === 'at-limit')
  const satisfied = workloads.filter(w => w.status === 'satisfied')
  const singleDomain = workloads.filter(w => w.status === 'single-domain')

  // Collect unique topology key labels for classification tabs
  const keyLabels = Array.from(new Set(workloads.map(w => w.constraint.topologyLabel || w.constraint.topologyKey)))

  // Build per-key stats for the classification tabs
  const keyStats = new Map<string, { total: number; violated: number; atLimit: number; singleDomain: number }>()
  for (const w of workloads) {
    const label = w.constraint.topologyLabel || w.constraint.topologyKey
    const s = keyStats.get(label) || { total: 0, violated: 0, atLimit: 0, singleDomain: 0 }
    s.total++
    if (w.status === 'violated') s.violated++
    else if (w.status === 'at-limit') s.atLimit++
    else if (w.status === 'single-domain') s.singleDomain++
    keyStats.set(label, s)
  }

  const filtered = workloads.filter(w => {
    if (statusFilter !== 'all' && w.status !== statusFilter) return false
    if (keyFilter !== 'all' && (w.constraint.topologyLabel || w.constraint.topologyKey) !== keyFilter) return false
    return true
  })

  const statusBadge = (s: string) => {
    if (s === 'violated') return 'bg-red-950/60 border-red-900/50 text-neon-red'
    if (s === 'at-limit') return 'bg-amber-950/60 border-amber-900/50 text-neon-amber'
    if (s === 'single-domain') return 'bg-gray-950/60 border-gray-800/50 text-gray-400'
    return 'bg-green-950/40 border-green-900/30 text-neon-green'
  }
  const statusLabel = (s: string) => {
    if (s === 'violated') return 'VIOLATED'
    if (s === 'at-limit') return 'AT LIMIT'
    if (s === 'single-domain') return 'N/A'
    return 'OK'
  }

  const toggleExpand = (key: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const topologyIcon = (key: string) => {
    if (key.includes('hostname')) return '◎'
    if (key.includes('zone')) return '◉'
    if (key.includes('region')) return '⊕'
    if (key.includes('instance-type')) return '▣'
    return '◈'
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2 font-mono text-[11px] flex-wrap">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">◈ TOPOLOGY SPREAD</span>
        <span className="text-gray-500">workloads with TopologySpreadConstraints</span>
        <span className="ml-auto tabular-nums text-gray-600">{workloads.length} constraint{workloads.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Status summary cards */}
      <div className="grid grid-cols-4 gap-2">
        <button onClick={() => setStatusFilter(statusFilter === 'violated' ? 'all' : 'violated')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'violated' ? 'ring-1 ring-neon-red/40' : ''}`}>
          <p className={`text-lg font-extrabold tabular-nums ${violated.length > 0 ? 'text-neon-red' : 'text-gray-600'}`}>{violated.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Violated</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'at-limit' ? 'all' : 'at-limit')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'at-limit' ? 'ring-1 ring-neon-amber/40' : ''}`}>
          <p className={`text-lg font-extrabold tabular-nums ${atLimit.length > 0 ? 'text-neon-amber' : 'text-gray-600'}`}>{atLimit.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">At Limit</p>
        </button>
        <button onClick={() => setStatusFilter('all')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'all' ? 'ring-1 ring-neon-cyan/30' : ''}`}>
          <p className="text-lg font-extrabold tabular-nums text-neon-green">{satisfied.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Satisfied</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'single-domain' ? 'all' : 'single-domain')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'single-domain' ? 'ring-1 ring-gray-500/40' : ''}`}>
          <p className={`text-lg font-extrabold tabular-nums ${singleDomain.length > 0 ? 'text-gray-400' : 'text-gray-600'}`}>{singleDomain.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Single Domain</p>
        </button>
      </div>

      {/* Topology key classification tabs */}
      {keyLabels.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setKeyFilter('all')}
            className={`rounded border px-2 py-1 text-[10px] font-mono transition-all ${keyFilter === 'all' ? 'bg-indigo-950/60 border-indigo-800/60 text-indigo-300' : 'bg-hull-900/40 border-hull-700/30 text-gray-500 hover:text-gray-300'}`}>
            All Keys <span className="text-gray-600 ml-0.5">({workloads.length})</span>
          </button>
          {keyLabels.map(label => {
            const stats = keyStats.get(label)
            const hasIssues = (stats?.violated || 0) > 0 || (stats?.atLimit || 0) > 0
            return (
              <button key={label} onClick={() => setKeyFilter(keyFilter === label ? 'all' : label)}
                className={`rounded border px-2 py-1 text-[10px] font-mono transition-all flex items-center gap-1.5 ${keyFilter === label ? 'bg-indigo-950/60 border-indigo-800/60 text-indigo-300' : 'bg-hull-900/40 border-hull-700/30 text-gray-500 hover:text-gray-300'}`}>
                <span className="text-indigo-400">{topologyIcon(label)}</span>
                {label}
                <span className="text-gray-600">({stats?.total || 0})</span>
                {(stats?.violated || 0) > 0 && <span className="h-1.5 w-1.5 rounded-full bg-neon-red" title={`${stats!.violated} violated`} />}
                {(stats?.atLimit || 0) > 0 && !hasIssues && <span className="h-1.5 w-1.5 rounded-full bg-neon-amber" title={`${stats!.atLimit} at limit`} />}
              </button>
            )
          })}
        </div>
      )}

      {workloads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◈</span>
          <p className="text-gray-400 text-sm">No workloads with TopologySpreadConstraints found</p>
          <p className="text-[10px] text-gray-600 mt-1">Add <code className="text-gray-400">topologySpreadConstraints</code> to your deployment specs</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <p className="text-gray-500 text-xs">No constraints match the current filters</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((w, i) => {
            const maxCount = w.distribution.length > 0 ? Math.max(...w.distribution.map(d => d.count)) : 1
            const rowKey = `${w.namespace}-${w.name}-${w.constraint.topologyKey}-${i}`
            const isExpanded = expandedRows.has(rowKey)
            const isHard = w.constraint.enforcement === 'Hard'
            const isSingleDomain = w.status === 'single-domain'

            return (
              <div key={rowKey} className={`stat-card overflow-hidden ${isSingleDomain ? 'opacity-60' : ''}`}>
                <div className="p-3">
                  {/* Header row */}
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${statusBadge(w.status)}`}>{statusLabel(w.status)}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${isHard ? 'bg-red-950/40 border-red-900/40 text-red-400' : 'bg-sky-950/40 border-sky-900/40 text-sky-400'}`}>{isHard ? 'HARD' : 'SOFT'}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider bg-indigo-950/40 border-indigo-900/40 text-indigo-400`}>
                          {topologyIcon(w.constraint.topologyKey)} {w.constraint.topologyLabel || w.constraint.topologyKey}
                        </span>
                        <span className="text-[10px] text-gray-500 font-mono">{w.kind}</span>
                        <span className="text-sm font-bold text-white font-mono">{w.namespace}/{w.name}</span>
                        <span className="text-[10px] text-gray-500 tabular-nums">{w.replicas} pod{w.replicas !== 1 ? 's' : ''}</span>
                      </div>

                      <p className="mt-1.5 text-[10px] text-gray-300/80 italic leading-relaxed">{w.constraint.description}</p>

                      {isSingleDomain ? (
                        <p className="mt-1 text-[10px] text-gray-500">Only {w.totalDomains} domain{w.totalDomains !== 1 ? 's' : ''} found for this topology key — skew cannot be evaluated. All pods are in: <span className="font-mono text-gray-400">{w.distribution[0]?.domain || '—'}</span></p>
                      ) : (
                        <div className="flex items-center gap-3 mt-1.5 text-[10px] flex-wrap">
                          <span className="text-gray-400">key: <span className="text-neon-cyan font-mono">{w.constraint.topologyKey}</span></span>
                          <span className="text-gray-400">maxSkew: <span className="font-mono text-white">{w.constraint.maxSkew}</span></span>
                          <span className="text-gray-400">actual: <span className={`font-mono font-bold ${w.status === 'violated' ? 'text-neon-red' : w.status === 'at-limit' ? 'text-neon-amber' : 'text-neon-green'}`}>{w.actualSkew}</span></span>
                          <span className="text-gray-400">domains: <span className="font-mono text-white">{w.totalDomains}</span></span>
                          {w.constraint.labelSelector && (
                            <span className="text-gray-400">selector: <span className="font-mono text-purple-400">{w.constraint.labelSelector}</span></span>
                          )}
                        </div>
                      )}
                    </div>
                    {!isSingleDomain && (
                      <button onClick={() => toggleExpand(rowKey)} className="text-gray-500 hover:text-gray-300 transition-colors text-[10px] font-mono shrink-0 mt-0.5" title={isExpanded ? 'Collapse' : 'Expand distribution'}>
                        {isExpanded ? '▼' : '▶'} dist
                      </button>
                    )}
                  </div>

                  {/* Distribution bars */}
                  {isExpanded && !isSingleDomain && (
                    <div className="mt-2.5 space-y-1">
                      {w.distribution.map(d => (
                        <div key={d.domain} className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-gray-400 w-[160px] truncate shrink-0" title={d.domain}>{d.domain}</span>
                          <div className="flex-1 h-2 rounded-full bg-hull-800/80 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                d.count === maxCount && w.status === 'violated' ? 'bg-gradient-to-r from-red-500/70 to-red-400/50' :
                                d.count === 0 ? 'bg-transparent' :
                                w.status === 'at-limit' ? 'bg-gradient-to-r from-amber-500/70 to-amber-400/50' :
                                'bg-gradient-to-r from-neon-cyan/60 to-neon-cyan/30'
                              }`}
                              style={{ width: `${maxCount > 0 ? Math.round(d.count * 100 / maxCount) : 0}%` }}
                            />
                          </div>
                          <span className={`text-[10px] font-mono tabular-nums w-6 text-right ${d.count === 0 ? 'text-neon-red font-bold' : d.count === maxCount && w.status === 'violated' ? 'text-neon-red' : 'text-gray-400'}`}>{d.count}</span>
                        </div>
                      ))}
                      {w.emptyDomains > 0 && (
                        <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono mt-0.5">
                          <span className="w-[160px] shrink-0">…and {w.emptyDomains} more empty {w.constraint.topologyLabel?.toLowerCase() || 'domain'}s</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── HPA View ────────────────────────────────────────────────────────

function HPAView({ namespace }: { namespace: string }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<HPA[]>(`/api/hpa${q}`, 10000)

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const list = data ?? []

  const scaleHealth = (h: HPA) => {
    if (h.currentReplicas >= h.maxReplicas) return 'capped'
    if (h.currentReplicas <= h.minReplicas && h.desiredReplicas > h.currentReplicas) return 'starved'
    return 'ok'
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="rounded bg-purple-950/60 border border-purple-900/50 px-2 py-0.5 text-purple-400 font-bold tracking-wide">⟳ HPA</span>
        <span className="text-gray-500">Horizontal Pod Autoscalers</span>
        <span className="ml-auto tabular-nums text-gray-600">{list.length}</span>
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">⟳</span>
          <p className="text-gray-500 text-sm">No HPAs found</p>
        </div>
      ) : list.map(h => {
        const health = scaleHealth(h)
        const pct = h.maxReplicas > 0 ? (h.currentReplicas / h.maxReplicas) * 100 : 0
        return (
          <div key={`${h.namespace}-${h.name}`} className="stat-card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{h.name}</p>
                <div className="flex items-center gap-2 mt-0.5 text-[10px]">
                  <span className="text-gray-500">{h.namespace}</span>
                  <span className="text-gray-700">·</span>
                  <span className="text-gray-400 font-mono">{h.reference}</span>
                </div>
              </div>
              <span className={`shrink-0 rounded-lg border px-2 py-0.5 text-[10px] font-bold ${health === 'capped' ? 'bg-red-950/40 border-red-900/30 text-neon-red' : health === 'starved' ? 'bg-amber-950/40 border-amber-900/30 text-neon-amber' : 'bg-green-950/40 border-green-900/30 text-neon-green'}`}>
                {health === 'capped' ? 'AT MAX' : health === 'starved' ? 'SCALING' : 'HEALTHY'}
              </span>
            </div>

            {/* Replicas bar */}
            <div>
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-gray-500">Replicas</span>
                <span className="tabular-nums font-mono">
                  <span className="text-neon-cyan font-bold">{h.currentReplicas}</span>
                  <span className="text-gray-600"> / {h.minReplicas}–{h.maxReplicas}</span>
                  {h.desiredReplicas !== h.currentReplicas && <span className="text-neon-amber ml-1">(wants {h.desiredReplicas})</span>}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-500 ${health === 'capped' ? 'bg-gradient-to-r from-red-500 to-red-400' : health === 'starved' ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-neon-cyan to-neon-green'}`} style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
            </div>

            {/* Metrics */}
            {h.metrics.length > 0 && (
              <div className="space-y-1">
                {h.metrics.map((m, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px] rounded-lg bg-hull-800/40 px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-400 capitalize">{m.name || m.type}</span>
                      <span className="text-[9px] text-gray-600 uppercase">{m.type}</span>
                    </div>
                    <div className="font-mono tabular-nums">
                      <span className={`font-bold ${m.current && m.target && parseInt(m.current) > parseInt(m.target) ? 'text-neon-red' : 'text-neon-cyan'}`}>{m.current || '—'}</span>
                      <span className="text-gray-600"> / {m.target}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between text-[9px] text-gray-600">
              <span>Age: {h.age}</span>
              {h.conditions.length > 0 && (
                <span className={h.conditions.some(c => c.status === 'False') ? 'text-neon-amber' : 'text-gray-600'}>
                  {h.conditions.map(c => c.type).join(', ')}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Config View ─────────────────────────────────────────────────────

function ConfigDataPanel({ item, onClose }: { item: ConfigItem; onClose: () => void }) {
  const kind = item.kind === 'Secret' ? 'secret' : 'configmap'
  const { data, err, loading } = useFetch<ConfigDataResp>(`/api/configs/${item.namespace}/${item.name}?kind=${kind}`)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const toggleReveal = (key: string) => {
    setRevealedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const copyValue = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    })
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <button onClick={onClose} className="text-neon-cyan text-xs hover:underline">← Back</button>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold border ${item.kind === 'Secret' ? 'bg-amber-950/40 border-amber-900/30 text-amber-400' : 'bg-sky-950/40 border-sky-900/30 text-sky-400'}`}>
          {item.kind === 'Secret' ? 'SEC' : 'CM'}
        </span>
        <span className="text-sm font-bold text-white font-mono truncate">{item.name}</span>
        <span className="text-[10px] text-gray-500">{item.namespace}</span>
      </div>

      {loading && <Spinner />}
      {err && <p className="text-neon-red text-xs">{err}</p>}
      {data && (
        <div className="space-y-1.5">
          {data.masked && (
            <div className="rounded-lg bg-amber-950/20 border border-amber-900/30 px-2.5 py-1.5">
              <span className="text-[10px] text-amber-400">Secret values are hidden for non-admin users</span>
            </div>
          )}
          {data.entries.length === 0 ? (
            <p className="text-gray-500 text-[11px] italic py-4 text-center">No data entries</p>
          ) : data.entries.map(e => (
            <div key={e.key} className="stat-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-[11px] font-mono font-medium text-neon-cyan truncate min-w-0 flex-1">{e.key}</span>
                <div className="flex gap-1 shrink-0">
                  {data.masked ? (
                    <span className="text-[10px] text-gray-600 font-mono">••••••••</span>
                  ) : (
                    <>
                      {item.kind === 'Secret' && (
                        <button onClick={() => toggleReveal(e.key)} className="rounded px-1.5 py-0.5 text-[9px] border border-hull-600/50 text-gray-400 hover:text-white hover:border-hull-500 transition-colors">
                          {revealedKeys.has(e.key) ? 'Hide' : 'Reveal'}
                        </button>
                      )}
                      <button onClick={() => copyValue(e.key, e.value)} className="rounded px-1.5 py-0.5 text-[9px] border border-hull-600/50 text-gray-400 hover:text-neon-green hover:border-green-900/50 transition-colors">
                        {copiedKey === e.key ? '✓' : 'Copy'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {(!data.masked && (item.kind !== 'Secret' || revealedKeys.has(e.key))) && (
                <div className="border-t border-hull-700/30 bg-hull-900/50 px-3 py-2">
                  <pre className="text-[10px] font-mono text-gray-300 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{e.value}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConfigView({ namespace }: { namespace: string }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<ConfigItem[]>(`/api/configs${q}`, 15000)
  const [kindFilter, setKindFilter] = useState<'' | 'ConfigMap' | 'Secret'>('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [viewing, setViewing] = useState<ConfigItem | null>(null)
  if (viewing) return <ConfigDataPanel item={viewing} onClose={() => setViewing(null)} />

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const all = data ?? []
  const filtered = all.filter(c =>
    (kindFilter === '' || c.kind === kindFilter) &&
    (search === '' || c.name.toLowerCase().includes(search.toLowerCase()) || c.namespace.toLowerCase().includes(search.toLowerCase()))
  )
  const cmCount = all.filter(c => c.kind === 'ConfigMap').length
  const secCount = all.filter(c => c.kind === 'Secret').length

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">⚙ CONFIG</span>
        <div className="flex gap-1">
          <button onClick={() => setKindFilter('')} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium border transition-colors ${kindFilter === '' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All ({all.length})</button>
          <button onClick={() => setKindFilter(kindFilter === 'ConfigMap' ? '' : 'ConfigMap')} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium border transition-colors ${kindFilter === 'ConfigMap' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>CM ({cmCount})</button>
          <button onClick={() => setKindFilter(kindFilter === 'Secret' ? '' : 'Secret')} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium border transition-colors ${kindFilter === 'Secret' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>Sec ({secCount})</button>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter..." className="ml-auto rounded-lg border border-hull-600/50 bg-hull-800/60 px-2 py-0.5 text-[11px] text-gray-300 outline-none w-28 placeholder:text-gray-700" />
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">⚙</span>
          <p className="text-gray-500 text-sm">No configs found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map(c => {
            const key = `${c.kind}-${c.namespace}-${c.name}`
            const isExpanded = expanded === key
            return (
              <div key={key} className="stat-card overflow-hidden">
                <div className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-hull-800/40 transition-colors" onClick={() => setExpanded(isExpanded ? null : key)}>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold border ${c.kind === 'Secret' ? 'bg-amber-950/40 border-amber-900/30 text-amber-400' : 'bg-sky-950/40 border-sky-900/30 text-sky-400'}`}>
                    {c.kind === 'Secret' ? 'SEC' : 'CM'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-white">{c.name}</span>
                    <span className="text-[10px] text-gray-500">{c.namespace}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[11px] tabular-nums text-gray-400">{c.keyCount} key{c.keyCount !== 1 ? 's' : ''}</span>
                    <span className="block text-[9px] text-gray-600">{c.age}</span>
                    <span className="block text-[9px] text-gray-600">modified {c.modifiedAgo} ago</span>
                  </div>
                  <span className={`text-gray-600 text-[10px] transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▸</span>
                </div>
                {isExpanded && (
                  <div className="border-t border-hull-700/30 bg-hull-900/40 px-3 py-2">
                    {c.type && <p className="text-[10px] text-gray-500 mb-1.5">Type: <span className="text-gray-400 font-mono">{c.type}</span></p>}
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-gray-500">Keys:</p>
                      <button onClick={(e) => { e.stopPropagation(); setViewing(c) }} className="rounded-lg px-2 py-0.5 text-[9px] font-medium border border-neon-cyan/30 text-neon-cyan hover:bg-cyan-950/30 transition-colors">
                        View Data
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.keys.length === 0 ? <span className="text-[10px] text-gray-600 italic">empty</span> : c.keys.map(k => (
                        <span key={k} className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-0.5 text-[10px] font-mono text-gray-300">{k}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Pod Shell ───────────────────────────────────────────────────────

function PodShell({ ns, name, container, onClose }: { ns: string; name: string; container?: string; onClose: () => void }) {
  const termRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let term: any = null
    let fitAddon: any = null
    let disposed = false

    const init = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      if (disposed || !termRef.current) return

      term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
        theme: {
          background: '#0a0e14',
          foreground: '#c5c8c6',
          cursor: '#06d6e0',
          selectionBackground: '#2a4858',
          black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
          blue: '#81a2be', magenta: '#b294bb', cyan: '#06d6e0', white: '#c5c8c6',
        },
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(termRef.current)
      fitAddon.fit()

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const params = new URLSearchParams({ namespace: ns, pod: name })
      if (container) params.set('container', container)
      const ws = new WebSocket(`${proto}//${window.location.host}/api/exec?${params}`)
      wsRef.current = ws

      ws.onopen = () => {
        term.write('\r\n\x1b[36mConnected to pod shell\x1b[0m\r\n\r\n')
      }
      ws.onmessage = (e) => {
        term.write(e.data)
      }
      ws.onclose = () => {
        term.write('\r\n\x1b[33mSession closed\x1b[0m\r\n')
      }
      ws.onerror = () => {
        term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n')
      }

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data)
      })

      const resizeOb = new ResizeObserver(() => { if (fitAddon) fitAddon.fit() })
      resizeOb.observe(termRef.current)
    }

    init()

    return () => {
      disposed = true
      if (wsRef.current) wsRef.current.close()
      if (term) term.dispose()
    }
  }, [ns, name, container])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-hull-950/95 backdrop-blur-sm pt-safe">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-hull-700/40">
        <div className="min-w-0">
          <p className="text-xs font-bold text-white truncate">Shell: {name}</p>
          <p className="text-[10px] text-gray-500">{ns}{container ? ` / ${container}` : ''}</p>
        </div>
        <button onClick={onClose} className="rounded-lg bg-red-950/40 border border-red-900/20 px-3 py-1 text-[11px] font-medium text-red-400 hover:bg-red-950/60 transition-colors">Close</button>
      </div>
      <div ref={termRef} className="flex-1 p-1" />
    </div>
  )
}

// ─── Spot Advisor ────────────────────────────────────────────────────

function SpotAdvisorView() {
  const { data, err, loading } = useFetch<SpotAdvisorData>('/api/spot-advisor', 60000)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  if (!data || !data.ready) return (
    <div className="flex flex-col items-center justify-center py-16 text-center p-4">
      <span className="text-3xl mb-3 opacity-40">◎</span>
      <p className="text-gray-400 text-sm">{data?.message || 'Loading spot advisor data...'}</p>
      <p className="text-[10px] text-gray-600 mt-1">Data refreshes every 10 minutes</p>
    </div>
  )

  const irColor = (r: number) => r === 0 ? 'text-neon-green' : r === 1 ? 'text-neon-cyan' : r === 2 ? 'text-neon-amber' : 'text-neon-red'
  const irBg = (r: number) => r === 0 ? 'bg-green-950/40 border-green-900/20' : r === 1 ? 'bg-cyan-950/40 border-cyan-900/20' : r === 2 ? 'bg-amber-950/40 border-amber-900/20' : 'bg-red-950/40 border-red-900/20'
  const pctColor = (p: number) => p > 80 ? 'text-neon-red' : p > 50 ? 'text-neon-amber' : 'text-neon-cyan'
  const barGrad = (p: number) => p > 80 ? 'from-red-500 to-red-400' : p > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'

  const totalNodes = data.totalSpotNodes
  const totalVCPUs = data.recommendations.reduce((sum, r) => sum + r.current.vcpus * r.current.count, 0)
  const totalMem = data.recommendations.reduce((sum, r) => sum + r.current.memoryGiB * r.current.count, 0)
  const totalMonthlyCost = data.recommendations.reduce((sum, r) => sum + r.current.totalMonthlyCost, 0)
  const totalPotentialSaving = data.recommendations.reduce((sum, r) => {
    const best = r.alternatives.length > 0 ? r.alternatives[0] : null
    return sum + (best && best.monthlySaving > 0 ? best.monthlySaving : 0)
  }, 0)

  return (
    <div className="space-y-3 p-3">
      {/* Header */}
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="rounded bg-orange-950/60 border border-orange-900/50 px-2 py-0.5 text-orange-400 font-bold tracking-wide">◎ SPOT ADVISOR</span>
        <span className="text-gray-500">{data.region}</span>
        <span className="ml-auto text-[9px] text-gray-700">Updated {new Date(data.lastRefresh).toLocaleTimeString()}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-orange-400 tabular-nums">{totalNodes}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Spot Nodes</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-white tabular-nums">{data.recommendations.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Instance Types</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-neon-cyan tabular-nums">{totalVCPUs}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Total vCPUs</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-neon-green tabular-nums">{Math.round(totalMem)} <span className="text-xs font-normal text-gray-500">GiB</span></p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Total Memory</p>
        </div>
      </div>

      {/* Cluster cost overview */}
      {data.clusterCost && data.clusterCost.totalMonthlyCost > 0 && (() => {
        const cc = data.clusterCost!
        const spotPct = cc.totalMonthlyCost > 0 ? Math.round(cc.spotMonthlyCost * 100 / cc.totalMonthlyCost) : 0
        const odPct = 100 - spotPct
        return (
          <div className="stat-card overflow-hidden">
            <div className="p-3 border-b border-hull-700/30">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neon-cyan">Total Cluster Cost</span>
            </div>
            <div className="grid grid-cols-3 gap-0 divide-x divide-hull-700/30">
              <div className="p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Total Compute</p>
                <p className="text-2xl font-extrabold text-white tabular-nums">${cc.totalMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
                <p className="text-[9px] text-gray-600 mt-0.5 tabular-nums">{cc.totalNodes} nodes</p>
              </div>
              <div className="p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Spot</p>
                <p className="text-2xl font-extrabold text-orange-400 tabular-nums">${cc.spotMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
                <p className="text-[9px] text-gray-600 mt-0.5 tabular-nums">{cc.spotNodes} nodes · {spotPct}%</p>
              </div>
              <div className="p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">On-Demand</p>
                <p className="text-2xl font-extrabold text-sky-400 tabular-nums">${cc.onDemandMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
                <p className="text-[9px] text-gray-600 mt-0.5 tabular-nums">{cc.onDemandNodes} nodes · {odPct}%</p>
              </div>
            </div>
            {/* Spot vs On-Demand proportion bar */}
            <div className="px-3 pb-3">
              <div className="flex h-2 rounded-full overflow-hidden bg-hull-800/80 mt-1">
                {spotPct > 0 && <div className="bg-gradient-to-r from-orange-500 to-orange-400 transition-all duration-500" style={{ width: `${spotPct}%` }} />}
                {odPct > 0 && <div className="bg-gradient-to-r from-sky-500 to-sky-400 transition-all duration-500" style={{ width: `${odPct}%` }} />}
              </div>
              <div className="flex justify-between mt-1 text-[8px] font-mono">
                <span className="text-orange-400/70">Spot {spotPct}%</span>
                <span className="text-sky-400/70">On-Demand {odPct}%</span>
              </div>
            </div>
            {/* On-Demand instance type breakdown */}
            {cc.onDemandByType && cc.onDemandByType.length > 0 && (
              <div className="px-3 pb-3">
                <p className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">On-Demand Breakdown</p>
                <div className="flex flex-wrap gap-1.5">
                  {cc.onDemandByType.map(t => (
                    <span key={t.instanceType} className="rounded bg-sky-950/30 border border-sky-900/30 px-1.5 py-0.5 text-[9px] font-mono text-sky-400/80">
                      {t.instanceType} <span className="text-gray-500">×{t.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Spot cost & potential savings */}
      {totalMonthlyCost > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="stat-card p-3 text-center">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Current Spot Cost</p>
            <p className="text-2xl font-extrabold text-white tabular-nums">${totalMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Potential Savings</p>
            <p className={`text-2xl font-extrabold tabular-nums ${totalPotentialSaving > 0 ? 'text-neon-green' : 'text-gray-500'}`}>{totalPotentialSaving > 0 ? `-$${totalPotentialSaving.toFixed(0)}` : '$0'}<span className="text-xs font-normal text-gray-500">/mo</span></p>
          </div>
        </div>
      )}

      {/* Consolidation Opportunities */}
      {data.consolidations && data.consolidations.length > 0 && (
        <div className="stat-card overflow-hidden">
          <div className="p-3 border-b border-hull-700/30">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neon-green">⬢ Consolidation Opportunities</span>
              <span className="text-[9px] text-gray-600">fewer, larger nodes for your workload</span>
            </div>
            <p className="text-[10px] text-gray-500">
              Your {data.totalSpotNodes} spot nodes use <span className="text-gray-300 font-mono">{((data.totalEffectiveCpuM || 0) / 1000).toFixed(1)}c CPU</span> and <span className="text-gray-300 font-mono">{((data.totalEffectiveMemMi || 0) / 1024).toFixed(1)}G MEM</span> effective.
              These larger instance types can fit the same workload with fewer nodes.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead className="bg-hull-800/60 text-gray-500 text-[9px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-1.5 text-left">Instance Type</th>
                  <th className="px-2 py-1.5 text-center">Spec</th>
                  <th className="px-2 py-1.5 text-center">Interrupt</th>
                  <th className="px-2 py-1.5 text-center">Nodes</th>
                  <th className="px-2 py-1.5 text-right">$/mo</th>
                  <th className="px-3 py-1.5 text-right">Saving</th>
                </tr>
              </thead>
              <tbody>
                {data.consolidations.map((c, i) => (
                  <tr key={c.instanceType} className={`border-t border-hull-800/50 ${i === 0 ? 'bg-green-950/10' : ''}`}>
                    <td className="px-3 py-2">
                      <span className="text-neon-cyan font-medium">{c.instanceType}</span>
                      <p className="text-[8px] text-gray-500 font-normal mt-0.5">
                        replaces {c.replacesNodes} nodes ({c.replacesTypes.join(', ')})
                      </p>
                    </td>
                    <td className="px-2 py-2 text-center text-gray-300 text-[9px]">{c.vcpus}c / {c.memoryGB}G</td>
                    <td className="px-2 py-2 text-center">
                      <span className={`font-medium ${c.interruptRange === 0 ? 'text-neon-green' : c.interruptRange === 1 ? 'text-neon-cyan' : c.interruptRange <= 2 ? 'text-neon-amber' : 'text-neon-red'}`}>{c.interruptLabel}</span>
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className="text-neon-green font-bold">{c.nodesNeeded}</span>
                      <span className="text-gray-600 ml-0.5 text-[8px]">vs {c.replacesNodes}</span>
                    </td>
                    <td className="px-2 py-2 text-right text-gray-300">{c.totalMonthlyCost > 0 ? `$${c.totalMonthlyCost.toFixed(0)}` : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {c.monthlySaving > 0 ? (
                        <span className="text-neon-green font-bold">-${c.monthlySaving.toFixed(0)}</span>
                      ) : c.monthlySaving < 0 ? (
                        <span className="text-neon-red">+${Math.abs(c.monthlySaving).toFixed(0)}</span>
                      ) : <span className="text-gray-500">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-hull-700/20 bg-hull-900/30">
            <p className="text-[9px] text-gray-600">
              💡 Fewer nodes = less scheduling overhead, faster autoscaling, and simpler cluster management.
              Trade-off: larger blast radius per node failure. Consider using multiple AZs.
            </p>
          </div>
        </div>
      )}

      {/* Per-type Recommendations */}
      {data.recommendations.map(rec => {
        const c = rec.current
        const isExpanded = expanded === c.instanceType
        const bestAlt = rec.alternatives.length > 0 ? rec.alternatives[0] : null

        return (
          <div key={c.instanceType} className="stat-card overflow-hidden">
            <div className="p-3 cursor-pointer hover:bg-hull-800/40 transition-colors" onClick={() => setExpanded(isExpanded ? null : c.instanceType)}>
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white font-mono">{c.instanceType}</span>
                    <span className="text-[11px] text-gray-500">x{c.count}</span>
                    {c.totalMonthlyCost > 0 && <span className="text-[10px] font-mono text-gray-400">${c.totalMonthlyCost.toFixed(0)}/mo</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] flex-wrap">
                    <span className="text-gray-400">{c.vcpus} vCPU</span>
                    <span className="text-gray-700">·</span>
                    <span className="text-gray-400">{c.memoryGiB} GiB</span>
                    {c.spotPrice > 0 && (
                      <>
                        <span className="text-gray-700">·</span>
                        <span className="text-gray-400 font-mono">${c.spotPrice.toFixed(4)}/hr</span>
                      </>
                    )}
                    {c.nodepools.map(np => (
                      <span key={np} className="rounded bg-purple-950/50 border border-purple-900/20 px-1 py-px text-[9px] text-purple-400">{np}</span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold tabular-nums ${irBg(c.interruptRange)} ${irColor(c.interruptRange)}`}>
                    {c.interruptLabel}
                  </span>
                  <span className="text-[9px] text-gray-600">{isExpanded ? '▾' : '▸'} {rec.alternatives.length} alternatives</span>
                </div>
              </div>

              {/* Utilization bars */}
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider">CPU load</span>
                    <span className="font-mono text-[9px] text-gray-400">{(c.effectiveCpuM / 1000).toFixed(1)}c / {(c.totalAllocCpuM / 1000).toFixed(1)}c <span className={`font-bold ${pctColor(c.avgCpuPct)}`}>{c.avgCpuPct}%</span></span>
                  </div>
                  <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                    <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(c.avgCpuPct)} transition-all duration-700`} style={{ width: `${Math.min(c.avgCpuPct, 100)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider">MEM load</span>
                    <span className="font-mono text-[9px] text-gray-400">{(c.effectiveMemMi / 1024).toFixed(1)}G / {(c.totalAllocMemMi / 1024).toFixed(1)}G <span className={`font-bold ${pctColor(c.avgMemPct)}`}>{c.avgMemPct}%</span></span>
                  </div>
                  <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                    <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(c.avgMemPct)} transition-all duration-700`} style={{ width: `${Math.min(c.avgMemPct, 100)}%` }} />
                  </div>
                </div>
              </div>

              {/* Quick recommendation banner */}
              {bestAlt && bestAlt.monthlySaving > 0 && (
                <div className="mt-2 rounded-lg bg-green-950/20 border border-green-900/20 px-2.5 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-neon-green">💡</span>
                  <span className="text-[10px] text-gray-300">
                    <span className="font-mono font-bold text-neon-cyan">{bestAlt.instanceType}</span> x{bestAlt.nodesNeeded} → save <span className="font-bold text-neon-green">${bestAlt.monthlySaving.toFixed(0)}/mo</span>
                    <span className="text-gray-500 ml-1">({bestAlt.interruptLabel} interrupt)</span>
                  </span>
                </div>
              )}
              {bestAlt && bestAlt.monthlySaving <= 0 && bestAlt.interruptRange < c.interruptRange && (
                <div className="mt-2 rounded-lg bg-cyan-950/20 border border-cyan-900/20 px-2.5 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-neon-cyan">🛡</span>
                  <span className="text-[10px] text-gray-300">
                    <span className="font-mono font-bold text-neon-cyan">{bestAlt.instanceType}</span> x{bestAlt.nodesNeeded} — lower interruption ({bestAlt.interruptLabel})
                  </span>
                </div>
              )}
              {rec.alternatives.length === 0 && (
                <div className="mt-2 rounded-lg bg-hull-800/30 border border-hull-700/20 px-2.5 py-1.5">
                  <span className="text-[10px] text-gray-500">Already optimal for this workload profile</span>
                </div>
              )}
            </div>

            {/* Expanded alternatives */}
            {isExpanded && rec.alternatives.length > 0 && (
              <div className="border-t border-hull-700/30 bg-hull-900/40">
                <div className="px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Workload-aware alternatives (considering {(c.effectiveCpuM / 1000).toFixed(1)}c CPU / {(c.effectiveMemMi / 1024).toFixed(1)}G MEM load)</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] font-mono">
                    <thead className="bg-hull-800/60 text-gray-500 text-[9px] uppercase tracking-wider">
                      <tr>
                        <th className="px-3 py-1.5 text-left">Type</th>
                        <th className="px-2 py-1.5 text-center">Spec</th>
                        <th className="px-2 py-1.5 text-center">Interrupt</th>
                        <th className="px-2 py-1.5 text-center">Nodes</th>
                        <th className="px-2 py-1.5 text-right">Total $/mo</th>
                        <th className="px-3 py-1.5 text-right">Saving</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rec.alternatives.map((alt, i) => (
                        <tr key={alt.instanceType} className={`border-t border-hull-800/50 ${i === 0 ? 'bg-green-950/10' : ''}`}>
                          <td className="px-3 py-1.5">
                            <span className="text-neon-cyan font-medium">{alt.instanceType}</span>
                            <p className="text-[8px] text-gray-600 font-normal mt-0.5">{alt.fitNote}</p>
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-300 text-[9px]">{alt.vcpus}c / {alt.memoryGB}G</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`${irColor(alt.interruptRange)} font-medium`}>{alt.interruptLabel}</span>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`font-bold ${alt.nodesNeeded <= c.count ? 'text-neon-green' : 'text-neon-amber'}`}>{alt.nodesNeeded}</span>
                            <span className="text-gray-600 ml-0.5 text-[8px]">vs {c.count}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right text-gray-300">{alt.totalMonthlyCost > 0 ? `$${alt.totalMonthlyCost.toFixed(0)}` : '—'}</td>
                          <td className="px-3 py-1.5 text-right">
                            {alt.monthlySaving > 0 ? (
                              <span className="text-neon-green font-bold">-${alt.monthlySaving.toFixed(0)}</span>
                            ) : alt.monthlySaving < 0 ? (
                              <span className="text-neon-red">+${Math.abs(alt.monthlySaving).toFixed(0)}</span>
                            ) : <span className="text-gray-500">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {isExpanded && rec.alternatives.length === 0 && (
              <div className="border-t border-hull-700/30 bg-hull-900/40 px-3 py-4 text-center">
                <p className="text-[11px] text-gray-500">No cheaper or more reliable alternatives found for this workload</p>
              </div>
            )}
          </div>
        )
      })}

      {data.recommendations.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◎</span>
          <p className="text-gray-400 text-sm">No spot instances found</p>
          <p className="text-[10px] text-gray-600 mt-1">Nodes need <code className="text-gray-400">karpenter.sh/capacity-type=spot</code> label</p>
        </div>
      )}

      {/* Cost Allocation */}
      <CostAllocationPanel />

      {/* AI Spot Analysis */}
      {data.recommendations.length > 0 && <AISpotAnalysis />}
    </div>
  )
}

// ─── Ingress Detail ─────────────────────────────────────────────────
function IngressDetailView({ ns, name, onBack }: { ns: string; name: string; onBack: () => void }) {
  const { data, err, loading } = useFetch<IngressDescData>(`/api/ingresses/${ns}/${name}`)

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner /></div>
  if (err) return <div className="p-4"><button onClick={onBack} className="text-neon-cyan text-xs mb-2">← Back</button><p className="text-neon-red">{err}</p></div>
  if (!data) return null

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">{title}</h3>
      {children}
    </div>
  )

  const KV = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-[10px] text-gray-500 min-w-[80px] shrink-0">{label}</span>
      <span className={`text-[11px] text-gray-200 break-all ${mono ? 'font-mono' : ''}`}>{value || '-'}</span>
    </div>
  )

  return (
    <div className="flex h-full flex-col bg-hull-950">
      <header className="shrink-0 glass border-0 border-b border-hull-700/40 px-4 py-2.5 flex items-center gap-3">
        <button onClick={onBack} className="rounded-lg glass px-2.5 py-1 text-xs text-gray-400 hover:text-neon-cyan transition-colors">← Back</button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">⇌</span>
          <span className="font-mono text-sm font-bold text-white truncate">{data.name}</span>
          <Pill color="bg-indigo-900/60 text-indigo-300">Ingress</Pill>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Basic Info */}
        <Section title="Overview">
          <div className="stat-card p-3 space-y-0.5">
            <KV label="Namespace" value={data.namespace} />
            <KV label="Class" value={data.class} />
            <KV label="Age" value={data.age} />
            {data.defaultBackend && <KV label="Default" value={data.defaultBackend} mono />}
          </div>
        </Section>

        {/* Load Balancer */}
        {data.addresses.length > 0 && (
          <Section title="Load Balancer">
            <div className="flex flex-wrap gap-1.5">
              {data.addresses.map((a, i) => (
                <span key={i} className="rounded-lg bg-hull-800/60 border border-hull-700/40 px-2.5 py-1 font-mono text-[11px] text-neon-amber">{a}</span>
              ))}
            </div>
          </Section>
        )}

        {/* Routing Rules */}
        {data.rules.length > 0 && (
          <Section title="Routing Rules">
            <div className="overflow-x-auto rounded-xl border border-hull-700/60">
              <table className="w-full text-[11px] font-mono">
                <thead className="bg-hull-800/80 text-[9px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left">Host</th>
                    <th className="px-2.5 py-1.5 text-left">Path</th>
                    <th className="px-2.5 py-1.5 text-left">Type</th>
                    <th className="px-2.5 py-1.5 text-left">Backend</th>
                    <th className="px-2.5 py-1.5 text-left">Port</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rules.map((r, i) => (
                    <tr key={i} className="border-t border-hull-800/50">
                      <td className="px-2.5 py-1.5 text-neon-cyan">{r.host}</td>
                      <td className="px-2.5 py-1.5 text-white">{r.path}</td>
                      <td className="px-2.5 py-1.5 text-gray-500">{r.pathType || '-'}</td>
                      <td className="px-2.5 py-1.5 text-neon-amber font-semibold">{r.backend}</td>
                      <td className="px-2.5 py-1.5 text-gray-400">{r.port}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* TLS */}
        {data.tls.length > 0 && (
          <Section title="TLS">
            <div className="space-y-2">
              {data.tls.map((t, i) => (
                <div key={i} className="stat-card p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-neon-green font-bold text-[11px]">✓ TLS</span>
                    <span className="font-mono text-[10px] text-gray-400">{t.secretName || 'default'}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(t.hosts || []).map((h, hi) => (
                      <span key={hi} className="rounded bg-hull-800/60 border border-hull-700/40 px-2 py-0.5 text-[10px] text-neon-cyan font-mono">{h}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Annotations */}
        {Object.keys(data.annotations).length > 0 && (
          <Section title="Annotations">
            <div className="stat-card p-3 space-y-1 max-h-60 overflow-y-auto">
              {Object.entries(data.annotations).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => (
                <div key={k} className="flex gap-2 py-0.5 text-[10px] border-b border-hull-800/30 last:border-0">
                  <span className="text-neon-cyan font-mono shrink-0 break-all">{k}</span>
                  <span className="text-gray-400 font-mono break-all ml-auto text-right">{v}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Labels */}
        {Object.keys(data.labels).length > 0 && (
          <Section title="Labels">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.labels).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => (
                <span key={k} className="rounded-lg bg-hull-800/60 border border-hull-700/40 px-2 py-0.5 text-[10px] font-mono">
                  <span className="text-neon-cyan">{k}</span><span className="text-gray-600">=</span><span className="text-gray-300">{v}</span>
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Events */}
        {data.events.length > 0 && (
          <Section title="Events">
            <div className="overflow-x-auto rounded-xl border border-hull-700/60">
              <table className="w-full text-[11px]">
                <thead className="bg-hull-800/80 text-[9px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Type</th>
                    <th className="px-2 py-1.5 text-left">Reason</th>
                    <th className="px-2 py-1.5 text-left">Message</th>
                    <th className="px-2 py-1.5 text-left">Age</th>
                    <th className="px-2 py-1.5 text-left">#</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e, i) => (
                    <tr key={i} className="border-t border-hull-800/50">
                      <td className={`px-2 py-1.5 font-bold ${e.type === 'Warning' ? 'text-neon-amber' : 'text-neon-green'}`}>{e.type}</td>
                      <td className="px-2 py-1.5 text-white">{e.reason}</td>
                      <td className="px-2 py-1.5 text-gray-400 max-w-[200px] truncate">{e.message}</td>
                      <td className="px-2 py-1.5 text-gray-500">{e.age}</td>
                      <td className="px-2 py-1.5 text-gray-600 tabular-nums">{e.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

// ─── Ingresses ──────────────────────────────────────────────────────
function IngressesView({ namespace, onIngress }: { namespace: string; onIngress: (ns: string, name: string) => void }) {
  const url = namespace ? `/api/ingresses?namespace=${namespace}` : '/api/ingresses'
  const { data, err, loading } = useFetch<Ingress[]>(url, 10000)
  const [sortCol, setSortCol] = useState<'name' | 'ns' | 'class' | 'hosts' | 'age'>('name')
  const [sortAsc, setSortAsc] = useState(true)

  const toggle = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(true) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const items = data ?? []
  const sorted = [...items].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'ns': cmp = a.namespace.localeCompare(b.namespace); break
      case 'class': cmp = a.class.localeCompare(b.class); break
      case 'hosts': cmp = (a.hosts.join(',') || '').localeCompare(b.hosts.join(',') || ''); break
      case 'age': cmp = a.age.localeCompare(b.age); break
    }
    return sortAsc ? cmp : -cmp
  })

  const thCls = (col: typeof sortCol) =>
    `px-2 py-1.5 text-left font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''}`
  const arrow = (col: typeof sortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">⇌ INGRESS</span>
        <span className="text-gray-500">networking ingress resources</span>
        <span className="ml-auto tabular-nums text-gray-600">{items.length} ingress{items.length !== 1 ? 'es' : ''}</span>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">⇌</span>
          <p className="text-gray-500 font-medium text-sm">No ingresses found</p>
          <p className="text-gray-700 text-[11px] mt-1">{namespace ? `in namespace "${namespace}"` : 'across all namespaces'}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hull-700/60">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-hull-800/80 text-gray-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className={thCls('ns')} onClick={() => toggle('ns')}>NS{arrow('ns')}</th>
                <th className={thCls('name')} onClick={() => toggle('name')}>Name{arrow('name')}</th>
                <th className={thCls('class')} onClick={() => toggle('class')}>Class{arrow('class')}</th>
                <th className={thCls('hosts')} onClick={() => toggle('hosts')}>Hosts{arrow('hosts')}</th>
                <th className="px-2 py-1.5 text-left font-medium">TLS</th>
                <th className="px-2 py-1.5 text-left font-medium">LB</th>
                <th className="px-2 py-1.5 text-left font-medium text-center">Rules</th>
                <th className={thCls('age')} onClick={() => toggle('age')}>Age{arrow('age')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(ing => (
                <tr key={`${ing.namespace}/${ing.name}`}
                  onClick={() => onIngress(ing.namespace, ing.name)}
                  className="border-t border-hull-800 cursor-pointer transition-colors hover:bg-hull-800/60 active:bg-hull-700"
                >
                  <td className="px-2 py-1.5 text-gray-500 max-w-[90px] truncate">{ing.namespace}</td>
                  <td className="px-2 py-1.5 text-white font-semibold">{ing.name}</td>
                  <td className="px-2 py-1.5">
                    {ing.class ? <Pill color="bg-indigo-900/60 text-indigo-300">{ing.class}</Pill> : <span className="text-gray-700">-</span>}
                  </td>
                  <td className="px-2 py-1.5 text-neon-cyan max-w-[180px] truncate">{ing.hosts.join(', ') || '*'}</td>
                  <td className="px-2 py-1.5 text-center">
                    {ing.tls ? <span className="text-neon-green font-bold">✓</span> : <span className="text-gray-700">-</span>}
                  </td>
                  <td className="px-2 py-1.5 text-gray-400 max-w-[120px] truncate text-[10px]">{ing.addresses.join(', ') || <span className="text-gray-700">pending</span>}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums text-gray-400">{ing.rules.length}</td>
                  <td className="px-2 py-1.5 text-gray-500">{ing.age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── AI Components ───────────────────────────────────────────────────

function useAIStream() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async (url: string, body?: object) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setText('')
    setError(null)
    setLoading(true)

    try {
      const resp = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const err = await resp.text()
        try { setError(JSON.parse(err).error || err) } catch { setError(err) }
        setLoading(false)
        return
      }

      const reader = resp.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) { setError('No response stream'); setLoading(false); return }

      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.done) break
            if (parsed.text) setText(prev => prev + parsed.text)
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    }
    setLoading(false)
  }, [])

  const cancel = useCallback(() => { abortRef.current?.abort(); setLoading(false) }, [])

  return { text, loading, error, run, cancel }
}

function AIResponsePanel({ text, loading, error }: { text: string; loading: boolean; error: string | null }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [text])

  if (error) return <div className="rounded-lg bg-red-950/20 border border-red-900/30 p-3"><p className="text-neon-red text-xs">{error}</p></div>

  if (!text && loading) return (
    <div className="flex items-center gap-2 py-6 justify-center">
      <span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse" />
      <span className="text-[11px] text-gray-400">AI is analyzing...</span>
    </div>
  )

  if (!text && !loading) return null

  return (
    <div className="rounded-lg bg-hull-900/60 border border-hull-700/30 p-2.5 overflow-y-auto max-h-[40vh]">
      <div className="prose prose-invert prose-xs max-w-none text-[10px] leading-snug text-gray-300 [&_h1]:text-xs [&_h1]:text-white [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-0.5 [&_h2]:text-[11px] [&_h2]:text-white [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-0.5 [&_h3]:text-[10px] [&_h3]:text-gray-200 [&_h3]:font-bold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-0.5 [&_strong]:text-white [&_code]:text-neon-cyan [&_code]:bg-hull-800 [&_code]:px-1 [&_code]:rounded [&_code]:text-[9px] [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_li]:leading-snug [&_table]:text-[9px] [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_th]:text-gray-400 [&_th]:border-b [&_th]:border-hull-700 [&_td]:px-1.5 [&_td]:py-0.5 [&_td]:border-b [&_td]:border-hull-800">
        <div dangerouslySetInnerHTML={{ __html: simpleMarkdown(text) }} />
        {loading && <span className="inline-block h-2 w-8 bg-neon-cyan/30 rounded animate-pulse ml-1" />}
      </div>
      <div ref={endRef} />
    </div>
  )
}

function simpleMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => '<ul>' + m + '</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')

  // Simple table support
  html = html.replace(/(<br\/>)?\|(.+)\|(<br\/>)\|[-| ]+\|(<br\/>)([\s\S]*?)(?=<br\/><br\/>|<h|$)/g, (_, _pre, header, _br1, _br2, body) => {
    const headers = header.split('|').map((h: string) => `<th>${h.trim()}</th>`).join('')
    const rows = body.split('<br/>').filter((r: string) => r.includes('|')).map((row: string) => {
      const cells = row.split('|').map((c: string) => `<td>${c.trim()}</td>`).join('')
      return `<tr>${cells}</tr>`
    }).join('')
    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`
  })

  return html
}


function AIDiagnoseButton({ namespace, pod }: { namespace: string; pod: string }) {
  const ai = useAIStream()
  const [show, setShow] = useState(false)

  const diagnose = () => {
    setShow(true)
    ai.run('/api/ai/diagnose', { namespace, pod })
  }

  return (
    <>
      <button onClick={diagnose} disabled={ai.loading}
        className="rounded-lg border border-purple-500/30 bg-purple-950/20 px-2 py-0.5 text-[9px] font-bold text-purple-400 hover:bg-purple-950/40 disabled:opacity-30 transition-colors flex items-center gap-1">
        <span className="text-[10px]">✦</span> {ai.loading ? 'Diagnosing...' : 'AI Diagnose'}
      </button>
      {show && (ai.text || ai.loading || ai.error) && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">AI Diagnosis</span>
            <button onClick={() => setShow(false)} className="text-[9px] text-gray-600 hover:text-white">&times;</button>
          </div>
          <AIResponsePanel text={ai.text} loading={ai.loading} error={ai.error} />
        </div>
      )}
    </>
  )
}

function AISpotAnalysis() {
  const ai = useAIStream()
  const [show, setShow] = useState(false)

  const analyze = () => {
    setShow(true)
    ai.run('/api/ai/spot-analysis')
  }

  return (
    <div className="stat-card overflow-hidden">
      <div className="flex items-center gap-2 p-3">
        <span className="text-neon-cyan text-sm">✦</span>
        <span className="text-[11px] font-bold text-white">AI Spot Fleet Analysis</span>
        <button onClick={analyze} disabled={ai.loading}
          className="ml-auto rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-2 py-0.5 text-[9px] font-bold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-30 transition-colors">
          {ai.loading ? 'Analyzing...' : show ? 'Re-analyze' : 'Analyze with AI'}
        </button>
      </div>
      {show && (ai.text || ai.loading || ai.error) && (
        <div className="border-t border-hull-700/30 p-3">
          <AIResponsePanel text={ai.text} loading={ai.loading} error={ai.error} />
        </div>
      )}
    </div>
  )
}

// ─── CronJob Detail View ────────────────────────────────────────────
type CronJobRun = { name: string; startTime: string | null; endTime: string | null; durationS: number; status: string; succeeded: number; failed: number; active: number }
type CronJobHistory = { name: string; namespace: string; schedule: string; suspended: boolean; lastSchedule: string | null; activeCount: number; runs: CronJobRun[] }

function CronJobDetailView({ ns, name, onBack, onPod }: { ns: string; name: string; onBack: () => void; onPod: (ns: string, name: string) => void }) {
  const { data, err, loading } = useFetch<CronJobHistory>(`/api/cronjobs/${name}?namespace=${ns}`, 10000)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void onPod

  if (loading) return <div className="p-4"><Spinner /></div>
  if (err) return <div className="p-4"><button onClick={onBack} className="text-neon-cyan text-xs mb-2">← Back</button><p className="text-neon-red">{err}</p></div>
  if (!data) return null

  const succeeded = data.runs.filter(r => r.status === 'succeeded').length
  const failed = data.runs.filter(r => r.status === 'failed').length
  const running = data.runs.filter(r => r.status === 'running').length

  const statusBadge = (s: string) =>
    s === 'succeeded' ? 'bg-green-950/50 text-neon-green border border-green-900/40' :
    s === 'failed' ? 'bg-red-950/50 text-neon-red border border-red-900/40' :
    s === 'running' ? 'bg-blue-950/50 text-neon-blue border border-blue-900/40' :
    'bg-hull-800 text-gray-400 border border-hull-700/50'

  const fmtDuration = (s: number) => {
    if (s <= 0) return '—'
    if (s < 60) return `${Math.round(s)}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-neon-cyan text-xs hover:underline">← Back</button>
        <Pill color="border bg-sky-950/30 text-sky-300 border-sky-900/30">CRONJOB</Pill>
      </div>

      <div>
        <h2 className="text-base font-bold text-white">{data.name}</h2>
        <p className="text-[10px] text-gray-500">{data.namespace}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="stat-card p-2.5 text-center">
          <p className="text-sm font-bold text-neon-cyan font-mono">{data.schedule}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Schedule</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className={`text-lg font-extrabold tabular-nums ${data.suspended ? 'text-neon-amber' : 'text-neon-green'}`}>{data.suspended ? 'Yes' : 'No'}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Suspended</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-neon-blue tabular-nums">{data.activeCount}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Active Jobs</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-white tabular-nums">{data.runs.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Total Runs</p>
        </div>
      </div>

      {data.lastSchedule && (
        <p className="text-[10px] text-gray-500">Last scheduled: <span className="text-gray-300">{new Date(data.lastSchedule).toLocaleString()}</span></p>
      )}

      <div className="flex gap-3 text-[10px]">
        <span className="text-neon-green font-medium">{succeeded} succeeded</span>
        <span className="text-neon-red font-medium">{failed} failed</span>
        <span className="text-neon-blue font-medium">{running} running</span>
      </div>

      {data.runs.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No execution history yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500 text-left border-b border-hull-700/30">
                <th className="pb-1.5 pr-3 font-medium">Job</th>
                <th className="pb-1.5 pr-3 font-medium">Started</th>
                <th className="pb-1.5 pr-3 font-medium">Duration</th>
                <th className="pb-1.5 pr-3 font-medium">Status</th>
                <th className="pb-1.5 pr-3 font-medium text-right">Pods</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map(run => (
                <tr key={run.name} className="border-b border-hull-800/40 hover:bg-hull-800/30 transition-colors">
                  <td className="py-1.5 pr-3 font-mono text-gray-300 truncate max-w-[200px]">{run.name}</td>
                  <td className="py-1.5 pr-3 text-gray-400">{run.startTime ? new Date(run.startTime).toLocaleString() : '—'}</td>
                  <td className="py-1.5 pr-3 text-gray-400 tabular-nums">{fmtDuration(run.durationS)}</td>
                  <td className="py-1.5 pr-3"><span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${statusBadge(run.status)}`}>{run.status}</span></td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {run.succeeded > 0 && <span className="text-neon-green">{run.succeeded}✓</span>}
                    {run.failed > 0 && <span className="text-neon-red ml-1">{run.failed}✗</span>}
                    {run.active > 0 && <span className="text-neon-blue ml-1">{run.active}⟳</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Cost Allocation Panel ──────────────────────────────────────────
type CostEntry = { namespace: string; hourlyCost: number; monthlyCost: number }
type NodepoolCost = { nodepool: string; nodes: number; hourlyCost: number; monthlyCost: number }
type CostData = { namespaces: CostEntry[]; nodepools: NodepoolCost[] }

function CostAllocationPanel() {
  const { data, err, loading } = useFetch<CostData>('/api/namespace-costs', 60000)
  const [tab, setTab] = useState<'namespace' | 'nodepool'>('namespace')
  const [nsSortKey, setNsSortKey] = useState<'monthlyCost' | 'namespace'>('monthlyCost')
  const [nsSortAsc, setNsSortAsc] = useState(false)

  if (loading) return <div className="py-4"><Spinner /></div>
  if (err) return <p className="text-neon-red text-xs">{err}</p>
  if (!data) return null

  const ns = data.namespaces || []
  const np = data.nodepools || []
  if (ns.length === 0 && np.length === 0) return null

  const nsTotalMonthly = ns.reduce((s, d) => s + d.monthlyCost, 0)
  const npTotalMonthly = np.reduce((s, d) => s + d.monthlyCost, 0)
  const totalNodes = np.reduce((s, d) => s + d.nodes, 0)

  const nsSorted = [...ns].sort((a, b) => {
    const mul = nsSortAsc ? 1 : -1
    if (nsSortKey === 'namespace') return mul * a.namespace.localeCompare(b.namespace)
    return mul * (a.monthlyCost - b.monthlyCost)
  })
  const nsTop10 = nsSorted.slice(0, 10)
  const colors = ['#06d6e0', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16']

  const toggleNsSort = (key: 'monthlyCost' | 'namespace') => {
    if (nsSortKey === key) setNsSortAsc(!nsSortAsc)
    else { setNsSortKey(key); setNsSortAsc(key === 'namespace') }
  }

  return (
    <div className="stat-card p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-teal-400 uppercase tracking-wider">Cost Allocation</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setTab('namespace')} className={`rounded px-2 py-0.5 text-[9px] font-medium border transition-colors ${tab === 'namespace' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>By Namespace</button>
          <button onClick={() => setTab('nodepool')} className={`rounded px-2 py-0.5 text-[9px] font-medium border transition-colors ${tab === 'nodepool' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>By Nodepool</button>
        </div>
      </div>

      {tab === 'namespace' && (
        <>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-xl font-extrabold text-white tabular-nums">${nsTotalMonthly.toFixed(2)}</p>
              <p className="text-[9px] text-gray-500 uppercase">Est. Monthly Total</p>
            </div>
            <div className="flex-1 h-4 rounded-full overflow-hidden bg-hull-800 flex">
              {nsTop10.map((d, i) => {
                const pct = nsTotalMonthly > 0 ? (d.monthlyCost / nsTotalMonthly) * 100 : 0
                return pct > 0.5 ? <div key={d.namespace} style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length] }} className="h-full" title={`${d.namespace}: $${d.monthlyCost.toFixed(2)}`} /> : null
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 text-left border-b border-hull-700/30">
                  <th className="pb-1.5 pr-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleNsSort('namespace')}>Namespace {nsSortKey === 'namespace' ? (nsSortAsc ? '↑' : '↓') : ''}</th>
                  <th className="pb-1.5 pr-3 font-medium text-right cursor-pointer hover:text-gray-300" onClick={() => toggleNsSort('monthlyCost')}>Monthly Est. {nsSortKey === 'monthlyCost' ? (nsSortAsc ? '↑' : '↓') : ''}</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Hourly</th>
                  <th className="pb-1.5 font-medium text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {nsSorted.map((d, i) => {
                  const share = nsTotalMonthly > 0 ? (d.monthlyCost / nsTotalMonthly) * 100 : 0
                  return (
                    <tr key={d.namespace} className="border-b border-hull-800/40 hover:bg-hull-800/30 transition-colors">
                      <td className="py-1.5 pr-3 text-gray-300 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: colors[i % colors.length] }} />
                        {d.namespace}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-white font-medium tabular-nums">${d.monthlyCost.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-500 tabular-nums">${d.hourlyCost.toFixed(4)}</td>
                      <td className="py-1.5 text-right text-gray-400 tabular-nums">{share.toFixed(1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'nodepool' && (
        <>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-xl font-extrabold text-white tabular-nums">${npTotalMonthly.toFixed(2)}</p>
              <p className="text-[9px] text-gray-500 uppercase">Est. Monthly ({totalNodes} nodes)</p>
            </div>
            <div className="flex-1 h-4 rounded-full overflow-hidden bg-hull-800 flex">
              {np.map((d, i) => {
                const pct = npTotalMonthly > 0 ? (d.monthlyCost / npTotalMonthly) * 100 : 0
                return pct > 0.5 ? <div key={d.nodepool} style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length] }} className="h-full" title={`${d.nodepool}: $${d.monthlyCost.toFixed(2)}`} /> : null
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 text-left border-b border-hull-700/30">
                  <th className="pb-1.5 pr-3 font-medium">Nodepool</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Nodes</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Monthly Est.</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Hourly</th>
                  <th className="pb-1.5 font-medium text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {np.map((d, i) => {
                  const share = npTotalMonthly > 0 ? (d.monthlyCost / npTotalMonthly) * 100 : 0
                  return (
                    <tr key={d.nodepool} className="border-b border-hull-800/40 hover:bg-hull-800/30 transition-colors">
                      <td className="py-1.5 pr-3 text-gray-300 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: colors[i % colors.length] }} />
                        {d.nodepool}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">{d.nodes}</td>
                      <td className="py-1.5 pr-3 text-right text-white font-medium tabular-nums">${d.monthlyCost.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-500 tabular-nums">${d.hourlyCost.toFixed(4)}</td>
                      <td className="py-1.5 text-right text-gray-400 tabular-nums">{share.toFixed(1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Info Popover ───────────────────────────────────────────────────

const TAB_DETAIL: Record<string, { desc: string; actions: string[]; tips: string[] }> = {
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

function InfoPopover({ tab, onClose }: { tab: string; onClose: () => void }) {
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

// ─── Nav + App Shell ────────────────────────────────────────────────
const TABS = [
  { id: 'overview', label: 'Overview', icon: '⬡' },
  { id: 'nodes', label: 'Nodes', icon: '⬢' },
  { id: 'workloads', label: 'Workloads', icon: '▣' },
  { id: 'pods', label: 'Pods', icon: '◉' },
  { id: 'services', label: 'Services', icon: '⇌' },
  { id: 'ingress', label: 'Ingress', icon: '↗' },
  { id: 'hpa', label: 'HPA', icon: '⟳' },
  { id: 'config', label: 'Config', icon: '⬔' },
  { id: 'spot', label: 'Spot Advisor', icon: '◎' },
  { id: 'events', label: 'Events', icon: '◷' },
  { id: 'troubled', label: 'Troubled', icon: '⚠' },
  { id: 'topology', label: 'Topology', icon: '◈' },
] as const
type TabId = typeof TABS[number]['id']

function parseRoute(): { tab: TabId; pod: { ns: string; name: string } | null; node: string | null; ingress: { ns: string; name: string } | null; workload: { ns: string; name: string; kind: string } | null } {
  const p = window.location.pathname.replace(/^\/+|\/+$/g, '')
  const segs = p.split('/')
  const validTabs = TABS.map(t => t.id) as string[]
  if (segs[0] === 'pods' && segs.length === 3) return { tab: 'pods', pod: { ns: segs[1], name: segs[2] }, node: null, ingress: null, workload: null }
  if (segs[0] === 'nodes' && segs.length === 2) return { tab: 'nodes', pod: null, node: segs[1], ingress: null, workload: null }
  if (segs[0] === 'ingress' && segs.length === 3) return { tab: 'ingress', pod: null, node: null, ingress: { ns: segs[1], name: segs[2] }, workload: null }
  if (segs[0] === 'workloads' && segs.length === 4) return { tab: 'workloads', pod: null, node: null, ingress: null, workload: { ns: segs[1], name: segs[2], kind: segs[3] } }
  if (validTabs.includes(segs[0])) return { tab: segs[0] as TabId, pod: null, node: null, ingress: null, workload: null }
  return { tab: 'overview', pod: null, node: null, ingress: null, workload: null }
}


// ─── Namespace Picker ────────────────────────────────────────────────
function NamespacePicker({ namespaces, value, onChange }: { namespaces: string[]; value: string; onChange: (ns: string) => void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => { if (!open) setFilter('') }, [open])

  const filtered = filter ? namespaces.filter(n => n.toLowerCase().includes(filter.toLowerCase())) : namespaces

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-all ${value ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/30 hover:bg-neon-cyan/20' : 'glass text-gray-400 border-transparent hover:text-gray-300'}`}>
        <span className="text-[10px]">⬡</span>
        <span className="max-w-[100px] truncate">{value || 'All Namespaces'}</span>
        {value && (
          <span onClick={e => { e.stopPropagation(); onChange(''); setOpen(false) }}
            className="ml-0.5 text-[9px] text-gray-500 hover:text-white transition-colors">&times;</span>
        )}
        <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform ${open ? 'rotate-180' : ''}`}><path d="M1 3l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl border border-hull-600/60 bg-hull-950 shadow-2xl shadow-black/60 overflow-hidden">
          <div className="p-2 border-b border-hull-700/40">
            <input autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter namespaces…"
              className="w-full rounded-lg border border-hull-600/40 bg-hull-800/60 px-2.5 py-1.5 text-[11px] text-gray-300 outline-none placeholder:text-gray-700 focus:border-neon-cyan/30" />
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button onClick={() => { onChange(''); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2 ${!value ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-gray-400 hover:bg-hull-800/60 hover:text-white'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${!value ? 'bg-neon-cyan' : 'bg-gray-700'}`} />
              All Namespaces
              <span className="ml-auto text-[9px] text-gray-600">{namespaces.length}</span>
            </button>
            {filtered.map(n => (
              <button key={n} onClick={() => { onChange(n); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2 ${value === n ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-gray-400 hover:bg-hull-800/60 hover:text-white'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${value === n ? 'bg-neon-cyan' : 'bg-gray-700'}`} />
                <span className="truncate font-mono">{n}</span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-3 py-3 text-[10px] text-gray-600 text-center">No namespaces match</p>}
          </div>
        </div>
      )}
    </div>
  )
}


function App() {
  const initial = parseRoute()
  const [tab, setTabRaw] = useState<TabId>(initial.tab)
  const [ns, setNs] = useState('')
  const [workloadKind, setWorkloadKind] = useState('')
  const [podTarget, setPodTargetRaw] = useState<{ ns: string; name: string } | null>(initial.pod)
  const [nodeTarget, setNodeTargetRaw] = useState<string | null>(initial.node)
  const [ingressTarget, setIngressTargetRaw] = useState<{ ns: string; name: string } | null>(initial.ingress)
  const [workloadTarget, setWorkloadTargetRaw] = useState<{ ns: string; name: string; kind: string } | null>(initial.workload)
  const [showSearch, setShowSearch] = useState(false)
  const [sideOpen, setSideOpen] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const { data: namespaces } = useFetch<string[]>('/api/namespaces')
  const { data: clusterInfo } = useFetch<{ name: string }>('/api/cluster-info')

  const pushUrl = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
  }, [])

  const setTab = useCallback((t: TabId) => {
    setTabRaw(t)
    setPodTargetRaw(null)
    setNodeTargetRaw(null)
    setIngressTargetRaw(null)
    setWorkloadTargetRaw(null)
    pushUrl(t === 'overview' ? '/' : `/${t}`)
  }, [pushUrl])

  const setPodTarget = useCallback((v: { ns: string; name: string } | null) => {
    setPodTargetRaw(v)
    if (v) pushUrl(`/pods/${v.ns}/${v.name}`)
    else pushUrl(tab === 'troubled' ? '/troubled' : '/pods')
  }, [pushUrl, tab])

  const setNodeTarget = useCallback((v: string | null) => {
    setNodeTargetRaw(v)
    if (v) pushUrl(`/nodes/${v}`)
    else pushUrl('/nodes')
  }, [pushUrl])

  const setIngressTarget = useCallback((v: { ns: string; name: string } | null) => {
    setIngressTargetRaw(v)
    if (v) pushUrl(`/ingress/${v.ns}/${v.name}`)
    else pushUrl('/ingress')
  }, [pushUrl])

  const setWorkloadTarget = useCallback((v: { ns: string; name: string; kind: string } | null) => {
    setWorkloadTargetRaw(v)
    if (v) pushUrl(`/workloads/${v.ns}/${v.name}/${v.kind}`)
    else pushUrl('/workloads')
  }, [pushUrl])

  useEffect(() => {
    const onPop = () => {
      const r = parseRoute()
      setTabRaw(r.tab)
      setPodTargetRaw(r.pod)
      setNodeTargetRaw(r.node)
      setIngressTargetRaw(r.ingress)
      setWorkloadTargetRaw(r.workload)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const [authModeHint, setAuthModeHint] = useState<string>('none')

  useEffect(() => {
    fetch('/api/me').then(async r => {
      if (r.status === 401) {
        const body = await r.json().catch(() => ({}))
        setAuthModeHint(body.authMode || 'oidc')
        setUser(null); setAuthLoading(false); return null
      }
      return r.json()
    }).then(d => { if (d) { setUser(d); setAuthModeHint(d.authMode || 'none'); setAuthLoading(false) } }).catch(() => { setUser({ email: 'anonymous', role: 'viewer', authMode: 'none' }); setAuthLoading(false) })
  }, [])

  if (authLoading) return (
    <div className="flex h-full items-center justify-center bg-hull-950">
      <div className="flex flex-col items-center gap-4">
        <Spinner />
        <p className="text-xs text-gray-600">Connecting to cluster...</p>
      </div>
    </div>
  )

  if (!user) return (
    <div className="flex h-full items-center justify-center bg-hull-950 pt-safe">
      <div className="mx-4 w-full max-w-sm text-center">
        <div className="stat-card ring-glow p-8">
          <h1 className="text-2xl font-extrabold tracking-wider text-white mb-1">KUBE-<span className="text-neon-cyan glow-cyan">ARGUS</span></h1>
          <p className="text-xs text-gray-500 mb-6">Kubernetes Cluster Dashboard</p>
          {authModeHint === 'google' ? (
            <a href="/auth/login" className="inline-flex items-center gap-3 rounded-xl bg-white/[.06] border border-white/10 px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-white/10 hover:border-white/20 no-underline">
              <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </a>
          ) : (
            <a href="/auth/login" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-neon-cyan/20 to-neon-green/10 border border-neon-cyan/30 px-6 py-3 text-sm font-semibold text-neon-cyan transition-all hover:shadow-[0_0_20px_rgba(6,214,224,0.2)] hover:border-neon-cyan/50 no-underline">
              Sign in with SSO
            </a>
          )}
          <p className="mt-4 text-[10px] text-gray-700">Authenticated access only</p>
        </div>
      </div>
    </div>
  )
  const userInfo = user || { email: 'anonymous', role: 'viewer', authMode: 'none' }

  const handleSearchSelect = (r: SearchResult) => {
    if (r.kind === 'Pod') {
      setPodTarget({ ns: r.namespace, name: r.name })
    } else if (r.kind === 'Deployment') {
      setNs(r.namespace)
      setTab('workloads')
    } else if (r.kind === 'Node') {
      setNodeTarget(r.name)
    } else if (r.kind === 'Service') {
      setNs(r.namespace)
      setTab('services')
    } else if (r.kind === 'Ingress') {
      setIngressTarget({ ns: r.namespace, name: r.name })
    }
  }

  if (nodeTarget) {
    return (
      <AuthCtx.Provider value={userInfo}>
        <div className="flex h-full flex-col overflow-hidden bg-hull-950 pt-safe">
          <NodeDescribeView name={nodeTarget} onBack={() => setNodeTarget(null)} onPod={(ns, name) => { setNodeTargetRaw(null); setPodTarget({ ns, name }) }} />
        </div>
      </AuthCtx.Provider>
    )
  }

  if (ingressTarget) {
    return (
      <AuthCtx.Provider value={userInfo}>
        <div className="flex h-full flex-col overflow-hidden bg-hull-950 pt-safe">
          <IngressDetailView ns={ingressTarget.ns} name={ingressTarget.name} onBack={() => setIngressTarget(null)} />
        </div>
      </AuthCtx.Provider>
    )
  }

  if (workloadTarget) {
    return (
      <AuthCtx.Provider value={userInfo}>
        <div className="flex h-full flex-col overflow-hidden bg-hull-950 pt-safe">
          {workloadTarget.kind === 'CronJob'
            ? <CronJobDetailView ns={workloadTarget.ns} name={workloadTarget.name} onBack={() => setWorkloadTarget(null)} onPod={(pns, pname) => { setWorkloadTargetRaw(null); setPodTarget({ ns: pns, name: pname }) }} />
            : <WorkloadDetailView ns={workloadTarget.ns} name={workloadTarget.name} kind={workloadTarget.kind} onBack={() => setWorkloadTarget(null)} onPod={(pns, pname) => { setWorkloadTargetRaw(null); setPodTarget({ ns: pns, name: pname }) }} />
          }
        </div>
      </AuthCtx.Provider>
    )
  }

  if (podTarget) {
    return (
      <AuthCtx.Provider value={userInfo}>
        <div className="flex h-full flex-col overflow-hidden bg-hull-950 pt-safe">
          <PodDetailView ns={podTarget.ns} name={podTarget.name} onBack={() => setPodTarget(null)} />
        </div>
      </AuthCtx.Provider>
    )
  }

  return (
    <AuthCtx.Provider value={userInfo}>
      <div className="flex h-full overflow-hidden bg-hull-950 pt-safe">
        {showSearch && <SearchModal onClose={() => setShowSearch(false)} onSelect={handleSearchSelect} />}

        {/* Left edge hover trigger */}
        {!sideOpen && <div className="fixed left-0 top-0 z-30 h-full w-2 cursor-pointer" onMouseEnter={() => setSideOpen(true)} />}

        {/* Sidebar overlay */}
        {sideOpen && <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setSideOpen(false)} />}

        {/* Sidebar */}
        <aside onMouseLeave={() => setSideOpen(false)} className={`fixed left-0 top-0 z-50 flex h-full w-56 flex-col border-r border-hull-700/40 bg-hull-950/95 backdrop-blur-xl transition-transform duration-300 ease-out pt-safe ${sideOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-hull-700/30">
            <h1 className="text-sm font-extrabold tracking-wider text-white">KUBE-<span className="text-neon-cyan glow-cyan">ARGUS</span></h1>
            <button onClick={() => setSideOpen(false)} className="rounded-lg p-1 text-gray-500 hover:text-white transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto py-2 px-2">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); if (t.id !== 'workloads') setWorkloadKind(''); setSideOpen(false); }}
                className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 mb-0.5 ${tab === t.id ? 'bg-hull-800/80 text-neon-cyan shadow-[inset_0_0_20px_rgba(6,214,224,0.04)]' : 'text-gray-500 hover:bg-hull-800/40 hover:text-gray-300'}`}
              >
                {tab === t.id && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r-full bg-neon-cyan shadow-[0_0_8px_rgba(6,214,224,0.6)]" />}
                <span className="text-base w-5 text-center">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="border-t border-hull-700/30 px-3 py-3">
            <div className="flex items-center gap-2.5">
              <UserAvatar email={userInfo.email} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-gray-300 leading-tight truncate">{userInfo.email.split('@')[0]}</p>
                <p className={`text-[9px] font-bold uppercase tracking-widest ${userInfo.role === 'admin' ? 'text-neon-cyan' : 'text-gray-500'}`}>{userInfo.role}</p>
              </div>
            </div>
            {clusterInfo && <div className="mt-2 rounded-lg bg-gradient-to-r from-amber-950/40 to-amber-950/20 border border-amber-900/20 px-2 py-1 font-mono text-[10px] text-neon-amber text-center truncate">{clusterInfo.name}</div>}
          </div>
        </aside>

        {/* Main column */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Header */}
          <header className="shrink-0 glass border-0 border-b border-hull-700/40 px-3 py-2.5 relative z-40">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <button onClick={() => setSideOpen(true)} className="rounded-lg p-1.5 text-gray-400 hover:text-white hover:bg-hull-800/60 transition-all active:scale-90">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                </button>
                <h1 className="text-sm font-extrabold tracking-wider text-white">KUBE-<span className="text-neon-cyan glow-cyan">ARGUS</span></h1>
                {clusterInfo && <span className="hidden sm:inline rounded-lg bg-gradient-to-r from-amber-950/40 to-amber-950/20 border border-amber-900/20 px-2 py-0.5 font-mono text-[10px] text-neon-amber">{clusterInfo.name}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowSearch(true)} className="flex items-center gap-1.5 rounded-lg glass px-2.5 py-1 text-[11px] text-gray-400 transition-all hover:text-neon-cyan hover:shadow-[0_0_8px_rgba(6,214,224,0.1)]">
                  <span>⌕</span><span className="hidden sm:inline">Search</span>
                </button>
                {(tab === 'workloads' || tab === 'pods' || tab === 'ingress' || tab === 'services' || tab === 'events' || tab === 'hpa' || tab === 'config') && namespaces && namespaces.length > 0 && (
                  <NamespacePicker namespaces={namespaces} value={ns} onChange={setNs} />
                )}
                <div className="relative">
                  <button onClick={() => setShowInfo(v => !v)} className="rounded-lg p-1.5 text-gray-500 hover:text-neon-cyan hover:bg-hull-800/60 transition-all" title="Dashboard Info">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  </button>
                  {showInfo && <InfoPopover tab={tab} onClose={() => setShowInfo(false)} />}
                </div>
                <div className="flex items-center gap-2">
                  <UserAvatar email={userInfo.email} />
                  <div className="hidden sm:block">
                    <p className="text-[10px] font-medium text-gray-300 leading-tight truncate max-w-[100px]">{userInfo.email.split('@')[0]}</p>
                    <p className={`text-[8px] font-bold uppercase tracking-widest ${userInfo.role === 'admin' ? 'text-neon-cyan' : 'text-gray-500'}`}>{userInfo.role}</p>
                  </div>
                </div>
              </div>
            </div>
          </header>

          {/* Content */}
          <main className="flex-1 overflow-y-auto overflow-x-hidden" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
            {tab === 'overview' && <OverviewView onNodeTap={(name) => { setNodeTarget(name) }} onTab={(t, kind) => { setTab(t as TabId); if (t === 'workloads') setWorkloadKind(kind || ''); }} />}
            {tab === 'nodes' && <NodesView onNode={(name) => setNodeTarget(name)} />}
            {tab === 'workloads' && <WorkloadsView namespace={ns} initialKind={workloadKind} onWorkload={(ns, name, kind) => setWorkloadTarget({ ns, name, kind })} />}
            {tab === 'pods' && <PodsView namespace={ns} onPod={(ns, name) => setPodTarget({ ns, name })} />}
            {tab === 'services' && <ServicesView namespace={ns} />}
            {tab === 'ingress' && <IngressesView namespace={ns} onIngress={(ns, name) => setIngressTarget({ ns, name })} />}
          {tab === 'hpa' && <HPAView namespace={ns} />}
          {tab === 'config' && <ConfigView namespace={ns} />}
          {tab === 'spot' && <SpotAdvisorView />}
          {tab === 'events' && <EventsView namespace={ns} />}
          {tab === 'troubled' && <TroubledPodsView onPod={(ns, name) => setPodTarget({ ns, name })} />}
          {tab === 'topology' && <TopologySpreadView />}
          </main>
        </div>
      </div>
    </AuthCtx.Provider>
  )
}

export default App
