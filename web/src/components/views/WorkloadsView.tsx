import { useState, useEffect, useCallback } from 'react'
import type { Workload } from '../../types'
import { useFetch, post } from '../../hooks/useFetch'
import { useAuth } from '../../context/AuthContext'
import { Pill, Btn, Spinner, StatusDot } from '../ui/Atoms'
import { JITRequestModal } from '../modals/JITRequestModal'

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

export function WorkloadsView({ namespace, initialKind, onWorkload }: { namespace: string; initialKind?: string; onWorkload: (ns: string, name: string, kind: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading, refetch } = useFetch<Workload[]>(`/api/workloads${q}`, 10000)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [scaleTarget, setScaleTarget] = useState<{ ns: string; name: string; current: number } | null>(null)
  const [scaleVal, setScaleVal] = useState(0)
  const [kindFilter, setKindFilter] = useState(initialKind || '')
  const [jitModal, setJitModal] = useState<{ ns: string; name: string; kind: string } | null>(null)
  const [jitGrants, setJitGrants] = useState<Set<string>>(new Set())
  const [jitPendings, setJitPendings] = useState<Set<string>>(new Set())

  const jitKey = useCallback((ns: string, kind: string, name: string) => `${ns}/${kind}/${name}`, [])

  useEffect(() => {
    if (isAdmin) return
    let cancelled = false
    const poll = () => {
      Promise.all([
        fetch('/api/jit/my-grants').then(r => r.ok ? r.json() : []),
        fetch('/api/jit/requests').then(r => r.ok ? r.json() : []),
      ]).then(([grants, requests]) => {
        if (cancelled) return
        const g = new Set<string>()
        const p = new Set<string>()
        for (const r of grants as any[]) if (r.status === 'active') g.add(jitKey(r.namespace, r.ownerKind, r.ownerName))
        for (const r of requests as any[]) if (r.status === 'pending') p.add(jitKey(r.namespace, r.ownerKind, r.ownerName))
        setJitGrants(g)
        setJitPendings(p)
      }).catch(() => {})
    }
    poll()
    const id = setInterval(poll, 15000)
    return () => { cancelled = true; clearInterval(id) }
  }, [isAdmin, jitKey])

  const restart = async (ns: string, name: string, kind: string) => {
    const key = `restart:${ns}/${name}`
    setBusy(key)
    try {
      await post(`/api/workloads/${ns}/${name}/restart?kind=${kind}`)
      setToast(`${name} restarting`)
      refetch()
    }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  const scale = async () => {
    if (!scaleTarget) return
    const key = `scale:${scaleTarget.ns}/${scaleTarget.name}`
    setBusy(key)
    try {
      await post(`/api/workloads/${scaleTarget.ns}/${scaleTarget.name}/scale?replicas=${scaleVal}`)
      setToast(`${scaleTarget.name} scaled to ${scaleVal}`)
      setScaleTarget(null)
      refetch()
    } catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const kinds = Array.from(new Set((data ?? []).map(w => w.kind))).sort()
  const filtered = kindFilter ? (data ?? []).filter(w => w.kind === kindFilter) : (data ?? [])

  return (
    <div className="space-y-2 p-4">
      {toast && <div className="rounded-md border border-hull-600 bg-hull-800 px-3 py-2 text-xs text-gray-300">{toast}</div>}

      {/* Kind filter */}
      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
        <button onClick={() => setKindFilter('')} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${!kindFilter ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All ({(data ?? []).length})</button>
        {kinds.map(k => {
          const count = (data ?? []).filter(w => w.kind === k).length
          return (
            <button key={k} onClick={() => setKindFilter(kindFilter === k ? '' : k)} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${kindFilter === k ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>{k} ({count})</button>
          )
        })}
      </div>

      {/* Scale Modal */}
      {scaleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-hull-950/80 backdrop-blur-sm" onClick={() => setScaleTarget(null)}>
          <div className="mx-4 w-full max-w-xs rounded-xl border border-hull-600 bg-hull-900 p-5" onClick={e => e.stopPropagation()}>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Scale Deployment</p>
            <p className="mt-1 truncate text-sm font-bold text-white">{scaleTarget.name}</p>
            <p className="mt-0.5 text-[10px] text-gray-600">{scaleTarget.ns}</p>
            <div className="mt-4 flex items-center justify-center gap-4">
              <button onClick={() => setScaleVal(Math.max(0, scaleVal - 1))} className="flex h-10 w-10 items-center justify-center rounded-lg border border-hull-600 bg-hull-800 text-lg font-bold text-white transition-colors hover:bg-hull-700 active:bg-hull-600">−</button>
              <span className="min-w-[3rem] text-center text-3xl font-bold tabular-nums text-neon-cyan">{scaleVal}</span>
              <button onClick={() => setScaleVal(Math.min(100, scaleVal + 1))} className="flex h-10 w-10 items-center justify-center rounded-lg border border-hull-600 bg-hull-800 text-lg font-bold text-white transition-colors hover:bg-hull-700 active:bg-hull-600">+</button>
            </div>
            <p className="mt-2 text-center text-[10px] text-gray-600">current: {scaleTarget.current}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setScaleTarget(null)} className="flex-1 rounded-lg border border-hull-600 bg-hull-800 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-hull-700">Cancel</button>
              <button onClick={scale} disabled={!!busy} className="flex-1 rounded-lg border border-blue-900/50 bg-blue-950/60 py-2 text-xs font-medium text-neon-blue transition-colors hover:bg-blue-900/40 disabled:opacity-40">
                {busy ? 'Scaling…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
      {filtered.map(w => {
        const ok = w.kind === 'CronJob' ? true : w.ready >= w.desired
        return (
          <div key={`${w.kind}-${w.namespace}-${w.name}`} className="stat-card p-3 cursor-pointer hover:ring-1 hover:ring-hull-600 transition-all" onClick={() => onWorkload(w.namespace, w.name, w.kind)}>
            <div className="flex items-center gap-2.5">
              <StatusDot ok={ok} />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{w.name}</span>
                <div className="flex items-center gap-2 mt-0.5 text-[10px]">
                  <span className="text-gray-500">{w.namespace}</span>
                  <span className="text-gray-700">·</span>
                  <span className={ok ? 'text-neon-green font-medium' : 'text-neon-amber font-medium'}>{w.kind === 'CronJob' ? `${w.ready} active` : `${w.ready}/${w.desired} ready`}</span>
                  <span className="text-gray-700">·</span>
                  <span className="text-gray-600">{w.age}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {w.pdb && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase border ${w.pdb.status === 'blocking' ? 'bg-red-950/50 text-neon-red border-red-900/40' : w.pdb.status === 'degraded' ? 'bg-amber-950/50 text-neon-amber border-amber-900/40' : 'bg-green-950/50 text-neon-green border-green-900/40'}`} title={`PDB: ${w.pdb.name} — ${w.pdb.disruptionsAllowed} disruptions allowed`}>
                    PDB {w.pdb.status === 'healthy' ? '✓' : w.pdb.status === 'blocking' ? '✗' : '!'}
                  </span>
                )}
                <Pill color={`border ${w.kind === 'Deployment' ? 'bg-blue-950/30 text-blue-400 border-blue-900/30' : w.kind === 'StatefulSet' ? 'bg-purple-950/30 text-purple-400 border-purple-900/30' : w.kind === 'Job' ? 'bg-sky-950/30 text-sky-400 border-sky-900/30' : w.kind === 'CronJob' ? 'bg-sky-950/30 text-sky-300 border-sky-900/30' : 'bg-hull-700/50 text-gray-400 border-hull-600/50'}`}>{w.kind === 'CronJob' ? 'CRON' : w.kind.slice(0, 3).toUpperCase()}</Pill>
              </div>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="truncate text-gray-600 font-mono text-[9px] flex-1">{w.images}</p>
              {w.strategy && (
                <span className="shrink-0 rounded border border-hull-600/50 bg-hull-800/40 px-1.5 py-0.5 text-[8px] font-mono text-gray-500" title={`${w.strategy.type}${w.strategy.maxSurge ? ` surge=${w.strategy.maxSurge}` : ''}${w.strategy.maxUnavailable ? ` unavail=${w.strategy.maxUnavailable}` : ''}${w.strategy.partition !== undefined ? ` partition=${w.strategy.partition}` : ''}`}>
                  {w.strategy.type === 'RollingUpdate' ? `Rolling ${w.strategy.maxSurge || ''}/${w.strategy.maxUnavailable || ''}` : w.strategy.type}
                </span>
              )}
            </div>
            {(w.cpuReqM > 0 || w.cpuUsedM > 0 || w.memReqMi > 0 || w.memUsedMi > 0) && (
              <div className="mt-1.5 grid grid-cols-2 gap-3">
                <ResourceBar used={w.cpuUsedM} req={w.cpuReqM} lim={w.cpuLimM} label="CPU" unit="m" />
                <ResourceBar used={w.memUsedMi} req={w.memReqMi} lim={w.memLimMi} label="Mem" unit="Mi" />
              </div>
            )}
            {['Deployment', 'StatefulSet', 'DaemonSet'].includes(w.kind) && (
              <div className="mt-2 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                {(isAdmin || jitGrants.has(jitKey(w.namespace, w.kind, w.name))) && (
                  <Btn small variant="primary" onClick={() => restart(w.namespace, w.name, w.kind)} disabled={busy === `restart:${w.namespace}/${w.name}`}>
                    {busy === `restart:${w.namespace}/${w.name}` ? 'Restarting…' : '↻ Restart'}
                  </Btn>
                )}
                {!isAdmin && !jitGrants.has(jitKey(w.namespace, w.kind, w.name)) && (
                  <button onClick={() => jitPendings.has(jitKey(w.namespace, w.kind, w.name)) ? null : setJitModal({ ns: w.namespace, name: w.name, kind: w.kind })} disabled={jitPendings.has(jitKey(w.namespace, w.kind, w.name))} className="rounded-md border border-amber-900/40 bg-amber-950/30 px-2.5 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/20 disabled:opacity-40">
                    {jitPendings.has(jitKey(w.namespace, w.kind, w.name)) ? '⏳ Pending…' : '↻ Request Restart'}
                  </button>
                )}
                {w.kind === 'Deployment' && isAdmin && (
                  <Btn small onClick={() => { setScaleTarget({ ns: w.namespace, name: w.name, current: w.desired }); setScaleVal(w.desired) }}>
                    ⇕ Scale
                  </Btn>
                )}
              </div>
            )}
          </div>
        )
      })}

      {jitModal && <JITRequestModal ns={jitModal.ns} pod="" ownerKind={jitModal.kind} ownerName={jitModal.name} accessType="restart" onClose={() => setJitModal(null)} onSubmitted={() => { setJitModal(null); setJitPendings(prev => new Set(prev).add(jitKey(jitModal.ns, jitModal.kind, jitModal.name))) }} />}
    </div>
  )
}
