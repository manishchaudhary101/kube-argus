import { useMemo, memo } from 'react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts'

export type MetricSeries = { name: string; values: [number, number][] }
export type MetricsData = Record<string, MetricSeries[]>
export type RefLine = { value: number; label: string; color: string }

const isLightTheme = () => document.documentElement.getAttribute('data-theme') === 'notion'

const DARK_CHART_COLORS  = ['#06b6d4', '#f59e0b', '#22c55e', '#a78bfa', '#f87171', '#38bdf8', '#facc15', '#4ade80', '#c084fc', '#fb923c']
const LIGHT_CHART_COLORS = ['#0891b2', '#b45309', '#059669', '#7c3aed', '#dc2626', '#0284c7', '#a16207', '#16a34a', '#9333ea', '#c2410c']
export function chartColors() { return isLightTheme() ? LIGHT_CHART_COLORS : DARK_CHART_COLORS }
export const refColor = {
  get req()      { return isLightTheme() ? '#b45309' : '#facc15' },
  get lim()      { return isLightTheme() ? '#be123c' : '#f87171' },
  get warn()     { return isLightTheme() ? '#92400e' : '#f59e0b' },
  get capacity() { return isLightTheme() ? '#be123c' : '#ef4444' },
  get limits()   { return isLightTheme() ? '#7c3aed' : '#a78bfa' },
  get requests() { return isLightTheme() ? '#b45309' : '#f59e0b' },
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

export const MetricChart = memo(function MetricChart({ title, series, unit, height = 120, refLines }: { title: string; series: MetricSeries[]; unit: string; height?: number; refLines?: RefLine[] }) {
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
              <span className="inline-block w-2.5 h-0.5 rounded" style={{ background: chartColors()[i % chartColors().length] }} />
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
                <stop offset="0%" stopColor={chartColors()[i % chartColors().length]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={chartColors()[i % chartColors().length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis dataKey="ts" tickFormatter={formatTime} tick={{ fontSize: 9, fill: 'var(--chart-axis)' }} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tickFormatter={formatVal} tick={{ fontSize: 9, fill: 'var(--chart-axis)' }} tickLine={false} axisLine={false} width={52} />
          <Tooltip
            contentStyle={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace' }}
            labelFormatter={(ts) => new Date(Number(ts)).toLocaleTimeString()}
            formatter={(value) => [formatVal(Number(value))]}
          />
          {seriesNames.slice(0, 10).map((name, i) => (
            <Area key={name} type="monotone" dataKey={name} stroke={chartColors()[i % chartColors().length]} fill={`url(#grad-${stableGradId}-${i})`}
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
})

export const METRIC_RANGES = ['1h', '3h', '6h', '12h', '24h'] as const
