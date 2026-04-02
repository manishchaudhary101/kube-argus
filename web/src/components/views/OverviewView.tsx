import { useState, useEffect, useCallback, useRef } from 'react'
import type { OverviewData } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner, MiniStat } from '../ui/Atoms'
import { K9sBar, Celld } from '../ui/K9sBar'

function useFullscreen() {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const enter = useCallback(() => {
    if (ref.current?.requestFullscreen) {
      ref.current.requestFullscreen().then(() => setActive(true)).catch(() => {})
    }
  }, [])
  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().then(() => setActive(false)).catch(() => {})
    else setActive(false)
  }, [])
  useEffect(() => {
    const h = () => setActive(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])
  return { ref, active, enter, exit }
}

const FullscreenBtn = ({ active, onEnter, onExit }: { active: boolean; onEnter: () => void; onExit: () => void }) => (
  <button
    onClick={(e) => { e.stopPropagation(); active ? onExit() : onEnter() }}
    className="rounded-md p-1 text-gray-500 hover:text-neon-cyan hover:bg-hull-700/50 transition-all"
    title={active ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
  >
    {active ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
    )}
  </button>
)

export function OverviewView({ onNodeTap, onTab }: { onNodeTap: (n: string) => void; onTab: (t: string, kind?: string) => void }) {
  const { data, err, loading } = useFetch<OverviewData>('/api/overview', 5000)
  const prevRef = useRef<OverviewData | null>(null)
  const [changed, setChanged] = useState<Set<string>>(new Set())
  const podTrend = useRef<Map<string, 'up' | 'down' | null>>(new Map())
  const nodeFs = useFullscreen()
  type SortCol = 'name' | 'status' | 'nodepool' | 'type' | 'age' | 'version' | 'ip' | 'pods' | 'cpu' | 'mem'
  const [sortCol, setSortCol] = useState<SortCol>(() => {
    try { return (localStorage.getItem('ov-sort-col') as SortCol) || 'name' } catch { return 'name' }
  })
  const [sortAsc, setSortAsc] = useState(() => {
    try { return localStorage.getItem('ov-sort-asc') !== 'false' } catch { return true }
  })
  const toggleSort = (col: SortCol) => {
    if (sortCol === col) {
      const next = !sortAsc
      setSortAsc(next)
      try { localStorage.setItem('ov-sort-asc', String(next)) } catch {}
    } else {
      const asc = col === 'name'
      setSortCol(col); setSortAsc(asc)
      try { localStorage.setItem('ov-sort-col', col); localStorage.setItem('ov-sort-asc', String(asc)) } catch {}
    }
  }

  useEffect(() => {
    if (!data || !prevRef.current) { prevRef.current = data; return }
    const prev = prevRef.current
    const diffs = new Set<string>()

    const pp = prev.pods, cp = data.pods
    if (pp.total !== cp.total) diffs.add('c:pods')
    if (pp.running !== cp.running) diffs.add('c:run')
    if (pp.pending !== cp.pending) diffs.add('c:pend')
    if (pp.failed !== cp.failed) diffs.add('c:fail')
    if (prev.nodesReady !== data.nodesReady || prev.nodesTotal !== data.nodesTotal) diffs.add('c:nodes')
    if (prev.deployments.ready !== data.deployments.ready || prev.deployments.total !== data.deployments.total) diffs.add('c:deploy')
    if (prev.namespaces !== data.namespaces) diffs.add('c:ns')

    const prevMap = new Map(prev.nodes.map(n => [n.name, n]))
    const newTrends = new Map(podTrend.current)
    for (const n of data.nodes) {
      const o = prevMap.get(n.name)
      if (!o) { diffs.add(`n:${n.name}:row`); continue }
      if (o.status !== n.status) diffs.add(`n:${n.name}:status`)
      if (o.pods !== n.pods) {
        diffs.add(`n:${n.name}:pods`)
        newTrends.set(n.name, n.pods > o.pods ? 'up' : 'down')
      }
      if (o.cpuPercent !== n.cpuPercent) { diffs.add(`n:${n.name}:cpu`); diffs.add(`n:${n.name}:cpuPct`) }
      if (o.memPercent !== n.memPercent) { diffs.add(`n:${n.name}:mem`); diffs.add(`n:${n.name}:memPct`) }
      if (o.cordoned !== n.cordoned) diffs.add(`n:${n.name}:status`)
    }
    podTrend.current = newTrends

    prevRef.current = data
    if (diffs.size > 0) {
      setChanged(diffs)
      setTimeout(() => { setChanged(new Set()); podTrend.current = new Map() }, 3000)
    }
  }, [data])

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  if (!data) return null
  const p = data.pods

  const statusColor = (s: string) => {
    if (s.includes('SchedulingDisabled')) return 'text-neon-amber'
    if (s === 'Ready') return 'text-neon-green'
    return 'text-neon-red'
  }


  const sortedNodes = [...data.nodes].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'status': cmp = a.status.localeCompare(b.status); break
      case 'nodepool': cmp = a.nodepool.localeCompare(b.nodepool); break
      case 'type': cmp = (a.instanceType || '').localeCompare(b.instanceType || ''); break
      case 'age': cmp = a.ageSec - b.ageSec; break
      case 'version': cmp = a.version.localeCompare(b.version); break
      case 'ip': cmp = a.internalIP.localeCompare(b.internalIP); break
      case 'pods': cmp = a.pods - b.pods; break
      case 'cpu': cmp = a.cpuPercent - b.cpuPercent; break
      case 'mem': cmp = a.memPercent - b.memPercent; break
    }
    return sortAsc ? cmp : -cmp
  })

  const fsA = nodeFs.active
  const thCls = (col: SortCol, extra = '') =>
    `${fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'} font-medium cursor-pointer select-none transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''} ${extra}`
  const arrow = (col: SortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''

  const totalCpu = data.nodes.reduce((s, n) => s + n.allocCpuM, 0)
  const usedCpu = data.nodes.reduce((s, n) => s + n.usedCpuM, 0)
  const totalMem = data.nodes.reduce((s, n) => s + n.allocMemMi, 0)
  const usedMem = data.nodes.reduce((s, n) => s + n.usedMemMi, 0)
  const clusterCpuPct = totalCpu > 0 ? Math.round(usedCpu * 100 / totalCpu) : 0
  const clusterMemPct = totalMem > 0 ? Math.round(usedMem * 100 / totalMem) : 0

  const c = data.counts || { services: 0, ingresses: 0, statefulsets: 0, daemonsets: 0, jobs: 0, cronjobs: 0 }
  const cl = data.cluster
  const clCpuPct = cl && cl.cpuAllocatableM > 0 ? Math.round(cl.cpuUsedM * 100 / cl.cpuAllocatableM) : clusterCpuPct
  const clMemPct = cl && cl.memAllocatableMi > 0 ? Math.round(cl.memUsedMi * 100 / cl.memAllocatableMi) : clusterMemPct
  const topNS = data.topNamespaces || []
  const maxNSPods = topNS.length > 0 ? topNS[0].pods : 1
  const warns = data.warnings || []

  return (
    <div className="space-y-3 p-3">
      {/* Row 1: Core stats */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <MiniStat icon="⬢" label="Nodes" value={`${data.nodesReady}/${data.nodesTotal}`} color={data.nodesReady === data.nodesTotal ? 'text-neon-green' : 'text-neon-amber'} onClick={() => onTab('nodes')} />
        <MiniStat icon="◉" label="Pods" value={p.total} color="text-neon-cyan" sub={`${p.running} run`} onClick={() => onTab('pods')} />
        <MiniStat icon="⚡" label="Pending" value={p.pending} color={p.pending > 0 ? 'text-neon-amber' : 'text-gray-500'} onClick={() => onTab('troubled')} />
        <MiniStat icon="✗" label="Failed" value={p.failed} color={p.failed > 0 ? 'text-neon-red' : 'text-gray-500'} onClick={() => onTab('troubled')} />
        <MiniStat icon="▣" label="Deploys" value={`${data.deployments.ready}/${data.deployments.total}`} color={data.deployments.ready === data.deployments.total ? 'text-neon-green' : 'text-neon-amber'} onClick={() => onTab('workloads', 'Deployment')} />
        <MiniStat icon="⟳" label="CronJobs" value={c.cronjobs} color="text-sky-300" onClick={() => onTab('workloads', 'CronJob')} />
      </div>

      {/* Cluster resource cards */}
      {(() => {
        const cpuUsed = cl ? cl.cpuUsedM : usedCpu
        const cpuTotal = cl ? cl.cpuAllocatableM : totalCpu
        const memUsedVal = cl ? cl.memUsedMi : usedMem
        const memTotal = cl ? cl.memAllocatableMi : totalMem
        const cpuFree = Math.max(0, cpuTotal - cpuUsed)
        const memFree = Math.max(0, memTotal - memUsedVal)
        const pctColor = (p: number) => p > 80 ? 'text-neon-red' : p > 50 ? 'text-neon-amber' : 'text-neon-cyan'
        const barGrad = (p: number) => p > 80 ? 'from-red-500 to-red-400' : p > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'
        const barGlow = (p: number) => p > 80 ? 'shadow-[0_0_12px_rgba(255,51,85,0.25)]' : p > 50 ? 'shadow-[0_0_12px_rgba(255,184,0,0.2)]' : 'shadow-[0_0_12px_rgba(6,214,224,0.2)]'
        return (
          <div className="grid grid-cols-2 gap-2">
            <div className="stat-card p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">CPU</span>
              </div>
              <div className="flex items-end gap-1 mb-2">
                <span className={`text-3xl font-extrabold tabular-nums leading-none ${pctColor(clCpuPct)}`}>{clCpuPct}</span>
                <span className="text-sm text-gray-600 font-medium mb-0.5">%</span>
              </div>
              <div className="h-2 rounded-full bg-hull-800/80 overflow-hidden mb-2">
                <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(clCpuPct)} ${barGlow(clCpuPct)} transition-all duration-700 ease-out`} style={{ width: `${Math.min(clCpuPct, 100)}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-x-2 text-[10px] font-mono">
                <div><span className="text-gray-600">Used </span><span className="text-gray-300">{(cpuUsed / 1000).toFixed(1)}c</span></div>
                <div><span className="text-gray-600">Free </span><span className="text-gray-300">{(cpuFree / 1000).toFixed(1)}c</span></div>
                <div className="col-span-2 mt-0.5"><span className="text-gray-600">Total </span><span className="text-gray-400">{(cpuTotal / 1000).toFixed(1)} cores</span></div>
              </div>
            </div>
            <div className="stat-card p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Memory</span>
              </div>
              <div className="flex items-end gap-1 mb-2">
                <span className={`text-3xl font-extrabold tabular-nums leading-none ${pctColor(clMemPct)}`}>{clMemPct}</span>
                <span className="text-sm text-gray-600 font-medium mb-0.5">%</span>
              </div>
              <div className="h-2 rounded-full bg-hull-800/80 overflow-hidden mb-2">
                <div className={`h-full rounded-full bg-gradient-to-r ${barGrad(clMemPct)} ${barGlow(clMemPct)} transition-all duration-700 ease-out`} style={{ width: `${Math.min(clMemPct, 100)}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-x-2 text-[10px] font-mono">
                <div><span className="text-gray-600">Used </span><span className="text-gray-300">{(memUsedVal / 1024).toFixed(1)}G</span></div>
                <div><span className="text-gray-600">Free </span><span className="text-gray-300">{(memFree / 1024).toFixed(1)}G</span></div>
                <div className="col-span-2 mt-0.5"><span className="text-gray-600">Total </span><span className="text-gray-400">{(memTotal / 1024).toFixed(1)} GiB</span></div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Top namespaces by pod count */}
      {topNS.length > 0 && (
        <div className="stat-card p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Top Namespaces by Pods</p>
          <div className="space-y-1.5">
            {topNS.map(n => (
              <div key={n.ns} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-gray-400 w-[110px] truncate shrink-0">{n.ns}</span>
                <div className="flex-1 h-2 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-neon-cyan/60 to-neon-cyan/30 transition-all duration-500" style={{ width: `${Math.round(n.pods * 100 / maxNSPods)}%` }} />
                </div>
                <span className="text-[10px] font-mono tabular-nums text-gray-500 w-8 text-right">{n.pods}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* k9s-style node table */}
      <div ref={nodeFs.ref} className={`rounded-xl border border-hull-700/60 bg-hull-900/80 overflow-hidden ${fsA ? 'bg-hull-950 !rounded-none !border-0 h-screen flex flex-col' : ''}`}>
        <div className={`border-b border-hull-700/60 bg-hull-800/50 flex items-center justify-between shrink-0 ${fsA ? 'px-4 py-3' : 'px-3 py-2'}`}>
          <span className={`font-mono font-bold uppercase tracking-wider text-neon-cyan ${fsA ? 'text-xs' : 'text-[10px]'}`}>Nodes</span>
          <div className="flex items-center gap-2">
            <span className={`text-gray-600 ${fsA ? 'text-xs' : 'text-[9px]'}`}>{data.nodesTotal} total</span>
            <FullscreenBtn active={fsA} onEnter={nodeFs.enter} onExit={nodeFs.exit} />
          </div>
        </div>
        <div className={`overflow-x-auto ${fsA ? 'flex-1 overflow-y-auto' : ''}`}>
          <table className={`w-full min-w-[800px] font-mono ${fsA ? 'text-sm' : 'text-[11px]'}`}>
            <thead className={fsA ? 'sticky top-0 z-10 bg-hull-900' : ''}>
              <tr className={`border-b border-hull-700 text-left uppercase tracking-wider ${fsA ? 'text-xs text-gray-400' : 'text-[10px] text-gray-500'}`}>
                <th className={thCls('name')} onClick={() => toggleSort('name')}>Name{arrow('name')}</th>
                <th className={thCls('status')} onClick={() => toggleSort('status')}>Status{arrow('status')}</th>
                <th className={thCls('nodepool')} onClick={() => toggleSort('nodepool')}>Pool{arrow('nodepool')}</th>
                <th className={thCls('type')} onClick={() => toggleSort('type')}>Type{arrow('type')}</th>
                <th className={thCls('age')} onClick={() => toggleSort('age')}>Age{arrow('age')}</th>
                <th className={thCls('version')} onClick={() => toggleSort('version')}>Ver{arrow('version')}</th>
                <th className={thCls('ip')} onClick={() => toggleSort('ip')}>IP{arrow('ip')}</th>
                <th className={thCls('pods')} onClick={() => toggleSort('pods')}>Pods{arrow('pods')}</th>
                <th className={`${fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'} font-medium`}>CPU</th>
                <th className={thCls('cpu', 'text-right')} onClick={() => toggleSort('cpu')}>%{arrow('cpu')}</th>
                <th className={`${fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'} font-medium`}>MEM</th>
                <th className={thCls('mem', 'text-right')} onClick={() => toggleSort('mem')}>%{arrow('mem')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map(n => {
                const trend = podTrend.current.get(n.name)
                const cp = fsA ? 'px-3 py-2.5' : 'px-2 py-1.5'
                return (
                <tr key={n.name} onClick={() => onNodeTap(n.name)} className={`cursor-pointer border-b border-hull-800 transition-colors hover:bg-hull-800 active:bg-hull-700 last:border-0 ${changed.has(`n:${n.name}:row`) ? 'k9s-changed' : ''}`}>
                  <td className={`whitespace-nowrap ${cp} text-white`}>
                    <span className="flex items-center gap-1.5">
                      {n.name}
                      {n.cordoned && <span className={`inline-flex items-center rounded px-1 py-0.5 font-bold uppercase tracking-wider bg-amber-950/60 border border-amber-800/50 text-neon-amber leading-none animate-pulse ${fsA ? 'text-[10px]' : 'text-[8px]'}`}>drain</span>}
                    </span>
                  </td>
                  <Celld k={`n:${n.name}:status`} changed={changed} className={`whitespace-nowrap ${cp} ${statusColor(n.status)}`}>{n.status}</Celld>
                  <td className={`whitespace-nowrap ${cp} text-purple-400 font-medium`}>{n.nodepool || '—'}</td>
                  {n.instanceType ? <td className={`whitespace-nowrap ${cp} text-sky-400/80`}>{n.instanceType}</td> : <td className={`whitespace-nowrap ${cp} text-gray-700`}>—</td>}
                  <td className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-500'}`}>{n.age}</td>
                  <td className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-500'}`}>{n.version}</td>
                  <td className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-500'}`}>{n.internalIP}</td>
                  <Celld k={`n:${n.name}:pods`} changed={changed} className={`whitespace-nowrap ${cp} ${fsA ? 'text-gray-300' : 'text-gray-400'}`}>
                    <span className="inline-flex items-center gap-1">
                      {n.pods}
                      {trend === 'up' && <span className={`text-neon-green animate-pulse ${fsA ? 'text-xs' : 'text-[10px]'}`}>▲</span>}
                      {trend === 'down' && <span className={`text-neon-red animate-pulse ${fsA ? 'text-xs' : 'text-[10px]'}`}>▼</span>}
                    </span>
                  </Celld>
                  <Celld k={`n:${n.name}:cpu`} changed={changed} className={`whitespace-nowrap ${cp}`}><K9sBar pct={n.cpuPercent} large={fsA} /></Celld>
                  <Celld k={`n:${n.name}:cpuPct`} changed={changed} className={`whitespace-nowrap ${cp} text-right tabular-nums ${n.cpuPercent > 80 ? 'text-neon-red' : n.cpuPercent > 50 ? 'text-neon-amber' : fsA ? 'text-gray-300' : 'text-gray-400'}`}>{n.cpuPercent}%</Celld>
                  <Celld k={`n:${n.name}:mem`} changed={changed} className={`whitespace-nowrap ${cp}`}><K9sBar pct={n.memPercent} large={fsA} /></Celld>
                  <Celld k={`n:${n.name}:memPct`} changed={changed} className={`whitespace-nowrap ${cp} text-right tabular-nums ${n.memPercent > 80 ? 'text-neon-red' : n.memPercent > 50 ? 'text-neon-amber' : fsA ? 'text-gray-300' : 'text-gray-400'}`}>{n.memPercent}%</Celld>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent warnings */}
      {warns.length > 0 && (
        <div className="rounded-xl border border-amber-900/30 bg-hull-900/80 overflow-hidden">
          <div className="border-b border-amber-900/30 bg-amber-950/20 px-3 py-2 flex items-center justify-between">
            <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-amber">⚠ Warnings</span>
            <span className="text-[9px] text-gray-600">last 30m · {warns.length}</span>
          </div>
          <div className="max-h-44 overflow-auto">
            {warns.map((e, i) => (
              <div key={i} className="flex gap-2 px-3 py-1.5 border-b border-hull-800/40 last:border-0 text-[11px]">
                <span className="text-gray-600 shrink-0 font-mono">{e.age}</span>
                <span className="text-neon-amber shrink-0 font-mono">{e.reason}</span>
                <span className="text-gray-500 truncate">{e.object} — {e.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
