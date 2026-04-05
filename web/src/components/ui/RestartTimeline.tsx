import { useState, useEffect, useMemo } from 'react'
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts'

type RestartEvent = {
  timestamp: number
  container: string
  reason: string
  exitCode: number | null
}

type RestartTimelineData = {
  events: RestartEvent[]
  source: string
}

const TIME_RANGES = ['1h', '6h', '12h', '24h'] as const

export function reasonColor(reason: string): string {
  if (reason === 'OOMKilled') return '#f87171'
  if (reason === 'Unhealthy') return '#f59e0b'
  return '#9ca3af'
}

export function RestartTimeline({ namespace, pod, workload, kind }: {
  namespace: string
  pod?: string
  workload?: string
  kind?: string
}) {
  const [range_, setRange] = useState<string>('6h')
  const [data, setData] = useState<RestartTimelineData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ namespace, range: range_ })
    if (pod) params.set('pod', pod)
    if (workload) params.set('workload', workload)
    if (kind) params.set('kind', kind)

    fetch(`/api/restart-timeline?${params}`)
      .then(r => {
        if (!r.ok) return r.json().catch(() => ({})).then(b => { throw new Error(b.error || `HTTP ${r.status}`) })
        return r.json()
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setErr(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [namespace, pod, workload, kind, range_])

  const containers = useMemo(() => {
    if (!data?.events?.length) return []
    return [...new Set(data.events.map(e => e.container))]
  }, [data])

  const chartData = useMemo(() => {
    if (!data?.events?.length) return []
    return data.events.map(e => ({
      ts: e.timestamp * 1000,
      containerIdx: containers.indexOf(e.container),
      container: e.container,
      reason: e.reason,
      exitCode: e.exitCode,
    }))
  }, [data, containers])

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Restart Timeline</span>
        <div className="flex gap-1">
          {TIME_RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${range_ === r ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-gray-600 hover:text-gray-400'}`}>{r}</button>
          ))}
        </div>
      </div>
      {loading && (
        <div className="flex items-center justify-center py-4">
          <span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse mr-2" />
          <span className="text-[10px] text-gray-500">Loading restart events...</span>
        </div>
      )}
      {err && <p className="text-[10px] text-neon-amber text-center py-3">{err}</p>}
      {!loading && !err && (!data?.events?.length) && (
        <p className="text-[10px] text-gray-500 text-center py-4">No restarts in this period</p>
      )}
      {!loading && !err && data?.events && data.events.length > 0 && (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1">
            <span className="flex items-center gap-1 text-[8px] font-mono text-gray-500">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#f87171' }} /> OOMKilled
            </span>
            <span className="flex items-center gap-1 text-[8px] font-mono text-gray-500">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} /> Unhealthy
            </span>
            <span className="flex items-center gap-1 text-[8px] font-mono text-gray-500">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#9ca3af' }} /> Other
            </span>
          </div>
          <ResponsiveContainer width="100%" height={Math.max(80, containers.length * 30 + 40)}>
            <ScatterChart margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={formatTime}
                tick={{ fontSize: 9, fill: '#4b5563' }} tickLine={false} axisLine={false} />
              <YAxis dataKey="containerIdx" type="number" domain={[-0.5, containers.length - 0.5]}
                tickFormatter={(idx: number) => containers[idx] || ''}
                ticks={containers.map((_, i) => i)}
                tick={{ fontSize: 9, fill: '#4b5563' }} tickLine={false} axisLine={false} width={80} />
              <Tooltip
                content={({ payload }) => {
                  if (!payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div className="rounded-lg border border-hull-600 bg-hull-900 px-3 py-2 text-[10px] font-mono shadow-lg">
                      <p className="text-gray-400">{new Date(d.ts).toLocaleString()}</p>
                      <p className="text-white mt-0.5">Container: <span className="text-neon-cyan">{d.container}</span></p>
                      <p className="text-white">Reason: <span style={{ color: reasonColor(d.reason) }}>{d.reason}</span></p>
                      {d.exitCode != null && <p className="text-white">Exit Code: <span className="text-neon-amber">{d.exitCode}</span></p>}
                    </div>
                  )
                }}
              />
              <Scatter data={chartData} isAnimationActive={false}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={reasonColor(entry.reason)} r={5} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  )
}
