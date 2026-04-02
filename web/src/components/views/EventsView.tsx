import { useState } from 'react'
import type { ClusterEvent } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'

export function EventsView({ namespace }: { namespace: string }) {
  const [typeFilter, setTypeFilter] = useState<'' | 'Warning' | 'Normal'>('')
  const params = new URLSearchParams()
  if (typeFilter) params.set('type', typeFilter)
  if (namespace) params.set('namespace', namespace)
  const qs = params.toString() ? '?' + params.toString() : ''
  const { data, err, loading } = useFetch<ClusterEvent[]>(`/api/events${qs}`, 10000)
  const [search, setSearch] = useState('')

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const items = (data ?? []).filter(e => {
    if (!search) return true
    const q = search.toLowerCase()
    return e.object.toLowerCase().includes(q) || e.message.toLowerCase().includes(q) || e.reason.toLowerCase().includes(q) || e.namespace.toLowerCase().includes(q)
  })

  const warnCount = items.filter(e => e.type === 'Warning').length
  const normalCount = items.filter(e => e.type === 'Normal').length

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
        <span className="rounded bg-hull-800 border border-hull-700 px-2 py-0.5 text-gray-300 font-bold tracking-wide">◷ EVENTS</span>
        <span className={`text-[10px] tabular-nums ${warnCount > 0 ? 'text-neon-amber' : 'text-gray-600'}`}>{warnCount} warn</span>
        <span className="text-[10px] tabular-nums text-gray-600">{normalCount} normal</span>
        <span className="ml-auto text-gray-600">{items.length} total</span>
      </div>

      <div className="flex gap-2 items-center">
        <div className="flex rounded-lg border border-hull-700/60 overflow-hidden text-[10px]">
          {(['', 'Warning', 'Normal'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)} className={`px-2.5 py-1 transition-colors ${typeFilter === t ? 'bg-hull-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              {t || 'All'}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter events..."
          className="flex-1 rounded-lg border border-hull-700/60 bg-hull-900 px-2.5 py-1 text-[11px] text-gray-300 placeholder-gray-700 outline-none focus:border-neon-cyan/40" />
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◷</span>
          <p className="text-gray-500 text-sm">No events found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hull-700/60">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-hull-800/80 text-gray-500 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Age</th>
                <th className="px-2 py-1.5 text-left font-medium">Type</th>
                <th className="px-2 py-1.5 text-left font-medium">Reason</th>
                <th className="px-2 py-1.5 text-left font-medium">Kind</th>
                <th className="px-2 py-1.5 text-left font-medium">Object</th>
                <th className="px-2 py-1.5 text-left font-medium">NS</th>
                <th className="px-2 py-1.5 text-left font-medium">#</th>
                <th className="px-2 py-1.5 text-left font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 200).map((e, i) => (
                <tr key={i} className="border-t border-hull-800 transition-colors hover:bg-hull-800/60">
                  <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{e.age}</td>
                  <td className={`px-2 py-1.5 font-bold whitespace-nowrap ${e.type === 'Warning' ? 'text-neon-amber' : 'text-neon-green'}`}>{e.type === 'Warning' ? '⚠' : '✓'}</td>
                  <td className="px-2 py-1.5 text-white whitespace-nowrap">{e.reason}</td>
                  <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{e.kind}</td>
                  <td className="px-2 py-1.5 text-gray-400 max-w-[140px] truncate">{e.object.split('/')[1] || e.object}</td>
                  <td className="px-2 py-1.5 text-gray-600 max-w-[80px] truncate">{e.namespace}</td>
                  <td className="px-2 py-1.5 text-gray-600 tabular-nums">{e.count > 1 ? e.count : ''}</td>
                  <td className="px-2 py-1.5 text-gray-500 max-w-[250px] truncate">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
