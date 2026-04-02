import { useState } from 'react'
import type { Pod } from '../../types'
import { useFetch, useFullscreen } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'
import { FullscreenBtn } from '../ui/FullscreenBtn'

export function TroubledPodsView({ onPod }: { onPod: (ns: string, name: string) => void }) {
  const { data, err, loading } = useFetch<Pod[]>('/api/pods', 5000)
  const fs = useFullscreen()
  type TroubledSortCol = 'name' | 'ns' | 'status' | 'restarts' | 'age' | 'node'
  const [sortCol, setSortCol] = useState<TroubledSortCol>(() => {
    try { return (localStorage.getItem('troubled-sort-col') as TroubledSortCol) || 'status' } catch { return 'status' }
  })
  const [sortAsc, setSortAsc] = useState(() => {
    try { return localStorage.getItem('troubled-sort-asc') !== 'false' } catch { return true }
  })

  const toggle = (col: typeof sortCol) => {
    if (sortCol === col) {
      const next = !sortAsc
      setSortAsc(next)
      try { localStorage.setItem('troubled-sort-asc', String(next)) } catch {}
    } else {
      setSortCol(col); setSortAsc(true)
      try { localStorage.setItem('troubled-sort-col', col); localStorage.setItem('troubled-sort-asc', 'true') } catch {}
    }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const troubled = (data ?? []).filter(p => {
    const s = p.status
    if (s === 'Running' || s === 'Succeeded' || s === 'Completed') return false
    return true
  })

  const sorted = [...troubled].sort((a, b) => {
    let cmp = 0
    switch (sortCol) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'ns': cmp = a.namespace.localeCompare(b.namespace); break
      case 'status': cmp = a.status.localeCompare(b.status); break
      case 'restarts': cmp = a.restarts - b.restarts; break
      case 'age': cmp = a.age.localeCompare(b.age); break
      case 'node': cmp = a.node.localeCompare(b.node); break
    }
    return sortAsc ? cmp : -cmp
  })

  const f = fs.active
  const thCls = (col: typeof sortCol) =>
    `${f ? 'px-3 py-2.5' : 'px-2 py-1.5'} text-left font-medium cursor-pointer select-none whitespace-nowrap transition-colors hover:text-gray-300 ${sortCol === col ? 'text-neon-cyan' : ''}`
  const arrow = (col: typeof sortCol) => sortCol === col ? (sortAsc ? ' ▴' : ' ▾') : ''

  const statusColor = (s: string) => {
    if (s === 'Pending') return 'text-neon-amber'
    if (s === 'Terminating') return 'text-gray-500'
    if (/CrashLoop|OOMKill|Error|BackOff|ImagePull|ErrImage/i.test(s)) return 'text-neon-red animate-pulse'
    if (s === 'Failed' || s === 'Unknown') return 'text-neon-red'
    return 'text-neon-amber'
  }

  return (
    <div ref={fs.ref} className={`space-y-2 ${f ? 'bg-hull-950 h-screen overflow-auto p-5' : 'p-3'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className={`font-semibold text-white ${f ? 'text-base' : 'text-sm'}`}>Troubled Pods</h2>
          {troubled.length > 0 && <span className="rounded bg-red-950/50 border border-red-900/30 px-1.5 py-0.5 text-[10px] font-bold text-neon-red tabular-nums">{troubled.length}</span>}
          <span className={`text-gray-600 ${f ? 'text-xs' : 'text-[9px]'}`}>— Pods that are not running or healthy</span>
        </div>
        <FullscreenBtn active={f} onEnter={fs.enter} onExit={fs.exit} />
      </div>
      {troubled.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2">✓</span>
          <p className="text-neon-green font-medium text-sm">All clear</p>
          <p className="text-gray-600 text-[11px] mt-1">No troubled pods in the cluster</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-hull-700">
          <table className={`w-full font-mono ${f ? 'text-sm' : 'text-[11px]'}`}>
            <thead className={`bg-hull-800 uppercase tracking-wider sticky top-0 z-10 ${f ? 'text-gray-400 text-xs' : 'text-gray-500 text-[10px]'}`}>
              <tr>
                <th className={thCls('ns')} onClick={() => toggle('ns')}>NS{arrow('ns')}</th>
                <th className={thCls('name')} onClick={() => toggle('name')}>Name{arrow('name')}</th>
                <th className={thCls('status')} onClick={() => toggle('status')}>Status{arrow('status')}</th>
                <th className={`${f ? 'px-3 py-2.5' : 'px-2 py-1.5'} text-left font-medium`}>Ready</th>
                <th className={thCls('restarts')} onClick={() => toggle('restarts')}>Restarts{arrow('restarts')}</th>
                <th className={thCls('age')} onClick={() => toggle('age')}>Age{arrow('age')}</th>
                <th className={thCls('node')} onClick={() => toggle('node')}>Node{arrow('node')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const cp = f ? 'px-3 py-2.5' : 'px-2 py-1.5'
                return (
                  <tr key={`${p.namespace}-${p.name}`}
                    onClick={() => onPod(p.namespace, p.name)}
                    className="border-t border-hull-800 cursor-pointer transition-colors hover:bg-hull-800/60 active:bg-hull-700"
                  >
                    <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-500'} ${f ? '' : 'max-w-[90px]'} truncate`} title={p.namespace}>{p.namespace}</td>
                    <td className={`${cp} text-white ${f ? '' : 'max-w-[200px]'} truncate`} title={p.name}>{p.name}</td>
                    <td className={`${cp} font-bold ${statusColor(p.status)}`}>{p.status}</td>
                    <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-400'}`}>{p.ready}</td>
                    <td className={`${cp} tabular-nums ${p.restarts > 0 ? 'text-neon-amber font-bold' : f ? 'text-gray-400' : 'text-gray-600'}`}>{p.restarts}</td>
                    <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-500'}`}>{p.age}</td>
                    <td className={`${cp} ${f ? 'text-gray-300' : 'text-gray-400'} ${f ? '' : 'max-w-[200px]'} truncate`} title={p.node}>{p.node}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
