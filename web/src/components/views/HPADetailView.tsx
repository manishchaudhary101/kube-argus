import type { HPADescData } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Pill, Spinner } from '../ui/Atoms'

export function HPADetailView({ ns, name, onBack }: { ns: string; name: string; onBack: () => void }) {
  const { data, err, loading } = useFetch<HPADescData>(`/api/hpa/${ns}/${name}`)

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner /></div>
  if (err) return <div className="p-4"><button onClick={onBack} className="text-neon-cyan text-xs mb-2">← Back</button><p className="text-neon-red">{err}</p></div>
  if (!data) return null

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">{title}</h3>
      {children}
    </div>
  )

  const health = data.currentReplicas >= data.maxReplicas ? 'capped' : data.currentReplicas <= data.minReplicas && data.desiredReplicas > data.currentReplicas ? 'starved' : 'ok'
  const pct = data.maxReplicas > 0 ? (data.currentReplicas / data.maxReplicas) * 100 : 0

  return (
    <div className="flex h-full flex-col bg-hull-950">
      <header className="shrink-0 glass border-0 border-b border-hull-700/40 px-4 py-2.5 flex items-center gap-3">
        <button onClick={onBack} className="rounded-lg glass px-2.5 py-1 text-xs text-gray-400 hover:text-neon-cyan transition-colors">← Back</button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">⟳</span>
          <span className="font-mono text-sm font-bold text-white truncate">{data.name}</span>
          <Pill color="bg-purple-900/60 text-purple-300">HPA</Pill>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Target</p>
            <p className="text-sm font-bold text-neon-cyan mt-1 font-mono truncate">{data.scaleTargetRef.kind}/{data.scaleTargetRef.name}</p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Current</p>
            <p className="text-xl font-bold text-white mt-1 tabular-nums">{data.currentReplicas}</p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Range</p>
            <p className="text-sm font-bold text-gray-300 mt-1 tabular-nums">{data.minReplicas} – {data.maxReplicas}</p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Status</p>
            <p className={`text-sm font-bold mt-1 ${health === 'capped' ? 'text-neon-red' : health === 'starved' ? 'text-neon-amber' : 'text-neon-green'}`}>
              {health === 'capped' ? 'AT MAX' : health === 'starved' ? 'SCALING' : 'HEALTHY'}
            </p>
          </div>
        </div>

        {/* Replicas Bar */}
        <Section title="Replicas">
          <div className="stat-card p-3">
            <div className="flex items-center justify-between text-[11px] mb-2">
              <span className="text-gray-500">Current / Desired</span>
              <span className="tabular-nums font-mono">
                <span className="text-neon-cyan font-bold">{data.currentReplicas}</span>
                <span className="text-gray-600"> / {data.minReplicas}–{data.maxReplicas}</span>
                {data.desiredReplicas !== data.currentReplicas && <span className="text-neon-amber ml-1">(wants {data.desiredReplicas})</span>}
              </span>
            </div>
            <div className="h-2 rounded-full bg-hull-800/80 overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${health === 'capped' ? 'bg-gradient-to-r from-red-500 to-red-400' : health === 'starved' ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-neon-cyan to-neon-green'}`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <div className="flex justify-between text-[9px] text-gray-600 mt-1">
              <span>{data.minReplicas} min</span>
              <span>{data.maxReplicas} max</span>
            </div>
          </div>
        </Section>

        {/* Overview */}
        <Section title="Overview">
          <div className="stat-card p-3 space-y-0.5">
            <div className="flex items-baseline gap-2 py-0.5">
              <span className="text-[10px] text-gray-500 min-w-[100px] shrink-0">Namespace</span>
              <span className="text-[11px] text-gray-200">{data.namespace}</span>
            </div>
            <div className="flex items-baseline gap-2 py-0.5">
              <span className="text-[10px] text-gray-500 min-w-[100px] shrink-0">Target Ref</span>
              <span className="text-[11px] text-neon-cyan font-mono">{data.scaleTargetRef.kind}/{data.scaleTargetRef.name}</span>
            </div>
            <div className="flex items-baseline gap-2 py-0.5">
              <span className="text-[10px] text-gray-500 min-w-[100px] shrink-0">Age</span>
              <span className="text-[11px] text-gray-200">{data.age}</span>
            </div>
          </div>
        </Section>

        {/* Metrics */}
        {data.metrics?.length > 0 && (
          <Section title="Metrics">
            <div className="overflow-x-auto rounded-xl border border-hull-700/60">
              <table className="w-full text-[11px] font-mono">
                <thead className="bg-hull-800/80 text-[9px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left">Name</th>
                    <th className="px-2.5 py-1.5 text-left">Type</th>
                    <th className="px-2.5 py-1.5 text-left">Current</th>
                    <th className="px-2.5 py-1.5 text-left">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {data.metrics.map((m, i) => (
                    <tr key={i} className="border-t border-hull-800/50">
                      <td className="px-2.5 py-1.5 text-white font-semibold capitalize">{m.name || m.type}</td>
                      <td className="px-2.5 py-1.5 text-gray-500 text-[10px] uppercase">{m.type}</td>
                      <td className={`px-2.5 py-1.5 font-bold ${m.current && m.target && parseInt(m.current) > parseInt(m.target) ? 'text-neon-red' : 'text-neon-cyan'}`}>{m.current || '—'}</td>
                      <td className="px-2.5 py-1.5 text-gray-400">{m.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Conditions */}
        {data.conditions?.length > 0 && (
          <Section title="Conditions">
            <div className="space-y-1.5">
              {data.conditions.map((c, i) => (
                <div key={i} className="stat-card p-3 flex items-start gap-2">
                  <span className={`shrink-0 mt-0.5 w-2.5 h-2.5 rounded-full ${c.status === 'True' ? 'bg-neon-green' : 'bg-neon-red'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-white">{c.type}</span>
                      <span className={`text-[10px] font-bold ${c.status === 'True' ? 'text-neon-green' : 'text-neon-red'}`}>{c.status}</span>
                      {c.age && <span className="text-[9px] text-gray-600">{c.age}</span>}
                    </div>
                    {c.reason && <p className="text-[10px] text-gray-400 mt-0.5">{c.reason}</p>}
                    {c.message && <p className="text-[10px] text-gray-500 mt-0.5 break-words">{c.message}</p>}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Annotations */}
        {data.annotations && Object.keys(data.annotations).length > 0 && (
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
        {data.labels && Object.keys(data.labels).length > 0 && (
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
      </div>
    </div>
  )
}
