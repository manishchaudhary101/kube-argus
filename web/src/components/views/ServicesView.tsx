import { useState } from 'react'
import type { Service } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'
import { YamlModal } from '../modals/YamlModal'

export function ServicesView({ namespace }: { namespace: string }) {
  const url = namespace ? `/api/services?namespace=${namespace}` : '/api/services'
  const { data, err, loading } = useFetch<Service[]>(url, 10000)
  const [sortCol, setSortCol] = useState<'name' | 'ns' | 'type' | 'ports' | 'age'>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [yamlTarget, setYamlTarget] = useState<{ ns: string; name: string } | null>(null)
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
      case 'type': cmp = a.type.localeCompare(b.type); break
      case 'ports': cmp = a.ports.localeCompare(b.ports); break
      case 'age': cmp = a.age.localeCompare(b.age); break
    }
    return sortAsc ? cmp : -cmp
  })

  const thCls = (col: typeof sortCol) =>
    `px-2 py-1.5 text-left font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''}`
  const arrow = (col: typeof sortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''
  const typeColor = (t: string) => t === 'LoadBalancer' ? 'text-neon-cyan' : t === 'NodePort' ? 'text-neon-amber' : t === 'ExternalName' ? 'text-purple-400' : 'text-gray-400'

  return (
    <div className="p-3 space-y-2">
      {yamlTarget && <YamlModal kind="Service" ns={yamlTarget.ns} name={yamlTarget.name} onClose={() => setYamlTarget(null)} />}
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">⇌ SERVICES</span>
        <span className="ml-auto tabular-nums text-gray-600">{items.length} svc{items.length !== 1 ? 's' : ''}</span>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">⇌</span>
          <p className="text-gray-500 text-sm">No services found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hull-700/60">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-hull-800/80 text-gray-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className={thCls('ns')} onClick={() => toggle('ns')}>NS{arrow('ns')}</th>
                <th className={thCls('name')} onClick={() => toggle('name')}>Name{arrow('name')}</th>
                <th className={thCls('type')} onClick={() => toggle('type')}>Type{arrow('type')}</th>
                <th className="px-2 py-1.5 text-left font-medium">ClusterIP</th>
                <th className="px-2 py-1.5 text-left font-medium">External</th>
                <th className={thCls('ports')} onClick={() => toggle('ports')}>Ports{arrow('ports')}</th>
                <th className={thCls('age')} onClick={() => toggle('age')}>Age{arrow('age')}</th>
                <th className="px-2 py-1.5 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(s => (
                <tr key={`${s.namespace}/${s.name}`} className="border-t border-hull-800 transition-colors hover:bg-hull-800/60">
                  <td className="px-2 py-1.5 text-gray-500 max-w-[80px] truncate">{s.namespace}</td>
                  <td className="px-2 py-1.5 text-white font-semibold">{s.name}</td>
                  <td className={`px-2 py-1.5 font-bold ${typeColor(s.type)}`}>{s.type}</td>
                  <td className="px-2 py-1.5 text-gray-400 font-mono">{s.clusterIP || '-'}</td>
                  <td className="px-2 py-1.5 text-neon-amber max-w-[120px] truncate text-[10px]">{s.externalIP || <span className="text-gray-700">-</span>}</td>
                  <td className="px-2 py-1.5 text-gray-300 max-w-[180px] truncate">{s.ports || '-'}</td>
                  <td className="px-2 py-1.5 text-gray-500">{s.age}</td>
                  <td className="px-2 py-1.5"><button onClick={() => setYamlTarget({ ns: s.namespace, name: s.name })} className="rounded border border-hull-600 bg-hull-800 px-1.5 py-0.5 text-[9px] text-gray-500 hover:text-white transition-colors">YAML</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
