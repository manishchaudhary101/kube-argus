import { useState } from 'react'
import type { SpotAdvisorData } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'

type CostEntry = { namespace: string; hourlyCost: number; monthlyCost: number }
type NodepoolCost = { nodepool: string; nodes: number; hourlyCost: number; monthlyCost: number }
type CostData = { namespaces: CostEntry[]; nodepools: NodepoolCost[] }

export function CostAllocationPanel() {
  const { data, err, loading } = useFetch<CostData>('/api/namespace-costs', 60000)
  const [tab, setTab] = useState<'namespace' | 'nodepool'>('namespace')
  const [nsSortKey, setNsSortKey] = useState<'monthlyCost' | 'namespace'>('monthlyCost')
  const [nsSortAsc, setNsSortAsc] = useState(false)

  if (loading) return <div className="py-4"><Spinner /></div>
  if (err) return <p className="text-neon-red text-xs">{err}</p>
  if (!data) return null

  const ns = data.namespaces || []
  const np = data.nodepools || []
  if (ns.length === 0 && np.length === 0) return null

  const nsTotalMonthly = ns.reduce((s, d) => s + d.monthlyCost, 0)
  const npTotalMonthly = np.reduce((s, d) => s + d.monthlyCost, 0)
  const totalNodes = np.reduce((s, d) => s + d.nodes, 0)

  const nsSorted = [...ns].sort((a, b) => {
    const mul = nsSortAsc ? 1 : -1
    if (nsSortKey === 'namespace') return mul * a.namespace.localeCompare(b.namespace)
    return mul * (a.monthlyCost - b.monthlyCost)
  })
  const nsTop10 = nsSorted.slice(0, 10)
  const colors = ['#06d6e0', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16']

  const toggleNsSort = (key: 'monthlyCost' | 'namespace') => {
    if (nsSortKey === key) setNsSortAsc(!nsSortAsc)
    else { setNsSortKey(key); setNsSortAsc(key === 'namespace') }
  }

  return (
    <div className="stat-card p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-teal-400 uppercase tracking-wider">Cost Allocation</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setTab('namespace')} className={`rounded px-2 py-0.5 text-[9px] font-medium border transition-colors ${tab === 'namespace' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>By Namespace</button>
          <button onClick={() => setTab('nodepool')} className={`rounded px-2 py-0.5 text-[9px] font-medium border transition-colors ${tab === 'nodepool' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>By Nodepool</button>
        </div>
      </div>

      {tab === 'namespace' && (
        <>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-xl font-extrabold text-white tabular-nums">${nsTotalMonthly.toFixed(2)}</p>
              <p className="text-[9px] text-gray-500 uppercase">Est. Monthly Total</p>
            </div>
            <div className="flex-1 h-4 rounded-full overflow-hidden bg-hull-800 flex">
              {nsTop10.map((d, i) => {
                const pct = nsTotalMonthly > 0 ? (d.monthlyCost / nsTotalMonthly) * 100 : 0
                return pct > 0.5 ? <div key={d.namespace} style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length] }} className="h-full" title={`${d.namespace}: $${d.monthlyCost.toFixed(2)}`} /> : null
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 text-left border-b border-hull-700/30">
                  <th className="pb-1.5 pr-3 font-medium cursor-pointer hover:text-gray-300" onClick={() => toggleNsSort('namespace')}>Namespace {nsSortKey === 'namespace' ? (nsSortAsc ? '↑' : '↓') : ''}</th>
                  <th className="pb-1.5 pr-3 font-medium text-right cursor-pointer hover:text-gray-300" onClick={() => toggleNsSort('monthlyCost')}>Monthly Est. {nsSortKey === 'monthlyCost' ? (nsSortAsc ? '↑' : '↓') : ''}</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Hourly</th>
                  <th className="pb-1.5 font-medium text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {nsSorted.map((d, i) => {
                  const share = nsTotalMonthly > 0 ? (d.monthlyCost / nsTotalMonthly) * 100 : 0
                  return (
                    <tr key={d.namespace} className="border-b border-hull-800/40 hover:bg-hull-800/30 transition-colors">
                      <td className="py-1.5 pr-3 text-gray-300 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: colors[i % colors.length] }} />
                        {d.namespace}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-white font-medium tabular-nums">${d.monthlyCost.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-500 tabular-nums">${d.hourlyCost.toFixed(4)}</td>
                      <td className="py-1.5 text-right text-gray-400 tabular-nums">{share.toFixed(1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'nodepool' && (
        <>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-xl font-extrabold text-white tabular-nums">${npTotalMonthly.toFixed(2)}</p>
              <p className="text-[9px] text-gray-500 uppercase">Est. Monthly ({totalNodes} nodes)</p>
            </div>
            <div className="flex-1 h-4 rounded-full overflow-hidden bg-hull-800 flex">
              {np.map((d, i) => {
                const pct = npTotalMonthly > 0 ? (d.monthlyCost / npTotalMonthly) * 100 : 0
                return pct > 0.5 ? <div key={d.nodepool} style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length] }} className="h-full" title={`${d.nodepool}: $${d.monthlyCost.toFixed(2)}`} /> : null
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 text-left border-b border-hull-700/30">
                  <th className="pb-1.5 pr-3 font-medium">Nodepool</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Nodes</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Monthly Est.</th>
                  <th className="pb-1.5 pr-3 font-medium text-right">Hourly</th>
                  <th className="pb-1.5 font-medium text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {np.map((d, i) => {
                  const share = npTotalMonthly > 0 ? (d.monthlyCost / npTotalMonthly) * 100 : 0
                  return (
                    <tr key={d.nodepool} className="border-b border-hull-800/40 hover:bg-hull-800/30 transition-colors">
                      <td className="py-1.5 pr-3 text-gray-300 font-medium">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: colors[i % colors.length] }} />
                        {d.nodepool}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">{d.nodes}</td>
                      <td className="py-1.5 pr-3 text-right text-white font-medium tabular-nums">${d.monthlyCost.toFixed(2)}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-500 tabular-nums">${d.hourlyCost.toFixed(4)}</td>
                      <td className="py-1.5 text-right text-gray-400 tabular-nums">{share.toFixed(1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export function SpotAdvisorView({ AISpotAnalysis }: { AISpotAnalysis?: React.ComponentType }) {
  const { data, err, loading } = useFetch<SpotAdvisorData>('/api/spot-advisor', 60000)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  if (!data || !data.ready) return (
    <div className="flex flex-col items-center justify-center py-16 text-center p-4">
      <span className="text-3xl mb-3 opacity-40">◎</span>
      <p className="text-gray-400 text-sm">{data?.message || 'Loading spot advisor data...'}</p>
      <p className="text-[10px] text-gray-600 mt-1">Data refreshes every 10 minutes</p>
    </div>
  )

  const irColor = (r: number) => r === 0 ? 'text-neon-green' : r === 1 ? 'text-neon-cyan' : r === 2 ? 'text-neon-amber' : 'text-neon-red'
  const irBg = (r: number) => r === 0 ? 'bg-green-950/40 border-green-900/20' : r === 1 ? 'bg-cyan-950/40 border-cyan-900/20' : r === 2 ? 'bg-amber-950/40 border-amber-900/20' : 'bg-red-950/40 border-red-900/20'
  const pctColor = (p: number) => p > 80 ? 'text-neon-red' : p > 50 ? 'text-neon-amber' : 'text-neon-cyan'
  const barGrad = (p: number) => p > 80 ? 'from-red-500 to-red-400' : p > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'

  const totalNodes = data.totalSpotNodes
  const totalVCPUs = data.recommendations.reduce((sum, r) => sum + r.current.vcpus * r.current.count, 0)
  const totalMem = data.recommendations.reduce((sum, r) => sum + r.current.memoryGiB * r.current.count, 0)
  const totalMonthlyCost = data.recommendations.reduce((sum, r) => sum + r.current.totalMonthlyCost, 0)
  const totalPotentialSaving = data.recommendations.reduce((sum, r) => {
    const best = r.alternatives.length > 0 ? r.alternatives[0] : null
    return sum + (best && best.monthlySaving > 0 ? best.monthlySaving : 0)
  }, 0)

  return (
    <div className="space-y-3 p-3">
      {/* Header */}
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="rounded bg-orange-950/60 border border-orange-900/50 px-2 py-0.5 text-orange-400 font-bold tracking-wide">◎ SPOT ADVISOR</span>
        <span className="text-gray-500">{data.region}</span>
        <span className="ml-auto text-[9px] text-gray-700">Updated {new Date(data.lastRefresh).toLocaleTimeString()}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-orange-400 tabular-nums">{totalNodes}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Spot Nodes</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-white tabular-nums">{data.recommendations.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Instance Types</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-neon-cyan tabular-nums">{totalVCPUs}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Total vCPUs</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-neon-green tabular-nums">{Math.round(totalMem)} <span className="text-xs font-normal text-gray-500">GiB</span></p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Total Memory</p>
        </div>
      </div>

      {/* Cluster cost overview */}
      {data.clusterCost && data.clusterCost.totalMonthlyCost > 0 && (() => {
        const cc = data.clusterCost!
        const spotPct = cc.totalMonthlyCost > 0 ? Math.round(cc.spotMonthlyCost * 100 / cc.totalMonthlyCost) : 0
        const odPct = 100 - spotPct
        return (
          <div className="stat-card overflow-hidden">
            <div className="p-3 border-b border-hull-700/30">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neon-cyan">Total Cluster Cost</span>
            </div>
            <div className="grid grid-cols-3 gap-0 divide-x divide-hull-700/30">
              <div className="p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Total Compute</p>
                <p className="text-2xl font-extrabold text-white tabular-nums">${cc.totalMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
                <p className="text-[9px] text-gray-600 mt-0.5 tabular-nums">{cc.totalNodes} nodes</p>
              </div>
              <div className="p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Spot</p>
                <p className="text-2xl font-extrabold text-orange-400 tabular-nums">${cc.spotMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
                <p className="text-[9px] text-gray-600 mt-0.5 tabular-nums">{cc.spotNodes} nodes · {spotPct}%</p>
              </div>
              <div className="p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">On-Demand</p>
                <p className="text-2xl font-extrabold text-sky-400 tabular-nums">${cc.onDemandMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
                <p className="text-[9px] text-gray-600 mt-0.5 tabular-nums">{cc.onDemandNodes} nodes · {odPct}%</p>
              </div>
            </div>
            {/* Spot vs On-Demand proportion bar */}
            <div className="px-3 pb-3">
              <div className="flex h-2 rounded-full overflow-hidden bg-hull-800/80 mt-1">
                {spotPct > 0 && <div className="bg-gradient-to-r from-orange-500 to-orange-400 transition-all duration-500" style={{ width: `${spotPct}%` }} />}
                {odPct > 0 && <div className="bg-gradient-to-r from-sky-500 to-sky-400 transition-all duration-500" style={{ width: `${odPct}%` }} />}
              </div>
              <div className="flex justify-between mt-1 text-[8px] font-mono">
                <span className="text-orange-400/70">Spot {spotPct}%</span>
                <span className="text-sky-400/70">On-Demand {odPct}%</span>
              </div>
            </div>
            {/* On-Demand instance type breakdown */}
            {cc.onDemandByType && cc.onDemandByType.length > 0 && (
              <div className="px-3 pb-3">
                <p className="text-[9px] text-gray-600 uppercase tracking-wider mb-1.5">On-Demand Breakdown</p>
                <div className="flex flex-wrap gap-1.5">
                  {cc.onDemandByType.map(t => (
                    <span key={t.instanceType} className="rounded bg-sky-950/30 border border-sky-900/30 px-1.5 py-0.5 text-[9px] font-mono text-sky-400/80">
                      {t.instanceType} <span className="text-gray-500">×{t.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Spot cost & potential savings */}
      {totalMonthlyCost > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="stat-card p-3 text-center">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Current Spot Cost</p>
            <p className="text-2xl font-extrabold text-white tabular-nums">${totalMonthlyCost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/mo</span></p>
          </div>
          <div className="stat-card p-3 text-center">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Potential Savings</p>
            <p className={`text-2xl font-extrabold tabular-nums ${totalPotentialSaving > 0 ? 'text-neon-green' : 'text-gray-500'}`}>{totalPotentialSaving > 0 ? `-$${totalPotentialSaving.toFixed(0)}` : '$0'}<span className="text-xs font-normal text-gray-500">/mo</span></p>
          </div>
        </div>
      )}

      {/* Consolidation Opportunities */}
      {data.consolidations && data.consolidations.length > 0 && (
        <div className="stat-card overflow-hidden">
          <div className="p-3 border-b border-hull-700/30">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest text-neon-green">⬢ Consolidation Opportunities</span>
              <span className="text-[9px] text-gray-600">fewer, larger nodes for your workload</span>
            </div>
            <p className="text-[10px] text-gray-500">
              Your {data.totalSpotNodes} spot nodes use <span className="text-gray-300 font-mono">{((data.totalEffectiveCpuM || 0) / 1000).toFixed(1)}c CPU</span> and <span className="text-gray-300 font-mono">{((data.totalEffectiveMemMi || 0) / 1024).toFixed(1)}G MEM</span> effective.
              These larger instance types can fit the same workload with fewer nodes.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead className="bg-hull-800/60 text-gray-500 text-[9px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-1.5 text-left">Instance Type</th>
                  <th className="px-2 py-1.5 text-center">Spec</th>
                  <th className="px-2 py-1.5 text-center">Interrupt</th>
                  <th className="px-2 py-1.5 text-center">Nodes</th>
                  <th className="px-2 py-1.5 text-right">$/mo</th>
                  <th className="px-3 py-1.5 text-right">Saving</th>
                </tr>
              </thead>
              <tbody>
                {data.consolidations.map((c, i) => (
                  <tr key={c.instanceType} className={`border-t border-hull-800/50 ${i === 0 ? 'bg-green-950/10' : ''}`}>
                    <td className="px-3 py-2">
                      <span className="text-neon-cyan font-medium">{c.instanceType}</span>
                      <p className="text-[8px] text-gray-500 font-normal mt-0.5">
                        replaces {c.replacesNodes} nodes ({c.replacesTypes.join(', ')})
                      </p>
                    </td>
                    <td className="px-2 py-2 text-center text-gray-300 text-[9px]">{c.vcpus}c / {c.memoryGB}G</td>
                    <td className="px-2 py-2 text-center">
                      <span className={`font-medium ${c.interruptRange === 0 ? 'text-neon-green' : c.interruptRange === 1 ? 'text-neon-cyan' : c.interruptRange <= 2 ? 'text-neon-amber' : 'text-neon-red'}`}>{c.interruptLabel}</span>
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className="text-neon-green font-bold">{c.nodesNeeded}</span>
                      <span className="text-gray-600 ml-0.5 text-[8px]">vs {c.replacesNodes}</span>
                    </td>
                    <td className="px-2 py-2 text-right text-gray-300">{c.totalMonthlyCost > 0 ? `$${c.totalMonthlyCost.toFixed(0)}` : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {c.monthlySaving > 0 ? (
                        <span className="text-neon-green font-bold">-${c.monthlySaving.toFixed(0)}</span>
                      ) : c.monthlySaving < 0 ? (
                        <span className="text-neon-red">+${Math.abs(c.monthlySaving).toFixed(0)}</span>
                      ) : <span className="text-gray-500">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-hull-700/20 bg-hull-900/30">
            <p className="text-[9px] text-gray-600">
              Fewer nodes = less scheduling overhead, faster autoscaling, and simpler cluster management.
              Trade-off: larger blast radius per node failure. Consider using multiple AZs.
            </p>
          </div>
        </div>
      )}

      {/* Per-type Recommendations */}
      {data.recommendations.map(rec => {
        const c = rec.current
        const isExpanded = expanded === c.instanceType
        const bestAlt = rec.alternatives.length > 0 ? rec.alternatives[0] : null

        return (
          <div key={c.instanceType} className="stat-card overflow-hidden">
            <div className="p-3 cursor-pointer hover:bg-hull-800/40 transition-colors" onClick={() => setExpanded(isExpanded ? null : c.instanceType)}>
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white font-mono">{c.instanceType}</span>
                    <span className="text-[11px] text-gray-500">x{c.count}</span>
                    {c.totalMonthlyCost > 0 && <span className="text-[10px] font-mono text-gray-400">${c.totalMonthlyCost.toFixed(0)}/mo</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] flex-wrap">
                    <span className="text-gray-400">{c.vcpus} vCPU</span>
                    <span className="text-gray-700">·</span>
                    <span className="text-gray-400">{c.memoryGiB} GiB</span>
                    {c.spotPrice > 0 && (
                      <>
                        <span className="text-gray-700">·</span>
                        <span className="text-gray-400 font-mono">${c.spotPrice.toFixed(4)}/hr</span>
                      </>
                    )}
                    {c.nodepools.map(np => (
                      <span key={np} className="rounded bg-purple-950/50 border border-purple-900/20 px-1 py-px text-[9px] text-purple-400">{np}</span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold tabular-nums ${irBg(c.interruptRange)} ${irColor(c.interruptRange)}`}>
                    {c.interruptLabel}
                  </span>
                  <span className="text-[9px] text-gray-600">{isExpanded ? '▾' : '▸'} {rec.alternatives.length} alternatives</span>
                </div>
              </div>

              {/* Utilization bars */}
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider">CPU load</span>
                    <span className="font-mono text-[9px] text-gray-400">{(c.effectiveCpuM / 1000).toFixed(1)}c / {(c.totalAllocCpuM / 1000).toFixed(1)}c <span className={`font-bold ${pctColor(c.avgCpuPct)}`}>{c.avgCpuPct}%</span></span>
                  </div>
                  <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                    <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(c.avgCpuPct)} transition-all duration-700`} style={{ width: `${Math.min(c.avgCpuPct, 100)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[9px] text-gray-500 uppercase tracking-wider">MEM load</span>
                    <span className="font-mono text-[9px] text-gray-400">{(c.effectiveMemMi / 1024).toFixed(1)}G / {(c.totalAllocMemMi / 1024).toFixed(1)}G <span className={`font-bold ${pctColor(c.avgMemPct)}`}>{c.avgMemPct}%</span></span>
                  </div>
                  <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                    <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(c.avgMemPct)} transition-all duration-700`} style={{ width: `${Math.min(c.avgMemPct, 100)}%` }} />
                  </div>
                </div>
              </div>

              {/* Quick recommendation banner */}
              {bestAlt && bestAlt.monthlySaving > 0 && (
                <div className="mt-2 rounded-lg bg-green-950/20 border border-green-900/20 px-2.5 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-neon-green">💡</span>
                  <span className="text-[10px] text-gray-300">
                    <span className="font-mono font-bold text-neon-cyan">{bestAlt.instanceType}</span> x{bestAlt.nodesNeeded} → save <span className="font-bold text-neon-green">${bestAlt.monthlySaving.toFixed(0)}/mo</span>
                    <span className="text-gray-500 ml-1">({bestAlt.interruptLabel} interrupt)</span>
                  </span>
                </div>
              )}
              {bestAlt && bestAlt.monthlySaving <= 0 && bestAlt.interruptRange < c.interruptRange && (
                <div className="mt-2 rounded-lg bg-cyan-950/20 border border-cyan-900/20 px-2.5 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-neon-cyan">🛡</span>
                  <span className="text-[10px] text-gray-300">
                    <span className="font-mono font-bold text-neon-cyan">{bestAlt.instanceType}</span> x{bestAlt.nodesNeeded} — lower interruption ({bestAlt.interruptLabel})
                  </span>
                </div>
              )}
              {rec.alternatives.length === 0 && (
                <div className="mt-2 rounded-lg bg-hull-800/30 border border-hull-700/20 px-2.5 py-1.5">
                  <span className="text-[10px] text-gray-500">Already optimal for this workload profile</span>
                </div>
              )}
            </div>

            {/* Expanded alternatives */}
            {isExpanded && rec.alternatives.length > 0 && (
              <div className="border-t border-hull-700/30 bg-hull-900/40">
                <div className="px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Workload-aware alternatives (considering {(c.effectiveCpuM / 1000).toFixed(1)}c CPU / {(c.effectiveMemMi / 1024).toFixed(1)}G MEM load)</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] font-mono">
                    <thead className="bg-hull-800/60 text-gray-500 text-[9px] uppercase tracking-wider">
                      <tr>
                        <th className="px-3 py-1.5 text-left">Type</th>
                        <th className="px-2 py-1.5 text-center">Spec</th>
                        <th className="px-2 py-1.5 text-center">Interrupt</th>
                        <th className="px-2 py-1.5 text-center">Nodes</th>
                        <th className="px-2 py-1.5 text-right">Total $/mo</th>
                        <th className="px-3 py-1.5 text-right">Saving</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rec.alternatives.map((alt, i) => (
                        <tr key={alt.instanceType} className={`border-t border-hull-800/50 ${i === 0 ? 'bg-green-950/10' : ''}`}>
                          <td className="px-3 py-1.5">
                            <span className="text-neon-cyan font-medium">{alt.instanceType}</span>
                            <p className="text-[8px] text-gray-600 font-normal mt-0.5">{alt.fitNote}</p>
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-300 text-[9px]">{alt.vcpus}c / {alt.memoryGB}G</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`${irColor(alt.interruptRange)} font-medium`}>{alt.interruptLabel}</span>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`font-bold ${alt.nodesNeeded <= c.count ? 'text-neon-green' : 'text-neon-amber'}`}>{alt.nodesNeeded}</span>
                            <span className="text-gray-600 ml-0.5 text-[8px]">vs {c.count}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right text-gray-300">{alt.totalMonthlyCost > 0 ? `$${alt.totalMonthlyCost.toFixed(0)}` : '—'}</td>
                          <td className="px-3 py-1.5 text-right">
                            {alt.monthlySaving > 0 ? (
                              <span className="text-neon-green font-bold">-${alt.monthlySaving.toFixed(0)}</span>
                            ) : alt.monthlySaving < 0 ? (
                              <span className="text-neon-red">+${Math.abs(alt.monthlySaving).toFixed(0)}</span>
                            ) : <span className="text-gray-500">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {isExpanded && rec.alternatives.length === 0 && (
              <div className="border-t border-hull-700/30 bg-hull-900/40 px-3 py-4 text-center">
                <p className="text-[11px] text-gray-500">No cheaper or more reliable alternatives found for this workload</p>
              </div>
            )}
          </div>
        )
      })}

      {data.recommendations.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">◎</span>
          <p className="text-gray-400 text-sm">No spot instances found</p>
          <p className="text-[10px] text-gray-600 mt-1">Nodes need <code className="text-gray-400">karpenter.sh/capacity-type=spot</code> label</p>
        </div>
      )}

      {/* Cost Allocation */}
      <CostAllocationPanel />

      {/* AI Spot Analysis */}
      {data.recommendations.length > 0 && AISpotAnalysis && <AISpotAnalysis />}
    </div>
  )
}
