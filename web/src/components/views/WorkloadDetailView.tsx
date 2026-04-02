import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts'
import yaml from 'js-yaml'
import { useFetch, post } from '../../hooks/useFetch'
import { useAuth } from '../../context/AuthContext'
import { Spinner } from '../ui/Atoms'

type DriftEntry = { kind: string; name: string; modifiedAgo: string; driftedCount: number; totalPods: number }

// ─── Metrics Infrastructure ──────────────────────────────────────────

export type MetricSeries = { name: string; values: [number, number][] }
export type MetricsData = Record<string, MetricSeries[]>
export type RefLine = { value: number; label: string; color: string }

export const CHART_COLORS = ['#06b6d4', '#f59e0b', '#22c55e', '#a78bfa', '#f87171', '#38bdf8', '#facc15', '#4ade80', '#c084fc', '#fb923c']
export const METRIC_RANGES = ['1h', '3h', '6h', '12h', '24h'] as const

export function useMetrics(url: string, timeRange: string) {
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

export function seriesLastVal(series?: MetricSeries[]): number {
  if (!series || series.length === 0) return 0
  const vals = series[0].values
  return vals.length > 0 ? vals[vals.length - 1][1] : 0
}

export function fmtBytes(v: number): string {
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GiB`
  if (v >= 1048576) return `${(v / 1048576).toFixed(0)} MiB`
  return `${(v / 1024).toFixed(0)} KiB`
}

export function MetricChart({ title, series, unit, height = 120, refLines }: { title: string; series: MetricSeries[]; unit: string; height?: number; refLines?: RefLine[] }) {
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

// ─── YAML Modal ──────────────────────────────────────────────────────

function highlightYaml(text: string): string {
  return text.replace(/^(\s*)([\w.\-/]+)(:)/gm, '$1<span class="text-neon-cyan">$2</span><span class="text-gray-500">$3</span>')
    .replace(/: (true|false)/g, ': <span class="text-purple-400">$1</span>')
    .replace(/: (\d+[\d.]*)/g, ': <span class="text-amber-400">$1</span>')
    .replace(/: "([^"]*)"/g, ': <span class="text-green-400">"$1"</span>')
    .replace(/: '([^']*)'/g, ': <span class="text-green-400">\'$1\'</span>')
    .replace(/^(\s*- )/gm, '<span class="text-gray-500">$1</span>')
    .replace(/#.*/g, '<span class="text-gray-600">$&</span>')
}

export function YamlModal({ kind, ns, name, onClose }: { kind: string; ns: string; name: string; onClose: () => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [content, setContent] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/yaml/${kind}/${ns}/${name}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => {
        const cleaned = { ...d }
        delete cleaned.managedFields
        if (cleaned.metadata) {
          const m = { ...cleaned.metadata }
          delete m.managedFields
          cleaned.metadata = m
        }
        const y = yaml.dump(cleaned, { lineWidth: 120, noRefs: true, sortKeys: false })
        setContent(y)
        setEditContent(y)
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [kind, ns, name])

  const handleApply = async () => {
    setSaving(true)
    setError(null)
    try {
      const parsed = yaml.load(editContent)
      const resp = await fetch(`/api/yaml/${kind}/${ns}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text)
      }
      setToast('Applied successfully')
      setEditMode(false)
      setTimeout(() => setToast(null), 3000)
      const fresh = await fetch(`/api/yaml/${kind}/${ns}/${name}`)
      if (fresh.ok) {
        const d = await fresh.json()
        const cleaned = { ...d }
        delete cleaned.managedFields
        if (cleaned.metadata) { const m = { ...cleaned.metadata }; delete m.managedFields; cleaned.metadata = m }
        const y = yaml.dump(cleaned, { lineWidth: 120, noRefs: true, sortKeys: false })
        setContent(y)
        setEditContent(y)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(editMode ? editContent : content).then(() => {
      setToast('Copied to clipboard')
      setTimeout(() => setToast(null), 2000)
    })
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 mx-4 w-full max-w-4xl max-h-[85vh] overflow-hidden rounded-2xl border border-hull-600 bg-hull-900 shadow-2xl shadow-black/60 flex flex-col" onClick={e => e.stopPropagation()}>
        {toast && <div className="absolute top-3 right-14 z-20 rounded-lg border border-hull-600 bg-hull-800 px-3 py-1.5 text-[10px] text-neon-green shadow-lg">{toast}</div>}
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="rounded border border-hull-600 bg-hull-800 px-1.5 py-0.5 text-[9px] font-bold uppercase text-gray-400">{kind}</span>
            <h2 className="text-sm font-bold text-white truncate">{name}</h2>
            <span className="text-[10px] text-gray-500">{ns}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={copyToClipboard} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">Copy</button>
            {isAdmin && !editMode && (
              <button onClick={() => setEditMode(true)} className="rounded-lg border border-cyan-900/40 bg-cyan-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-cyan-900/30">Edit</button>
            )}
            {editMode && (
              <>
                <button onClick={() => { setEditMode(false); setEditContent(content); setError(null) }} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">Cancel</button>
                <button onClick={handleApply} disabled={saving} className="rounded-lg border border-blue-900/50 bg-blue-950/60 px-2.5 py-1 text-[10px] font-medium text-neon-blue transition-colors hover:bg-blue-900/40 disabled:opacity-40">
                  {saving ? 'Applying…' : 'Apply'}
                </button>
              </>
            )}
            <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:text-white transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        {error && <div className="px-5 py-2 bg-red-950/30 border-b border-red-900/30 text-[11px] text-neon-red break-all">{error}</div>}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Spinner /></div>
          ) : editMode ? (
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full h-full min-h-[400px] bg-hull-950 text-gray-300 font-mono text-[11px] leading-relaxed p-4 resize-none border-0 outline-none"
              spellCheck={false}
            />
          ) : (
            <pre
              className="p-4 font-mono text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap break-all"
              dangerouslySetInnerHTML={{ __html: highlightYaml(content) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Workload Detail ─────────────────────────────────────────────────

export function WorkloadDetailView({ ns, name, kind, onBack, onPod }: { ns: string; name: string; kind: string; onBack: () => void; onPod: (ns: string, name: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const { data, err, loading, refetch } = useFetch<any>(`/api/workloads/${ns}/${name}/describe?kind=${kind}`, 10000)
  const [activeSection, setActiveSection] = useState<'overview' | 'pods' | 'containers' | 'events' | 'labels' | 'metrics' | 'replicasets' | 'agglogs'>('overview')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [scaleOpen, setScaleOpen] = useState(false)
  const [scaleVal, setScaleVal] = useState(0)
  const [showYaml, setShowYaml] = useState(false)

  const doRestart = async () => {
    setBusy('restart')
    try { await post(`/api/workloads/${ns}/${name}/restart`); setToast(`${name} restarting`); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  const doScale = async () => {
    setBusy('scale')
    try { await post(`/api/workloads/${ns}/${name}/scale?replicas=${scaleVal}`); setToast(`${name} scaled to ${scaleVal}`); setScaleOpen(false); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

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
    ...(['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind) ? [{ id: 'agglogs' as const, label: 'Agg Logs' }] : []),
    ...(kind === 'Deployment' && replicaSets.length > 0 ? [{ id: 'replicasets' as const, label: `ReplicaSets (${replicaSets.length})` }] : []),
    { id: 'pods' as const, label: `Pods (${wlPods.length})` },
    { id: 'containers' as const, label: `Containers (${containers.length})` },
    { id: 'events' as const, label: `Events (${events.length})` },
    { id: 'labels' as const, label: 'Labels' },
  ]

  const kindColor = kind === 'Deployment' ? 'text-blue-400' : kind === 'StatefulSet' ? 'text-purple-400' : kind === 'DaemonSet' ? 'text-indigo-400' : kind === 'CronJob' ? 'text-sky-300' : 'text-sky-400'

  return (
    <div className="flex h-full flex-col">
      {toast && <div className="fixed top-4 right-4 z-[100] rounded-lg border border-hull-600 bg-hull-900 px-4 py-2 text-xs text-white shadow-xl">{toast}</div>}

      {scaleOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={() => setScaleOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-72 rounded-2xl border border-hull-600 bg-hull-900 p-5 text-center shadow-2xl" onClick={e => e.stopPropagation()}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Scale</p>
            <p className="mt-1 truncate text-sm font-bold text-white">{name}</p>
            <p className="mt-0.5 text-[10px] text-gray-600">{ns}</p>
            <div className="mt-4 flex items-center justify-center gap-4">
              <button onClick={() => setScaleVal(Math.max(0, scaleVal - 1))} className="flex h-10 w-10 items-center justify-center rounded-lg border border-hull-600 bg-hull-800 text-lg font-bold text-white transition-colors hover:bg-hull-700 active:bg-hull-600">−</button>
              <span className="min-w-[3rem] text-center text-3xl font-bold tabular-nums text-neon-cyan">{scaleVal}</span>
              <button onClick={() => setScaleVal(Math.min(100, scaleVal + 1))} className="flex h-10 w-10 items-center justify-center rounded-lg border border-hull-600 bg-hull-800 text-lg font-bold text-white transition-colors hover:bg-hull-700 active:bg-hull-600">+</button>
            </div>
            <p className="mt-2 text-center text-[10px] text-gray-600">current: {data.replicas ?? 0}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setScaleOpen(false)} className="flex-1 rounded-lg border border-hull-600 py-2 text-xs text-gray-400 transition-colors hover:text-white">Cancel</button>
              <button onClick={doScale} disabled={busy === 'scale'} className="flex-1 rounded-lg border border-blue-900/50 bg-blue-950/60 py-2 text-xs font-medium text-neon-blue transition-colors hover:bg-blue-900/40 disabled:opacity-40">
                {busy === 'scale' ? 'Scaling…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="shrink-0 border-b border-hull-700/40 bg-hull-900/60 px-3 py-2 flex items-center gap-2">
        <button onClick={onBack} className="rounded-lg bg-hull-800 border border-hull-700/50 px-2.5 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">← Back</button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-white truncate">{name}</p>
          <p className="text-[10px] text-gray-500">{ns} · <span className={kindColor}>{kind}</span>{data.age ? ` · ${data.age}` : ''}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => setShowYaml(true)} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] font-medium text-gray-300 hover:text-white hover:bg-hull-700 transition-colors">YAML</button>
          {kind === 'Deployment' && isAdmin && (
            <>
              <button onClick={doRestart} disabled={busy === 'restart'} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] font-medium text-gray-300 hover:text-white hover:bg-hull-700 transition-colors disabled:opacity-40">
                {busy === 'restart' ? 'Restarting…' : '↻ Restart'}
              </button>
              <button onClick={() => { setScaleVal(data.replicas ?? 0); setScaleOpen(true) }} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] font-medium text-gray-300 hover:text-white hover:bg-hull-700 transition-colors">
                ⇕ Scale
              </button>
            </>
          )}
        </div>
      </div>
      {showYaml && <YamlModal kind={kind} ns={ns} name={name} onClose={() => setShowYaml(false)} />}

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
                  <div><span className="text-gray-500">Strategy</span><p className="font-mono text-gray-300">{typeof data.strategy === 'object' ? `${data.strategy.type}${data.strategy.maxSurge ? ` (surge=${data.strategy.maxSurge}, unavail=${data.strategy.maxUnavailable})` : ''}` : data.strategy}</p></div>
                </div>
              )}
              {kind === 'StatefulSet' && (
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Replicas</span><p className="font-mono text-white">{data.readyReplicas ?? 0}/{data.replicas}</p></div>
                  <div><span className="text-gray-500">Service</span><p className="font-mono text-gray-300">{data.serviceName}</p></div>
                  {data.strategy && <div><span className="text-gray-500">Strategy</span><p className="font-mono text-gray-300">{data.strategy.type}{data.strategy.partition !== undefined ? ` (partition=${data.strategy.partition})` : ''}</p></div>}
                </div>
              )}
              {kind === 'DaemonSet' && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div><span className="text-gray-500">Desired</span><p className="font-mono text-white">{data.desiredNumberScheduled}</p></div>
                  <div><span className="text-gray-500">Current</span><p className="font-mono text-white">{data.currentNumberScheduled}</p></div>
                  <div><span className="text-gray-500">Ready</span><p className="font-mono text-neon-green">{data.numberReady}</p></div>
                  {data.strategy && <div><span className="text-gray-500">Strategy</span><p className="font-mono text-gray-300">{data.strategy.type}{data.strategy.maxUnavailable ? ` (unavail=${data.strategy.maxUnavailable})` : ''}</p></div>}
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

        {activeSection === 'agglogs' && (
          <AggLogsView ns={ns} name={name} kind={kind} />
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

// ─── Aggregated Log Viewer ──────────────────────────────────────────

export const AGG_LOG_COLORS = ['#06d6e0', '#00ff88', '#f59e0b', '#a78bfa', '#f472b6', '#38bdf8', '#fb923c', '#34d399', '#e879f9', '#fbbf24']

export function AggLogsView({ ns, name, kind }: { ns: string; name: string; kind: string }) {
  const [lines, setLines] = useState<{ pod: string; line: string }[]>([])
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'ended' | 'error'>('connecting')
  const [tail, setTail] = useState(100)
  const [paused, setPaused] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const podColorMap = useRef<Map<string, string>>(new Map())
  const pausedRef = useRef(false)
  const bufferRef = useRef<{ pod: string; line: string }[]>([])

  useEffect(() => { pausedRef.current = paused }, [paused])

  useEffect(() => {
    setLines([])
    setStatus('connecting')
    podColorMap.current = new Map()
    bufferRef.current = []
    const es = new EventSource(`/api/workloads/${ns}/${name}/agglogs?kind=${kind}&tail=${tail}&follow=true`)
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data) as { pod: string; line: string }
        if (pausedRef.current) {
          bufferRef.current.push(d)
          if (bufferRef.current.length > 5000) bufferRef.current = bufferRef.current.slice(-3000)
          return
        }
        setLines(prev => {
          const next = [...prev, d]
          return next.length > 5000 ? next.slice(-3000) : next
        })
        setStatus('streaming')
      } catch {}
    }
    es.onerror = () => { setStatus(s => s === 'streaming' ? 'ended' : 'error'); es.close() }
    return () => es.close()
  }, [ns, name, kind, tail])

  useEffect(() => {
    if (!paused && bufferRef.current.length > 0) {
      setLines(prev => {
        const combined = [...prev, ...bufferRef.current]
        bufferRef.current = []
        return combined.length > 5000 ? combined.slice(-3000) : combined
      })
    }
  }, [paused])

  useEffect(() => {
    if (autoScroll && endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [lines, autoScroll])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }, [])

  const getPodColor = (pod: string) => {
    if (!podColorMap.current.has(pod)) {
      podColorMap.current.set(pod, AGG_LOG_COLORS[podColorMap.current.size % AGG_LOG_COLORS.length])
    }
    return podColorMap.current.get(pod)!
  }

  const shortPod = (p: string) => {
    const parts = p.split('-')
    return parts.length > 2 ? parts.slice(-2).join('-') : p
  }

  return (
    <div className="flex flex-col h-full -m-3">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hull-700/40 bg-hull-900/60 shrink-0">
        <span className={`h-1.5 w-1.5 rounded-full ${status === 'streaming' ? 'bg-neon-green animate-pulse' : status === 'connecting' ? 'bg-neon-amber animate-pulse' : status === 'ended' ? 'bg-gray-600' : 'bg-neon-red'}`} />
        <span className="text-[10px] text-gray-500 capitalize">{status}{paused ? ' (paused)' : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          <select value={tail} onChange={e => setTail(Number(e.target.value))} className="rounded border border-hull-600 bg-hull-800 px-1.5 py-0.5 text-[10px] text-gray-300">
            <option value={100}>100 lines</option>
            <option value={300}>300 lines</option>
            <option value={1000}>1000 lines</option>
          </select>
          <button onClick={() => setPaused(v => !v)} className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${paused ? 'border-neon-amber/50 bg-amber-950/40 text-neon-amber' : 'border-hull-600 bg-hull-800 text-gray-400 hover:text-white'}`}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button onClick={() => setLines([])} className="rounded border border-hull-600 bg-hull-800 px-2 py-0.5 text-[10px] text-gray-400 hover:text-white transition-colors">Clear</button>
        </div>
      </div>
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-auto bg-hull-950 p-2 font-mono text-[11px] leading-relaxed min-h-[300px]">
        {lines.length === 0 && status === 'connecting' && <div className="flex items-center justify-center py-12"><Spinner /></div>}
        {lines.length === 0 && status !== 'connecting' && <p className="text-center text-gray-600 py-12">No logs</p>}
        {lines.map((l, i) => (
          <div key={i} className="flex gap-0 hover:bg-hull-800/30">
            <span className="shrink-0 w-[140px] truncate text-right pr-2 select-none" style={{ color: getPodColor(l.pod) }}>{shortPod(l.pod)}</span>
            <span className="text-gray-400 select-none px-1">│</span>
            <span className="text-gray-300 break-all flex-1">{l.line}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {!autoScroll && lines.length > 0 && (
        <button onClick={() => { setAutoScroll(true); endRef.current?.scrollIntoView({ behavior: 'smooth' }) }} className="absolute bottom-4 right-4 rounded-lg border border-hull-600 bg-hull-800 px-3 py-1.5 text-[10px] text-gray-300 shadow-xl hover:text-white transition-colors">
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  )
}

// ─── Dependency Resource Map ─────────────────────────────────────────

export function DependencyGraph({ ns, name, kind }: { ns: string; name: string; kind: string }) {
  const { data, err, loading } = useFetch<any>(`/api/workloads/${ns}/${name}/dependencies?kind=${kind}`, 30000)
  const { data: driftData } = useFetch<DriftEntry[]>(`/api/config-drift?namespace=${encodeURIComponent(ns)}`, 30000)

  const driftMap = useMemo(() => {
    const m = new Map<string, DriftEntry>()
    if (driftData) driftData.forEach(d => m.set(`${d.kind}-${d.name}`, d))
    return m
  }, [driftData])

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

  type DepItem = { kind: string; name: string; relation: string; detail: string; onClick?: () => void; drift?: DriftEntry }
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
    const d = driftMap.get(`${c.kind}-${c.name}`)
    items.push({
      kind: c.kind, name: c.name, relation: `← ${c.source}`,
      detail: d ? `Modified ${d.modifiedAgo} ago · ${d.driftedCount}/${d.totalPods} pods stale` : `${c.kind} mounted via ${c.source}`,
      onClick: () => navigate(`/config`),
      drift: d,
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
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all ${item.drift ? 'bg-amber-950/20 border-amber-900/40' : `${s.bg} ${s.border}`} ${item.onClick ? 'cursor-pointer hover:brightness-125 hover:border-opacity-80 active:scale-[0.99]' : ''}`}>
              <span className={`shrink-0 h-2.5 w-2.5 rounded-full ${item.drift ? 'bg-neon-amber animate-pulse' : s.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] font-bold uppercase ${s.text}`}>{item.kind}</span>
                  <span className="text-[9px] text-gray-600">{item.relation}</span>
                  {item.drift && <span className="rounded bg-amber-950/50 border border-amber-900/30 px-1 py-0.5 text-[8px] font-bold text-neon-amber">STALE</span>}
                </div>
                <p className="text-[11px] font-mono text-white font-medium truncate">{item.name}</p>
                <p className={`text-[10px] truncate ${item.drift ? 'text-neon-amber' : 'text-gray-500'}`}>{item.detail}</p>
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

export function SizingPanel({ namespace, name, kind }: { namespace: string; name: string; kind: string }) {
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

// ─── Workload Metrics Panel ──────────────────────────────────────────

type WorkloadResources = { replicas: number; cpuReqM: number; cpuLimM: number; memReqMi: number; memLimMi: number }
type WorkloadMetricsResponse = MetricsData & { resources?: WorkloadResources }

export function WorkloadMetricsPanel({ namespace, name, kind }: { namespace: string; name: string; kind: string }) {
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

          {cpuTotal && cpuTotal.length > 0 && (
            <MetricChart title="CPU Usage — total across all pods" series={cpuTotal.map(s => ({ ...s, name: 'CPU Used' }))} unit="millicores" height={140} />
          )}
          {!cpuTotal?.length && cpuPerPod && cpuPerPod.length > 0 && (
            <MetricChart title={`CPU Usage — per pod (${cpuPerPod.length} pods)`} series={cpuPerPod} unit={hasRR ? 'cores' : 'millicores'} height={140} />
          )}

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

          {wlData.restarts && wlData.restarts.length > 0 && (
            <MetricChart title="Container Restarts — each line is one pod (spikes = crash loops)" series={wlData.restarts} unit="" height={80} />
          )}
        </>
      )}
    </div>
  )
}
