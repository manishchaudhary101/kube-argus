export function ResourceBar({ used, req, lim, label, unit }: { used: number; req: number; lim: number; label: string; unit: string }) {
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
