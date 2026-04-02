import { useState } from 'react'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'

type TopologyConstraint = { topologyKey: string; topologyLabel: string; maxSkew: number; whenUnsatisfiable: string; enforcement: string; description: string; labelSelector: string }
type TopologyDomain = { domain: string; count: number }
type TopologyWorkload = { kind: string; name: string; namespace: string; replicas: number; constraint: TopologyConstraint; actualSkew: number; distribution: TopologyDomain[]; emptyDomains: number; totalDomains: number; status: string }
type TopologyData = { workloads: TopologyWorkload[] }

export function TopologySpreadView() {
  const { data, err, loading } = useFetch<TopologyData>('/api/topology-spread', 15000)
  const [statusFilter, setStatusFilter] = useState<'all' | 'violated' | 'at-limit' | 'single-domain'>('all')
  const [keyFilter, setKeyFilter] = useState<string>('all')
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const workloads = data?.workloads || []
  const violated = workloads.filter(w => w.status === 'violated')
  const atLimit = workloads.filter(w => w.status === 'at-limit')
  const satisfied = workloads.filter(w => w.status === 'satisfied')
  const singleDomain = workloads.filter(w => w.status === 'single-domain')

  const keyLabels = Array.from(new Set(workloads.map(w => w.constraint.topologyLabel || w.constraint.topologyKey)))

  const keyStats = new Map<string, { total: number; violated: number; atLimit: number; singleDomain: number }>()
  for (const w of workloads) {
    const label = w.constraint.topologyLabel || w.constraint.topologyKey
    const s = keyStats.get(label) || { total: 0, violated: 0, atLimit: 0, singleDomain: 0 }
    s.total++
    if (w.status === 'violated') s.violated++
    else if (w.status === 'at-limit') s.atLimit++
    else if (w.status === 'single-domain') s.singleDomain++
    keyStats.set(label, s)
  }

  const filtered = workloads.filter(w => {
    if (statusFilter !== 'all' && w.status !== statusFilter) return false
    if (keyFilter !== 'all' && (w.constraint.topologyLabel || w.constraint.topologyKey) !== keyFilter) return false
    return true
  })

  const statusBadge = (s: string) => {
    if (s === 'violated') return 'bg-red-950/60 border-red-900/50 text-neon-red'
    if (s === 'at-limit') return 'bg-amber-950/60 border-amber-900/50 text-neon-amber'
    if (s === 'single-domain') return 'bg-gray-950/60 border-gray-800/50 text-gray-400'
    return 'bg-green-950/40 border-green-900/30 text-neon-green'
  }
  const statusLabel = (s: string) => {
    if (s === 'violated') return 'VIOLATED'
    if (s === 'at-limit') return 'AT LIMIT'
    if (s === 'single-domain') return 'N/A'
    return 'OK'
  }

  const toggleExpand = (key: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const topologyIcon = (key: string) => {
    if (key.includes('hostname')) return '◎'
    if (key.includes('zone')) return '◉'
    if (key.includes('region')) return '⊕'
    if (key.includes('instance-type')) return '▣'
    return '◈'
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2 font-mono text-[11px] flex-wrap">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">◈ TOPOLOGY SPREAD</span>
        <span className="text-gray-500">workloads with TopologySpreadConstraints</span>
        <span className="ml-auto tabular-nums text-gray-600">{workloads.length} constraint{workloads.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Status summary cards */}
      <div className="grid grid-cols-4 gap-2">
        <button onClick={() => setStatusFilter(statusFilter === 'violated' ? 'all' : 'violated')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'violated' ? 'ring-1 ring-neon-red/40' : ''}`}>
          <p className={`text-lg font-extrabold tabular-nums ${violated.length > 0 ? 'text-neon-red' : 'text-gray-600'}`}>{violated.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Violated</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'at-limit' ? 'all' : 'at-limit')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'at-limit' ? 'ring-1 ring-neon-amber/40' : ''}`}>
          <p className={`text-lg font-extrabold tabular-nums ${atLimit.length > 0 ? 'text-neon-amber' : 'text-gray-600'}`}>{atLimit.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">At Limit</p>
        </button>
        <button onClick={() => setStatusFilter('all')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'all' ? 'ring-1 ring-neon-cyan/30' : ''}`}>
          <p className="text-lg font-extrabold tabular-nums text-neon-green">{satisfied.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Satisfied</p>
        </button>
        <button onClick={() => setStatusFilter(statusFilter === 'single-domain' ? 'all' : 'single-domain')} className={`stat-card p-2 text-center transition-all ${statusFilter === 'single-domain' ? 'ring-1 ring-gray-500/40' : ''}`}>
          <p className={`text-lg font-extrabold tabular-nums ${singleDomain.length > 0 ? 'text-gray-400' : 'text-gray-600'}`}>{singleDomain.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Single Domain</p>
        </button>
      </div>

      {/* Topology key classification tabs */}
      {keyLabels.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setKeyFilter('all')}
            className={`rounded border px-2 py-1 text-[10px] font-mono transition-all ${keyFilter === 'all' ? 'bg-indigo-950/60 border-indigo-800/60 text-indigo-300' : 'bg-hull-900/40 border-hull-700/30 text-gray-500 hover:text-gray-300'}`}>
            All Keys <span className="text-gray-600 ml-0.5">({workloads.length})</span>
          </button>
          {keyLabels.map(label => {
            const stats = keyStats.get(label)
            const hasIssues = (stats?.violated || 0) > 0 || (stats?.atLimit || 0) > 0
            return (
              <button key={label} onClick={() => setKeyFilter(keyFilter === label ? 'all' : label)}
                className={`rounded border px-2 py-1 text-[10px] font-mono transition-all flex items-center gap-1.5 ${keyFilter === label ? 'bg-indigo-950/60 border-indigo-800/60 text-indigo-300' : 'bg-hull-900/40 border-hull-700/30 text-gray-500 hover:text-gray-300'}`}>
                <span className="text-indigo-400">{topologyIcon(label)}</span>
                {label}
                <span className="text-gray-600">({stats?.total || 0})</span>
                {(stats?.violated || 0) > 0 && <span className="h-1.5 w-1.5 rounded-full bg-neon-red" title={`${stats!.violated} violated`} />}
                {(stats?.atLimit || 0) > 0 && !hasIssues && <span className="h-1.5 w-1.5 rounded-full bg-neon-amber" title={`${stats!.atLimit} at limit`} />}
              </button>
            )
          })}
        </div>
      )}

      {workloads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◈</span>
          <p className="text-gray-400 text-sm">No workloads with TopologySpreadConstraints found</p>
          <p className="text-[10px] text-gray-600 mt-1">Add <code className="text-gray-400">topologySpreadConstraints</code> to your deployment specs</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <p className="text-gray-500 text-xs">No constraints match the current filters</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((w, i) => {
            const maxCount = w.distribution.length > 0 ? Math.max(...w.distribution.map(d => d.count)) : 1
            const rowKey = `${w.namespace}-${w.name}-${w.constraint.topologyKey}-${i}`
            const isExpanded = expandedRows.has(rowKey)
            const isHard = w.constraint.enforcement === 'Hard'
            const isSingleDomain = w.status === 'single-domain'

            return (
              <div key={rowKey} className={`stat-card overflow-hidden ${isSingleDomain ? 'opacity-60' : ''}`}>
                <div className="p-3">
                  {/* Header row */}
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${statusBadge(w.status)}`}>{statusLabel(w.status)}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${isHard ? 'bg-red-950/40 border-red-900/40 text-red-400' : 'bg-sky-950/40 border-sky-900/40 text-sky-400'}`}>{isHard ? 'HARD' : 'SOFT'}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider bg-indigo-950/40 border-indigo-900/40 text-indigo-400`}>
                          {topologyIcon(w.constraint.topologyKey)} {w.constraint.topologyLabel || w.constraint.topologyKey}
                        </span>
                        <span className="text-[10px] text-gray-500 font-mono">{w.kind}</span>
                        <span className="text-sm font-bold text-white font-mono">{w.namespace}/{w.name}</span>
                        <span className="text-[10px] text-gray-500 tabular-nums">{w.replicas} pod{w.replicas !== 1 ? 's' : ''}</span>
                      </div>

                      <p className="mt-1.5 text-[10px] text-gray-300/80 italic leading-relaxed">{w.constraint.description}</p>

                      {isSingleDomain ? (
                        <p className="mt-1 text-[10px] text-gray-500">Only {w.totalDomains} domain{w.totalDomains !== 1 ? 's' : ''} found for this topology key — skew cannot be evaluated. All pods are in: <span className="font-mono text-gray-400">{w.distribution[0]?.domain || '—'}</span></p>
                      ) : (
                        <div className="flex items-center gap-3 mt-1.5 text-[10px] flex-wrap">
                          <span className="text-gray-400">key: <span className="text-neon-cyan font-mono">{w.constraint.topologyKey}</span></span>
                          <span className="text-gray-400">maxSkew: <span className="font-mono text-white">{w.constraint.maxSkew}</span></span>
                          <span className="text-gray-400">actual: <span className={`font-mono font-bold ${w.status === 'violated' ? 'text-neon-red' : w.status === 'at-limit' ? 'text-neon-amber' : 'text-neon-green'}`}>{w.actualSkew}</span></span>
                          <span className="text-gray-400">domains: <span className="font-mono text-white">{w.totalDomains}</span></span>
                          {w.constraint.labelSelector && (
                            <span className="text-gray-400">selector: <span className="font-mono text-purple-400">{w.constraint.labelSelector}</span></span>
                          )}
                        </div>
                      )}
                    </div>
                    {!isSingleDomain && (
                      <button onClick={() => toggleExpand(rowKey)} className="text-gray-500 hover:text-gray-300 transition-colors text-[10px] font-mono shrink-0 mt-0.5" title={isExpanded ? 'Collapse' : 'Expand distribution'}>
                        {isExpanded ? '▼' : '▶'} dist
                      </button>
                    )}
                  </div>

                  {/* Distribution bars */}
                  {isExpanded && !isSingleDomain && (
                    <div className="mt-2.5 space-y-1">
                      {w.distribution.map(d => (
                        <div key={d.domain} className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-gray-400 w-[160px] truncate shrink-0" title={d.domain}>{d.domain}</span>
                          <div className="flex-1 h-2 rounded-full bg-hull-800/80 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                d.count === maxCount && w.status === 'violated' ? 'bg-gradient-to-r from-red-500/70 to-red-400/50' :
                                d.count === 0 ? 'bg-transparent' :
                                w.status === 'at-limit' ? 'bg-gradient-to-r from-amber-500/70 to-amber-400/50' :
                                'bg-gradient-to-r from-neon-cyan/60 to-neon-cyan/30'
                              }`}
                              style={{ width: `${maxCount > 0 ? Math.round(d.count * 100 / maxCount) : 0}%` }}
                            />
                          </div>
                          <span className={`text-[10px] font-mono tabular-nums w-6 text-right ${d.count === 0 ? 'text-neon-red font-bold' : d.count === maxCount && w.status === 'violated' ? 'text-neon-red' : 'text-gray-400'}`}>{d.count}</span>
                        </div>
                      ))}
                      {w.emptyDomains > 0 && (
                        <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono mt-0.5">
                          <span className="w-[160px] shrink-0">…and {w.emptyDomains} more empty {w.constraint.topologyLabel?.toLowerCase() || 'domain'}s</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
