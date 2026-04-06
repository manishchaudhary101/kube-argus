import { useState } from 'react'
import type { HPA } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'
import { YamlModal } from '../modals/YamlModal'

export function HPAView({ namespace, onHPA }: { namespace: string; onHPA?: (ns: string, name: string) => void }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<HPA[]>(`/api/hpa${q}`, 10000)
  const [yamlTarget, setYamlTarget] = useState<{ ns: string; name: string } | null>(null)

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
      {yamlTarget && <YamlModal kind="HPA" ns={yamlTarget.ns} name={yamlTarget.name} onClose={() => setYamlTarget(null)} />}
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
          <div key={`${h.namespace}-${h.name}`} className={`stat-card p-3 space-y-2 ${onHPA ? 'cursor-pointer hover:bg-hull-800/40 transition-colors' : ''}`} onClick={() => onHPA?.(h.namespace, h.name)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{h.name}</p>
                <div className="flex items-center gap-2 mt-0.5 text-[10px]">
                  <span className="text-gray-500">{h.namespace}</span>
                  <span className="text-gray-700">·</span>
                  <span className="text-gray-400 font-mono">{h.reference}</span>
                </div>
              </div>
              <button onClick={() => setYamlTarget({ ns: h.namespace, name: h.name })} className="shrink-0 rounded border border-hull-600 bg-hull-800 px-1.5 py-0.5 text-[9px] text-gray-500 hover:text-white transition-colors">YAML</button>
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
