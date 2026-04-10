import { useState, useEffect } from 'react'

export type MetricSeries = { name: string; values: [number, number][] }
export type MetricsData = Record<string, MetricSeries[]>

const isLightTheme = () => document.documentElement.getAttribute('data-theme') === 'notion'
const DARK_CHART_COLORS  = ['#06b6d4', '#f59e0b', '#22c55e', '#a78bfa', '#f87171', '#38bdf8', '#facc15', '#4ade80', '#c084fc', '#fb923c']
const LIGHT_CHART_COLORS = ['#0891b2', '#b45309', '#059669', '#7c3aed', '#dc2626', '#0284c7', '#a16207', '#16a34a', '#9333ea', '#c2410c']
export function chartColors() { return isLightTheme() ? LIGHT_CHART_COLORS : DARK_CHART_COLORS }

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

export const METRIC_RANGES = ['1h', '3h', '6h', '12h', '24h'] as const

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
