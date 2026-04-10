import { useState } from 'react'
import type { Pod } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner, StatusDot, SizingBadge } from '../ui/Atoms'

export type SparklineData = Record<string, { cpu: number[][]; mem: number[][] }>

export function ResourceBar({ used, req, lim, label, unit }: { used: number; req: number; lim: number; label: string; unit: string }) {
  const cap = lim || req || used || 1
  const usedPct = Math.min((used / cap) * 100, 100)
  const reqPct = req ? Math.min((req / cap) * 100, 100) : 0
  const overLim = lim > 0 && used >= lim
  const barColor = overLim ? 'bg-neon-red' : 'bg-neon-cyan'
  return (
    <div className="min-w-[80px]">
      <div className="flex justify-between text-[9px]">
        <span className="text-gray-500">{label}</span>
        <span className={`tabular-nums ${overLim ? 'text-neon-red' : 'text-gray-400'}`}>{used}{unit}</span>
      </div>
      <div className="relative mt-0.5 h-1.5 w-full rounded-full bg-hull-700">
        {reqPct > 0 && <div className="absolute top-0 h-full rounded-full bg-hull-600 opacity-40" style={{ width: `${reqPct}%` }} />}
        <div className={`absolute top-0 h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${usedPct}%` }} />
      </div>
      <div className="flex justify-between text-[8px] text-gray-600 mt-px">
        {req > 0 ? <span>req:{req}{unit}</span> : <span />}
        {lim > 0 ? <span>lim:{lim}{unit}</span> : <span />}
      </div>
    </div>
  )
}

function fmtMetric(v: number, unit: string) {
  if (unit === 'Mi') return v >= 1024 ? `${(v / 1024).toFixed(1)}Gi` : `${v}Mi`
  return `${v}${unit}`
}

