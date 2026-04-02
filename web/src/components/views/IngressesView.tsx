import { useState } from 'react'
import type { Ingress, IngressDescData } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Pill, Spinner } from '../ui/Atoms'

export function IngressDetailView({ ns, name, onBack }: { ns: string; name: string; onBack: () => void }) {
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

export function IngressesView({ namespace, onIngress }: { namespace: string; onIngress: (ns: string, name: string) => void }) {
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
