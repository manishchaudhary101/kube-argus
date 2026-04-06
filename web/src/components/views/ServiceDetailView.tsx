import type { ServiceDescData } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Pill, Spinner } from '../ui/Atoms'

export function ServiceDetailView({ ns, name, onBack, onPod: _onPod }: { ns: string; name: string; onBack: () => void; onPod?: (ns: string, name: string) => void }) {
  const { data, err, loading } = useFetch<ServiceDescData>(`/api/services/${ns}/${name}`)

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

  const typeColor = data.type === 'LoadBalancer' ? 'bg-cyan-900/60 text-cyan-300' : data.type === 'NodePort' ? 'bg-amber-900/60 text-amber-300' : data.type === 'ExternalName' ? 'bg-purple-900/60 text-purple-300' : 'bg-gray-800 text-gray-300'

  const totalEndpoints = (data.endpoints || []).reduce((sum, sub) => sum + (sub.addresses?.length || 0), 0)

  return (
    <div className="flex h-full flex-col bg-hull-950">
      <header className="shrink-0 glass border-0 border-b border-hull-700/40 px-4 py-2.5 flex items-center gap-3">
        <button onClick={onBack} className="rounded-lg glass px-2.5 py-1 text-xs text-gray-400 hover:text-neon-cyan transition-colors">← Back</button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">⇌</span>
          <span className="font-mono text-sm font-bold text-white truncate">{data.name}</span>
          <Pill color={typeColor}>{data.type}</Pill>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Type</p>
            <p className={`text-sm font-bold mt-1 ${data.type === 'LoadBalancer' ? 'text-neon-cyan' : data.type === 'NodePort' ? 'text-neon-amber' : 'text-gray-300'}`}>{data.type}</p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Cluster IP</p>
            <p className="text-sm font-bold text-white mt-1 font-mono">{data.clusterIP || 'None'}</p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Ports</p>
            <p className="text-sm font-bold text-neon-cyan mt-1">{data.ports?.length || 0}</p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Endpoints</p>
            <p className={`text-sm font-bold mt-1 ${totalEndpoints > 0 ? 'text-neon-green' : 'text-neon-red'}`}>{totalEndpoints}</p>
          </div>
        </div>

        {/* Overview */}
        <Section title="Overview">
          <div className="stat-card p-3 space-y-0.5">
            <KV label="Namespace" value={data.namespace} />
            <KV label="Cluster IP" value={data.clusterIP} mono />
            <KV label="Age" value={data.age} />
            {data.externalIPs?.length > 0 && <KV label="External" value={data.externalIPs.join(', ')} mono />}
          </div>
        </Section>

        {/* Ports */}
        {data.ports?.length > 0 && (
          <Section title="Ports">
            <div className="overflow-x-auto rounded-xl border border-hull-700/60">
              <table className="w-full text-[11px] font-mono">
                <thead className="bg-hull-800/80 text-[9px] uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left">Name</th>
                    <th className="px-2.5 py-1.5 text-left">Port</th>
                    <th className="px-2.5 py-1.5 text-left">Target</th>
                    <th className="px-2.5 py-1.5 text-left">NodePort</th>
                    <th className="px-2.5 py-1.5 text-left">Protocol</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ports.map((p, i) => (
                    <tr key={i} className="border-t border-hull-800/50">
                      <td className="px-2.5 py-1.5 text-neon-cyan">{p.name || '-'}</td>
                      <td className="px-2.5 py-1.5 text-white font-bold">{p.port}</td>
                      <td className="px-2.5 py-1.5 text-gray-300">{p.targetPort}</td>
                      <td className="px-2.5 py-1.5 text-neon-amber">{p.nodePort > 0 ? p.nodePort : '-'}</td>
                      <td className="px-2.5 py-1.5 text-gray-500">{p.protocol}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Selector */}
        {data.selector && Object.keys(data.selector).length > 0 && (
          <Section title="Selector">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.selector).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => (
                <span key={k} className="rounded-lg bg-hull-800/60 border border-hull-700/40 px-2 py-0.5 text-[10px] font-mono">
                  <span className="text-neon-cyan">{k}</span><span className="text-gray-600">=</span><span className="text-gray-300">{v}</span>
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Endpoints */}
        {data.endpoints?.length > 0 && (
          <Section title="Endpoints">
            <div className="space-y-2">
              {data.endpoints.map((sub, si) => (
                <div key={si} className="stat-card p-3 space-y-2">
                  {sub.ports?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1">
                      {sub.ports.map((p, pi) => (
                        <span key={pi} className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-0.5 text-[10px] font-mono text-gray-400">
                          {p.name ? `${p.name}:` : ''}{p.port}/{p.protocol}
                        </span>
                      ))}
                    </div>
                  )}
                  {sub.addresses?.length > 0 ? (
                    <div className="space-y-1">
                      {sub.addresses.map((addr, ai) => (
                        <div key={ai} className="flex items-center gap-2 text-[11px]">
                          <span className={`shrink-0 h-2 w-2 rounded-full ${addr.ready ? 'bg-neon-green' : 'bg-neon-red'}`} />
                          <span className="font-mono text-white">{addr.ip}</span>
                          {addr.nodeName && <span className="text-gray-600 text-[10px]">{addr.nodeName}</span>}
                          {!addr.ready && <span className="text-[9px] text-neon-red font-medium">NOT READY</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-600 italic">No addresses</p>
                  )}
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

        {/* Events */}
        {data.events?.length > 0 && (
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