function MiniSparkline({ points, color, used, limit, unit }: { points: number[]; color: string; used: number; limit: number; unit: string }) {
  const W = 36, H = 18
  const hasGraph = points && points.length >= 2
  const mx = hasGraph ? Math.max(...points, 1) : 1
  const mn = hasGraph ? Math.min(...points, 0) : 0
  const rng = mx - mn || 1
  const coords = hasGraph ? points.map((v, i) => [
    1 + (i / (points.length - 1)) * (W - 2),
    1 + (H - 2) - ((v - mn) / rng) * (H - 2)
  ]) : []
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const areaPath = linePath + (coords.length ? ` L${coords[coords.length - 1][0].toFixed(1)},${H} L${coords[0][0].toFixed(1)},${H} Z` : '')
  const tooltip = limit > 0 ? `${fmtMetric(used, unit)} / ${fmtMetric(limit, unit)}` : fmtMetric(used, unit)
  const label = limit > 0 ? `${fmtMetric(used, unit)}/${fmtMetric(limit, unit)}` : used > 0 ? fmtMetric(used, unit) : '—'
  const gradId = `sg-${color.replace('#', '')}`
  return (
    <div className="flex items-center gap-1 overflow-hidden" title={tooltip}>
      {hasGraph && (
        <svg width={W} height={H} className="shrink-0">
          <defs><linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.35" /><stop offset="100%" stopColor={color} stopOpacity="0.05" /></linearGradient></defs>
          <path d={areaPath} fill={`url(#${gradId})`} />
          <path d={linePath} fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="text-[9px] text-gray-400 tabular-nums truncate">{label}</span>
    </div>
  )
}

const RENDER_LIMIT = 200

export function PodsView({ namespace, onPod }: { namespace: string; onPod: (ns: string, name: string) => void }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<Pod[]>(`/api/pods${q}`, 8000)
  const { data: sparkData } = useFetch<SparklineData>(`/api/pod-sparklines${q}`, 8000)
  const [view, setView] = useState<'cards' | 'table'>(() => {
    try { return (localStorage.getItem('pods-view') as 'cards' | 'table') || 'table' } catch { return 'table' }
  })
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  type PodSortCol = 'name' | 'ns' | 'status' | 'restarts' | 'age' | 'cpu' | 'mem'
  const [sortCol, setSortCol] = useState<PodSortCol>('name')
  const [sortAsc, setSortAsc] = useState(true)

  const toggleView = (v: 'cards' | 'table') => { setView(v); try { localStorage.setItem('pods-view', v) } catch {} }
  const toggleSort = (col: PodSortCol) => {
    if (sortCol === col) setSortAsc(p => !p)
    else { setSortCol(col); setSortAsc(true) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const all = data ?? []
  const owners = [...new Set(all.filter(p => p.ownerName).map(p => `${p.ownerKind}/${p.ownerName}`))].sort()
  const statuses = [...new Set(all.map(p => p.status))].sort()

  const filtered = all.filter(p => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.namespace.toLowerCase().includes(search.toLowerCase())) return false
    if (statusFilter && p.status !== statusFilter) return false
    if (ownerFilter && `${p.ownerKind}/${p.ownerName}` !== ownerFilter) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'ns': cmp = a.namespace.localeCompare(b.namespace); break
      case 'status': cmp = a.status.localeCompare(b.status); break
      case 'restarts': cmp = a.restarts - b.restarts; break
      case 'age': cmp = a.age.localeCompare(b.age); break
      case 'cpu': cmp = a.cpuUsedM - b.cpuUsedM; break
      case 'mem': cmp = a.memUsedMi - b.memUsedMi; break
    }
    return sortAsc ? cmp : -cmp
  })

  const running = all.filter(p => p.status === 'Running').length
  const pending = all.filter(p => p.status === 'Pending' || p.status === 'ContainerCreating').length
  const failed = all.filter(p => p.status !== 'Running' && p.status !== 'Pending' && p.status !== 'Succeeded' && p.status !== 'Completed' && p.status !== 'ContainerCreating').length
  const totalCpu = all.reduce((s, p) => s + p.cpuUsedM, 0)
  const totalMem = all.reduce((s, p) => s + p.memUsedMi, 0)
  const totalRestarts = all.reduce((s, p) => s + p.restarts, 0)

  const statusColor = (s: string) => s === 'Running' ? 'text-neon-green' : s === 'Succeeded' || s === 'Completed' ? 'text-gray-500' : s === 'Pending' || s === 'ContainerCreating' ? 'text-neon-amber' : 'text-neon-red'
  const arrow = (col: PodSortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''
  const thCls = (col: PodSortCol) => `px-2 py-2 text-left font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''}`

  const cpuSpark = (p: Pod) => sparkData?.[`${p.namespace}/${p.name}`]?.cpu?.map(pt => pt[1]) ?? []
  const memSpark = (p: Pod) => sparkData?.[`${p.namespace}/${p.name}`]?.mem?.map(pt => pt[1]) ?? []

  return (
    <div className="space-y-2 p-3">
      {/* Summary strip */}
      <div className="flex flex-wrap gap-2 text-[10px]">
        <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="text-gray-500">Total</span><span className="text-white font-bold tabular-nums">{all.length}</span></div>
        <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-neon-green" /><span className="text-gray-500">Running</span><span className="text-neon-green font-bold tabular-nums">{running}</span></div>
        {pending > 0 && <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-neon-amber" /><span className="text-gray-500">Pending</span><span className="text-neon-amber font-bold tabular-nums">{pending}</span></div>}
        {failed > 0 && <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-neon-red" /><span className="text-gray-500">Failed</span><span className="text-neon-red font-bold tabular-nums">{failed}</span></div>}
        {totalRestarts > 0 && <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="text-gray-500">Restarts</span><span className="text-neon-amber font-bold tabular-nums">{totalRestarts}</span></div>}
        <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="text-gray-500">CPU</span><span className="text-neon-cyan font-bold tabular-nums">{totalCpu > 1000 ? `${(totalCpu / 1000).toFixed(1)} cores` : `${totalCpu}m`}</span></div>
        <div className="stat-card px-3 py-1.5 flex items-center gap-1.5"><span className="text-gray-500">MEM</span><span className="text-neon-cyan font-bold tabular-nums">{totalMem > 1024 ? `${(totalMem / 1024).toFixed(1)} Gi` : `${totalMem} Mi`}</span></div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pods…"
          className="rounded-lg border border-hull-600/50 bg-hull-800/60 px-2.5 py-1.5 text-[11px] text-gray-300 outline-none placeholder:text-gray-600 w-48 focus:border-neon-cyan/40 transition-colors" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="rounded-lg border border-hull-600/50 bg-hull-800/60 px-2 py-1.5 text-[10px] text-gray-300 outline-none">
          <option value="">All Status</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}
          className="rounded-lg border border-hull-600/50 bg-hull-800/60 px-2 py-1.5 text-[10px] text-gray-300 outline-none max-w-[220px]">
          <option value="">All Owners</option>
          {owners.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <span className="text-[10px] text-gray-600 tabular-nums ml-auto">{sorted.length} pod{sorted.length !== 1 ? 's' : ''}</span>
        <div className="flex rounded-lg border border-hull-600/50 overflow-hidden">
          <button type="button" onClick={() => toggleView('cards')} className={`px-2 py-1 text-[10px] transition-colors ${view === 'cards' ? 'bg-hull-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>◫ Cards</button>
          <button type="button" onClick={() => toggleView('table')} className={`px-2 py-1 text-[10px] transition-colors ${view === 'table' ? 'bg-hull-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>☰ Table</button>
        </div>
      </div>

      {/* Table view */}
      {view === 'table' && (() => {
        const hasNs = !namespace
        return (
        <div className="rounded-lg border border-hull-700 overflow-hidden">
          <table className="w-full font-mono text-[11px] table-fixed">
            <colgroup>
              <col style={{width:'24px'}} />
              <col style={{width: hasNs ? '22%' : '30%'}} />
              {hasNs && <col style={{width:'11%'}} />}
              <col style={{width:'7%'}} />
              <col style={{width:'4.5%'}} />
              <col style={{width:'5.5%'}} />
              <col style={{width:'4%'}} />
              <col style={{width:'9%'}} />
              <col style={{width: hasNs ? '14%' : '16%'}} />
              <col style={{width:'10%'}} />
              <col style={{width:'10%'}} />
            </colgroup>
            <thead className="bg-hull-800 uppercase tracking-wider sticky top-0 z-10 text-gray-500 text-[10px]">
              <tr>
                <th className="pl-2 py-2"></th>
                <th className={`${thCls('name')}`} onClick={() => toggleSort('name')}>Name{arrow('name')}</th>
                {hasNs && <th className={`${thCls('ns')}`} onClick={() => toggleSort('ns')}>NS{arrow('ns')}</th>}
                <th className={`${thCls('status')}`} onClick={() => toggleSort('status')}>Status{arrow('status')}</th>
                <th className="px-2 py-2 text-left font-medium">Ready</th>
                <th className={`${thCls('restarts')}`} onClick={() => toggleSort('restarts')}>Restarts{arrow('restarts')}</th>
                <th className={`${thCls('age')}`} onClick={() => toggleSort('age')}>Age{arrow('age')}</th>
                <th className="px-2 py-2 text-left font-medium">Pod IP</th>
                <th className="px-2 py-2 text-left font-medium">Owner</th>
                <th className={`${thCls('cpu')}`} onClick={() => toggleSort('cpu')}>CPU{arrow('cpu')}</th>
                <th className={`${thCls('mem')}`} onClick={() => toggleSort('mem')}>Memory{arrow('mem')}</th>
              </tr>
            </thead>
            <tbody>
              {(showAll ? sorted : sorted.slice(0, RENDER_LIMIT)).map(p => (
                <tr key={`${p.namespace}-${p.name}`} onClick={() => onPod(p.namespace, p.name)}
                  className="border-t border-hull-800 cursor-pointer transition-colors hover:bg-hull-800/60 active:bg-hull-700">
                  <td className="pl-2 py-2"><span className={`inline-block h-2 w-2 rounded-full ${p.status === 'Running' ? 'bg-neon-green' : p.status === 'Pending' || p.status === 'ContainerCreating' ? 'bg-neon-amber' : p.status === 'Succeeded' || p.status === 'Completed' ? 'bg-gray-600' : 'bg-neon-red'}`} /></td>
                  <td className="px-2 py-2 text-white truncate overflow-hidden" title={p.name}>{p.name}</td>
                  {hasNs && <td className="px-2 py-2 text-gray-500 truncate overflow-hidden" title={p.namespace}>{p.namespace}</td>}
                  <td className={`px-2 py-2 font-medium truncate overflow-hidden ${statusColor(p.status)}`}>{p.status}</td>
                  <td className="px-2 py-2 text-gray-400">{p.ready}</td>
                  <td className={`px-2 py-2 tabular-nums ${p.restarts > 0 ? 'text-neon-amber font-bold' : 'text-gray-600'}`}>{p.restarts}</td>
                  <td className="px-2 py-2 text-gray-500">{p.age}</td>
                  <td className="px-2 py-2 text-gray-600 font-mono truncate overflow-hidden">{p.podIP || '—'}</td>
                  <td className="px-2 py-2 text-neon-cyan truncate overflow-hidden" title={p.ownerName ? `${p.ownerKind}/${p.ownerName}` : ''}>{p.ownerName ? `${p.ownerKind?.toLowerCase().slice(0,6)}/${p.ownerName}` : '—'}</td>
                  <td className="px-2 py-2 overflow-hidden"><MiniSparkline points={cpuSpark(p)} color="#22d3ee" used={p.cpuUsedM} limit={p.cpuLimM} unit="m" /></td>
                  <td className="px-2 py-2 overflow-hidden"><MiniSparkline points={memSpark(p)} color="#a78bfa" used={p.memUsedMi} limit={p.memLimMi} unit="Mi" /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!showAll && sorted.length > RENDER_LIMIT && (
            <button onClick={() => setShowAll(true)} className="w-full py-2 text-[10px] text-neon-cyan hover:bg-hull-800/40 transition-colors">
              Show all {sorted.length} pods ({sorted.length - RENDER_LIMIT} hidden)
            </button>
          )}
        </div>
        )
      })()}

      {/* Cards view */}
      {view === 'cards' && (
        <div className="space-y-2">
          {(showAll ? sorted : sorted.slice(0, RENDER_LIMIT)).map((p, i) => (
            <button key={`${p.namespace}-${p.name}`} onClick={() => onPod(p.namespace, p.name)} className="w-full stat-card px-3 py-2.5 text-left anim-in" style={{ animationDelay: `${i * 25}ms` }}>
              <div className="flex items-center gap-2.5">
                <StatusDot ok={p.status === 'Running'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{p.name}</p>
                  <p className="text-[10px] text-gray-600">{p.namespace} · {p.node}{p.ownerName ? ` · ${p.ownerKind?.toLowerCase()}/${p.ownerName}` : ''}</p>
                  {p.labels && Object.keys(p.labels).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {Object.entries(p.labels).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="rounded bg-hull-700/60 border border-hull-600/40 px-1.5 py-0 text-[8px] font-mono text-gray-400 truncate max-w-[140px]">{k.replace('app.kubernetes.io/', '')}={v}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right text-[10px]">
                  <span className={`font-medium ${statusColor(p.status)}`}>{p.status}</span>
                  <p className="text-gray-600">{p.ready} · {p.age}</p>
                  {p.restarts > 0 && <p className="text-neon-amber font-medium">{p.restarts}x restart</p>}
                </div>
                <span className="text-gray-700 text-sm">›</span>
              </div>
              {p.containerStates && p.containerStates.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.containerStates.map(cs => (
                    <span key={cs.name} className="inline-flex items-center gap-1 text-[9px] font-mono" title={cs.reason || cs.state}>
                      <span className={`h-1.5 w-1.5 rounded-full ${cs.state === 'running' ? 'bg-neon-green' : cs.state === 'waiting' ? 'bg-neon-amber' : 'bg-neon-red'}`} />
                      <span className="text-gray-500">{cs.name}</span>
                      {cs.state !== 'running' && <span className={cs.state === 'waiting' ? 'text-neon-amber' : 'text-neon-red'}>{cs.reason || cs.state}</span>}
                    </span>
                  ))}
                </div>
              )}
              {(p.cpuUsedM > 0 || p.memUsedMi > 0 || p.cpuReqM > 0 || p.memReqMi > 0) && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <ResourceBar used={p.cpuUsedM} req={p.cpuReqM} lim={p.cpuLimM} label="CPU" unit="m" />
                  <ResourceBar used={p.memUsedMi} req={p.memReqMi} lim={p.memLimMi} label="MEM" unit="Mi" />
                </div>
              )}
              {(p.cpuSizing !== 'unknown' || p.memSizing !== 'unknown') && (
                <div className="mt-1.5 flex gap-1.5">
                  {p.cpuSizing !== 'unknown' && <SizingBadge resource="CPU" sizing={p.cpuSizing} />}
                  {p.memSizing !== 'unknown' && <SizingBadge resource="MEM" sizing={p.memSizing} />}
                </div>
              )}
            </button>
          ))}
          {!showAll && sorted.length > RENDER_LIMIT && (
            <button onClick={() => setShowAll(true)} className="w-full stat-card py-2 text-[10px] text-neon-cyan hover:bg-hull-800/40 transition-colors text-center">
              Show all {sorted.length} pods ({sorted.length - RENDER_LIMIT} hidden)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
