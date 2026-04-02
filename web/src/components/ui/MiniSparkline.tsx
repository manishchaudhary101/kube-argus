export function fmtMetric(v: number, unit: string) {
  if (unit === 'Mi') return v >= 1024 ? `${(v / 1024).toFixed(1)}Gi` : `${v}Mi`
  return `${v}${unit}`
}

export function MiniSparkline({ points, color, used, limit, unit }: { points: number[]; color: string; used: number; limit: number; unit: string }) {
  const W = 36, H = 18
  const hasGraph = points && points.length >= 2
  const mx = hasGraph ? Math.max(...points, 1) : 1
  const mn = hasGraph ? Math.min(...points, 0) : 0
  const rng = mx - mn || 1
  const coords = hasGraph ? points.map((v, i) => [
    1 + (i / (points.length - 1)) * (W - 2),
    1 + (H - 2) - ((v - mn) / rng) * (H - 2)
  ]) : []
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const areaPath = linePath + (coords.length ? ` L${coords[coords.length - 1][0].toFixed(1)},${H} L${coords[0][0].toFixed(1)},${H} Z` : '')
  const tooltip = limit > 0 ? `${fmtMetric(used, unit)} / ${fmtMetric(limit, unit)}` : fmtMetric(used, unit)
  const label = limit > 0 ? `${fmtMetric(used, unit)}/${fmtMetric(limit, unit)}` : used > 0 ? fmtMetric(used, unit) : '—'
  const gradId = `sg-${color.replace('#', '')}`
  return (
    <div className="flex items-center gap-1 overflow-hidden" title={tooltip}>
      {hasGraph && (
        <svg width={W} height={H} className="shrink-0">
          <defs><linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.35" /><stop offset="100%" stopColor={color} stopOpacity="0.05" /></linearGradient></defs>
          <path d={areaPath} fill={`url(#${gradId})`} />
          <path d={linePath} fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="text-[9px] text-gray-400 tabular-nums truncate">{label}</span>
    </div>
  )
}
