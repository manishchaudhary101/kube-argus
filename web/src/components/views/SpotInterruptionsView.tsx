import { useState, useEffect, useRef } from 'react'
import { useFetch } from '../../hooks/useFetch'

export type SpotEvent = { reason: string; node: string; nodepool: string; instanceType: string; zone: string; message: string; age: string; timestamp: string; affectedPods: number }
export type ResilienceEntry = { name: string; namespace: string; kind: string; replicas: number; spotPods: number; onDemandPods: number; uniqueNodes: number; uniqueZones: number; uniqueInstTypes: number; recentDisruptions: number; score: number; rating: string }
export type SpotData = { events: SpotEvent[]; resilience: ResilienceEntry[] }

export const SPOT_REASONS = ['SpotInterrupted', 'TerminatingOnInterruption', 'FailedDraining', 'InstanceTerminating', 'Unconsolidatable', 'DisruptionBlocked'] as const

export function SpotInterruptionsView({ onNode, hiddenReasons, onToggleReason }: { onNode: (name: string) => void; hiddenReasons: string[]; onToggleReason: (r: string) => void }) {
  const { data: spotData } = useFetch<SpotData>('/api/spot-interruptions', 10000)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!filterOpen) return
    const handler = (e: MouseEvent) => { if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterOpen])

  const spotEvents = spotData?.events ?? []
  const reasonCounts: Record<string, number> = {}
  spotEvents.forEach(ev => { reasonCounts[ev.reason] = (reasonCounts[ev.reason] || 0) + 1 })

  const filteredSpotEvents = spotEvents.filter(ev => !hiddenReasons.includes(ev.reason))
  const activeCount = SPOT_REASONS.length - hiddenReasons.length

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 text-[10px]">
        <div className="relative" ref={filterRef}>
          <button type="button" onClick={() => setFilterOpen(v => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-hull-600/50 bg-hull-800/60 px-2.5 py-1.5 text-[10px] text-gray-300 hover:text-white transition-colors">
            <span>Filter</span>
            <span className="rounded bg-hull-700 px-1.5 py-0.5 text-[9px] font-bold text-neon-cyan tabular-nums">{activeCount}/{SPOT_REASONS.length}</span>
            <span className={`text-[8px] text-gray-500 transition-transform ${filterOpen ? 'rotate-180' : ''}`}>▾</span>
          </button>
          {filterOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-lg border border-hull-600 bg-hull-900 shadow-xl py-1">
              {SPOT_REASONS.map(r => {
                const active = !hiddenReasons.includes(r)
                const count = reasonCounts[r] || 0
                return (
                  <button type="button" key={r} onClick={(e) => { e.stopPropagation(); onToggleReason(r) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-hull-800 transition-colors">
                    <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${active ? 'bg-neon-cyan/20 border-neon-cyan/50 text-neon-cyan' : 'border-hull-600 text-transparent'}`}>
                      {active && '✓'}
                    </span>
                    <span className={active ? 'text-gray-200' : 'text-gray-500'}>{r}</span>
                    {count > 0 && <span className="ml-auto tabular-nums text-gray-600">({count})</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <span className="text-gray-600 tabular-nums">{filteredSpotEvents.length} event{filteredSpotEvents.length !== 1 ? 's' : ''}</span>
      </div>
      {filteredSpotEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◎</span>
          <p className="text-gray-500 text-sm">No disruption events{hiddenReasons.length > 0 ? ' matching filters' : ''}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-hull-700 divide-y divide-hull-800 overflow-hidden">
          {filteredSpotEvents.map((ev, i) => (
            <div key={`${ev.node}-${ev.reason}-${i}`} className="flex items-start gap-2.5 px-3 py-2.5 text-[11px] hover:bg-hull-800/30 transition-colors">
              <span className={`mt-1 shrink-0 h-2 w-2 rounded-full ${ev.reason === 'SpotInterrupted' || ev.reason === 'InstanceTerminating' ? 'bg-neon-red animate-pulse' : 'bg-neon-amber'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold border ${ev.reason === 'SpotInterrupted' || ev.reason === 'InstanceTerminating' ? 'bg-red-950/40 border-red-900/30 text-red-400' : 'bg-amber-950/40 border-amber-900/30 text-amber-400'}`}>{ev.reason}</span>
                  <button type="button" onClick={() => onNode(ev.node)} className="font-mono text-neon-cyan hover:underline cursor-pointer">{ev.node}</button>
                  {ev.nodepool && <span className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-0.5 text-[9px] text-gray-400">{ev.nodepool}</span>}
                  {ev.instanceType && <span className="text-gray-500">{ev.instanceType}</span>}
                  {ev.zone && <span className="text-gray-600">{ev.zone}</span>}
                  <span className="text-gray-600 ml-auto shrink-0">{ev.age} ago</span>
                </div>
                <p className="text-gray-500 mt-0.5 truncate">{ev.message}</p>
                {ev.affectedPods > 0 && <span className="text-gray-600 text-[9px]">{ev.affectedPods} pods on this node</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function PodResilienceView() {
  const { data: spotData } = useFetch<SpotData>('/api/spot-interruptions', 15000)
  const [nsFilter, setNsFilter] = useState('')
  const [ratingFilter, setRatingFilter] = useState<'' | 'low' | 'medium' | 'high'>('')

  const allRes = spotData?.resilience ?? []
  const resNamespaces = [...new Set(allRes.map(r => r.namespace))].sort()
  const filtered = allRes.filter(r =>
    (nsFilter === '' || r.namespace === nsFilter) &&
    (ratingFilter === '' || r.rating === ratingFilter)
  )

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 flex-wrap text-[10px]">
        <select value={nsFilter} onChange={e => setNsFilter(e.target.value)}
          className="rounded-lg border border-hull-600/50 bg-hull-800/60 px-2 py-1 text-[10px] text-gray-300 outline-none">
          <option value="">All namespaces</option>
          {resNamespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <div className="flex gap-1">
          <button onClick={() => setRatingFilter('')} className={`rounded-lg px-2 py-0.5 border transition-colors ${ratingFilter === '' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All</button>
          <button onClick={() => setRatingFilter(ratingFilter === 'low' ? '' : 'low')} className={`rounded-lg px-2 py-0.5 border transition-colors ${ratingFilter === 'low' ? 'bg-red-950/60 text-neon-red border-red-900/50' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>Low</button>
          <button onClick={() => setRatingFilter(ratingFilter === 'medium' ? '' : 'medium')} className={`rounded-lg px-2 py-0.5 border transition-colors ${ratingFilter === 'medium' ? 'bg-amber-950/60 text-neon-amber border-amber-900/50' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>Medium</button>
          <button onClick={() => setRatingFilter(ratingFilter === 'high' ? '' : 'high')} className={`rounded-lg px-2 py-0.5 border transition-colors ${ratingFilter === 'high' ? 'bg-emerald-950/60 text-neon-green border-emerald-900/50' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>High</button>
        </div>
        <span className="text-gray-600 ml-auto tabular-nums">{filtered.length} of {allRes.length} workloads</span>
      </div>
      <div className="rounded-lg border border-hull-700/50 bg-hull-800/30 px-3 py-2 text-[9px] text-gray-500 leading-relaxed">
        <span className="font-bold text-gray-400">Score (0-100):</span>{' '}
        Starts at 100. Deductions: single replica <span className="text-neon-amber">-40</span>, 2 replicas <span className="text-neon-amber">-15</span>,
        all pods on 1 node <span className="text-neon-amber">-30</span>, single instance type <span className="text-neon-amber">-10</span>,
        single zone <span className="text-neon-amber">-10</span>, each disruption <span className="text-neon-amber">-20</span>.
        Rating: <span className="text-neon-green">HIGH</span> &gt;60 · <span className="text-neon-amber">MEDIUM</span> 31-60 · <span className="text-neon-red">LOW</span> ≤30
      </div>
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◎</span>
          <p className="text-gray-500 text-sm">{allRes.length === 0 ? 'No workloads on spot nodes' : 'No workloads matching filters'}</p>
        </div>
      ) : (
        <div className="stat-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-gray-500 border-b border-hull-700 bg-hull-800/50">
                  <th className="text-left py-1.5 px-2 font-medium">Workload</th>
                  <th className="text-left py-1.5 px-2 font-medium">Namespace</th>
                  <th className="text-left py-1.5 px-2 font-medium">Kind</th>
                  <th className="text-center py-1.5 px-2 font-medium">Replicas</th>
                  <th className="text-center py-1.5 px-2 font-medium">Spot / OD</th>
                  <th className="text-center py-1.5 px-2 font-medium">Nodes</th>
                  <th className="text-center py-1.5 px-2 font-medium">Zones</th>
                  <th className="text-center py-1.5 px-2 font-medium">Inst Types</th>
                  <th className="text-center py-1.5 px-2 font-medium">Disruptions</th>
                  <th className="text-center py-1.5 px-2 font-medium">Score</th>
                  <th className="text-center py-1.5 px-2 font-medium">Rating</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={`${r.namespace}-${r.name}`} className="border-b border-hull-800 last:border-0">
                    <td className="py-1.5 px-2 font-mono text-white truncate max-w-[200px]">{r.name}</td>
                    <td className="py-1.5 px-2 text-gray-500 truncate max-w-[120px]">{r.namespace}</td>
                    <td className="py-1.5 px-2 text-gray-500">{r.kind}</td>
                    <td className="py-1.5 px-2 text-center text-gray-400 tabular-nums">{r.replicas}</td>
                    <td className="py-1.5 px-2 text-center tabular-nums"><span className="text-neon-amber">{r.spotPods}</span><span className="text-gray-600"> / </span><span className="text-neon-green">{r.onDemandPods}</span></td>
                    <td className="py-1.5 px-2 text-center text-gray-400 tabular-nums">{r.uniqueNodes}</td>
                    <td className="py-1.5 px-2 text-center text-gray-400 tabular-nums">{r.uniqueZones}</td>
                    <td className="py-1.5 px-2 text-center text-gray-400 tabular-nums">{r.uniqueInstTypes}</td>
                    <td className="py-1.5 px-2 text-center tabular-nums">{r.recentDisruptions > 0 ? <span className="text-neon-red font-bold">{r.recentDisruptions}</span> : <span className="text-gray-600">0</span>}</td>
                    <td className="py-1.5 px-2 text-center tabular-nums">
                      <span className={`font-bold ${r.score > 60 ? 'text-neon-green' : r.score > 30 ? 'text-neon-amber' : 'text-neon-red'}`}>{r.score}</span>
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold border ${r.rating === 'low' ? 'bg-red-950/40 border-red-900/30 text-neon-red' : r.rating === 'medium' ? 'bg-amber-950/40 border-amber-900/30 text-neon-amber' : 'bg-emerald-950/40 border-emerald-900/30 text-neon-green'}`}>
                        {r.rating.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
