import { useState, useEffect, useCallback, useRef } from 'react'
import type { NodeDetail } from '../../types'
import { useFetch, post } from '../../hooks/useFetch'
import { useAuth } from '../../context/AuthContext'
import { Pill, Btn, Spinner, StatusDot } from '../ui/Atoms'

type DrainPodEntry = { name: string; namespace: string; owner: string; ownerKind: string; category: string; warning?: string; pdbName?: string; pdbAllow?: number }
type DrainPreview = { pods: DrainPodEntry[]; summary: Record<string, number> }

type BgDrain = { node: string; evicted: number; failed: number; total: number; done: boolean }

function useDrainBg() {
  const [bg, setBg] = useState<BgDrain | null>(null)
  const start = useCallback((nodeName: string, totalPods: number) => {
    setBg({ node: nodeName, evicted: 0, failed: 0, total: totalPods, done: false })
    const es = new EventSource(`/api/nodes/${nodeName}/drain?stream=true`)
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.done) {
          setBg(prev => prev ? { ...prev, evicted: d.evicted, failed: d.failed, done: true } : null)
          es.close()
          setTimeout(() => setBg(null), 8000)
        } else if (d.status === 'evicted') {
          setBg(prev => prev ? { ...prev, evicted: prev.evicted + 1 } : null)
        } else if (d.status === 'failed') {
          setBg(prev => prev ? { ...prev, failed: prev.failed + 1 } : null)
        }
      } catch {}
    }
    es.onerror = () => { es.close(); setBg(prev => prev ? { ...prev, done: true } : null); setTimeout(() => setBg(null), 8000) }
  }, [])
  const dismiss = useCallback(() => setBg(null), [])
  return { bg, start, dismiss }
}

function DrainBgBanner({ bg, onDismiss }: { bg: BgDrain; onDismiss: () => void }) {
  const pct = bg.total > 0 ? Math.round(((bg.evicted + bg.failed) / bg.total) * 100) : 0
  return (
    <div className="fixed top-2 right-2 z-[60] rounded-xl border border-hull-600/60 bg-hull-900/95 shadow-2xl backdrop-blur-sm px-4 py-2.5 flex items-center gap-3 text-[11px] min-w-[280px]">
      {!bg.done && <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-hull-600 border-t-neon-cyan shrink-0" />}
      {bg.done && <span className={`text-sm shrink-0 ${bg.failed === 0 ? 'text-neon-green' : 'text-neon-amber'}`}>{bg.failed === 0 ? '✓' : '⚠'}</span>}
      <div className="flex-1 min-w-0">
        <p className="text-white font-medium truncate">Draining <span className="text-neon-cyan font-mono">{bg.node}</span></p>
        {!bg.done ? (
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 rounded-full bg-hull-700 overflow-hidden">
              <div className="h-full rounded-full bg-neon-cyan transition-all duration-300" style={{width:`${pct}%`}} />
            </div>
            <span className="text-gray-500 tabular-nums shrink-0">{bg.evicted + bg.failed}/{bg.total}</span>
          </div>
        ) : (
          <p className="text-gray-400 mt-0.5"><span className="text-neon-green font-bold">{bg.evicted} evicted</span>{bg.failed > 0 && <span className="text-neon-red font-bold ml-2">{bg.failed} failed</span>}</p>
        )}
      </div>
      {bg.done && <button type="button" onClick={onDismiss} className="text-gray-500 hover:text-white text-sm ml-1">&times;</button>}
    </div>
  )
}

function DrainWizardModal({ nodeName, onClose, onDrained, onBackground }: { nodeName: string; onClose: () => void; onDrained: () => void; onBackground: (totalPods: number) => void }) {
  const [step, setStep] = useState<'preview' | 'draining' | 'done'>('preview')
  const [preview, setPreview] = useState<DrainPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ pod: string; ns: string; status: string; error?: string }[]>([])
  const [result, setResult] = useState<{ evicted: number; failed: number } | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    fetch(`/api/nodes/${nodeName}/drain-preview`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => setPreview(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [nodeName])

  const startDrain = () => {
    setStep('draining')
    setProgress([])
    const es = new EventSource(`/api/nodes/${nodeName}/drain?stream=true`)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.done) {
          setResult({ evicted: d.evicted, failed: d.failed })
          setStep('done')
          es.close()
          onDrained()
        } else {
          setProgress(prev => {
            const idx = prev.findIndex(p => p.pod === d.pod && p.ns === d.ns)
            if (idx >= 0) { const next = [...prev]; next[idx] = d; return next }
            return [...prev, d]
          })
        }
      } catch {}
    }
    es.onerror = () => { es.close(); setStep('done') }
  }

  const goBackground = () => {
    if (esRef.current) { esRef.current.close() }
    onBackground(preview?.summary.evictable ?? progress.length)
    onClose()
  }

  const catOrder = ['standalone', 'pdbBlocked', 'localStorage', 'normal', 'daemonSet']
  const catMeta: Record<string, { label: string; color: string; bg: string }> = {
    standalone:   { label: 'Standalone (no controller)', color: 'text-neon-red', bg: 'bg-red-950/40 border-red-900/30' },
    pdbBlocked:   { label: 'PDB Blocked',               color: 'text-neon-amber', bg: 'bg-amber-950/40 border-amber-900/30' },
    localStorage: { label: 'Local Storage (data loss)',  color: 'text-orange-400', bg: 'bg-orange-950/40 border-orange-900/30' },
    normal:       { label: 'Safe to Evict',              color: 'text-neon-green', bg: 'bg-green-950/40 border-green-900/30' },
    daemonSet:    { label: 'DaemonSet (will remain)',     color: 'text-gray-500', bg: 'bg-hull-800/40 border-hull-700/30' },
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={step !== 'draining' ? onClose : undefined}>
      <div className="w-full max-w-xl mx-4 max-h-[85vh] flex flex-col rounded-2xl border border-hull-600/60 bg-hull-950 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-hull-700/40">
          <div className="flex items-center gap-2">
            <span className="text-neon-amber text-lg">⚠</span>
            <h2 className="text-sm font-bold text-white">Drain Node: <span className="text-neon-cyan font-mono">{nodeName}</span></h2>
          </div>
          <button onClick={step === 'draining' ? goBackground : onClose} className="text-gray-500 hover:text-white transition-colors text-lg">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && <Spinner />}
          {error && <p className="text-neon-red text-xs">{error}</p>}

          {step === 'preview' && preview && (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[
                  { label: 'Total', val: preview.summary.total, color: 'text-white' },
                  { label: 'Evictable', val: preview.summary.evictable, color: 'text-neon-green' },
                  { label: 'DaemonSet', val: preview.summary.daemonSet, color: 'text-gray-500' },
                  { label: 'Standalone', val: preview.summary.standalone, color: 'text-neon-red' },
                  { label: 'Local Storage', val: preview.summary.localStorage, color: 'text-orange-400' },
                  { label: 'PDB Blocked', val: preview.summary.pdbBlocked, color: 'text-neon-amber' },
                ].map(s => (
                  <div key={s.label} className="stat-card p-2 text-center">
                    <p className={`text-base font-extrabold tabular-nums ${s.color}`}>{s.val}</p>
                    <p className="text-[8px] text-gray-500 uppercase tracking-widest">{s.label}</p>
                  </div>
                ))}
              </div>

              {preview.summary.standalone > 0 && (
                <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[11px] text-neon-red">
                  <strong>Warning:</strong> {preview.summary.standalone} standalone pod(s) have no controller and will NOT be rescheduled after eviction.
                </div>
              )}
              {preview.summary.localStorage > 0 && (
                <div className="rounded-lg border border-orange-900/40 bg-orange-950/20 px-3 py-2 text-[11px] text-orange-400">
                  <strong>Warning:</strong> {preview.summary.localStorage} pod(s) use emptyDir volumes. Data will be lost on eviction.
                </div>
              )}
              {preview.summary.pdbBlocked > 0 && (
                <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-[11px] text-neon-amber">
                  <strong>Notice:</strong> {preview.summary.pdbBlocked} pod(s) are protected by PDBs that currently allow 0 disruptions. Eviction may fail.
                </div>
              )}

              {catOrder.map(cat => {
                const pods = preview.pods.filter(p => p.category === cat)
                if (pods.length === 0) return null
                const meta = catMeta[cat]
                return (
                  <div key={cat}>
                    <p className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 ${meta.color}`}>{meta.label} ({pods.length})</p>
                    <div className="space-y-1">
                      {pods.map(p => (
                        <div key={`${p.namespace}/${p.name}`} className={`rounded-lg border px-3 py-2 text-[11px] ${meta.bg}`}>
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-white truncate">{p.name}</span>
                            <span className="text-[9px] text-gray-500 shrink-0 ml-2">{p.namespace}</span>
                          </div>
                          {p.owner && <p className="text-[9px] text-gray-600 mt-0.5">{p.ownerKind}/{p.owner}</p>}
                          {p.warning && <p className={`text-[9px] mt-0.5 ${meta.color}`}>{p.warning}</p>}
                          {p.pdbName && cat !== 'pdbBlocked' && <p className="text-[9px] text-gray-600 mt-0.5">PDB: {p.pdbName} (allows {p.pdbAllow})</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {step === 'draining' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-hull-600 border-t-neon-cyan" />
                <p className="text-xs text-gray-400">Draining in progress…</p>
              </div>
              {progress.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  {p.status === 'evicting' && <span className="h-3 w-3 animate-spin rounded-full border border-hull-600 border-t-neon-cyan shrink-0" />}
                  {p.status === 'evicted' && <span className="text-neon-green shrink-0">✓</span>}
                  {p.status === 'failed' && <span className="text-neon-red shrink-0">✗</span>}
                  <span className="font-mono text-white truncate">{p.pod}</span>
                  <span className="text-gray-600 text-[9px] shrink-0">{p.ns}</span>
                  {p.error && <span className="text-neon-red text-[9px] truncate ml-1">{p.error}</span>}
                </div>
              ))}
            </div>
          )}

          {step === 'done' && result && (
            <div className="text-center space-y-3 py-4">
              <p className="text-3xl">{result.failed === 0 ? '✓' : '⚠'}</p>
              <p className="text-sm font-bold text-white">Drain Complete</p>
              <div className="flex justify-center gap-6 text-sm">
                <span className="text-neon-green font-bold">{result.evicted} evicted</span>
                {result.failed > 0 && <span className="text-neon-red font-bold">{result.failed} failed</span>}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-hull-700/40">
          {step === 'preview' && (
            <>
              <Btn small onClick={onClose}>Cancel</Btn>
              <Btn small variant="danger" onClick={startDrain} disabled={loading || !!error || (preview?.summary.total ?? 0) === 0}>
                Confirm Drain
              </Btn>
            </>
          )}
          {step === 'draining' && (
            <Btn small onClick={goBackground}>Run in Background</Btn>
          )}
          {step === 'done' && <Btn small onClick={onClose}>Close</Btn>}
        </div>
      </div>
    </div>
  )
}

export function NodesView({ onNode, poolFilter, onPoolChange }: { onNode: (name: string) => void; poolFilter: string; onPoolChange: (pool: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const { data, err, loading, refetch } = useFetch<NodeDetail[]>('/api/nodes', 10000)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [drainTarget, setDrainTarget] = useState<string | null>(null)
  const drainBg = useDrainBg()
  const setPoolFilter = onPoolChange

  const act = async (name: string, action: string) => {
    setBusy(`${name}/${action}`)
    try { await post(`/api/nodes/${name}/${action}`); setToast(`${name} ${action}ed`); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const pools = Array.from(new Set((data ?? []).map(n => n.nodepool).filter(Boolean))).sort()
  const filtered = poolFilter ? (data ?? []).filter(n => n.nodepool === poolFilter) : (data ?? [])

  const all = data ?? []
  const readyCount = all.filter(n => n.ready && !n.cordoned).length
  const spotCount = all.filter(n => n.capacityType === 'spot').length
  const totalCpu = all.reduce((s, n) => s + n.allocCpuM, 0)
  const usedCpu = all.reduce((s, n) => s + n.usedCpuM, 0)
  const totalMem = all.reduce((s, n) => s + n.allocMemMi, 0)
  const usedMem = all.reduce((s, n) => s + n.usedMemMi, 0)
  const totalPods = all.reduce((s, n) => s + n.pods, 0)
  const totalPodCap = all.reduce((s, n) => s + n.podCapacity, 0)
  const zones = Array.from(new Set(all.map(n => n.zone).filter(Boolean)))

  return (
    <div className="space-y-2.5 p-3">
      {toast && <div className="glass rounded-lg px-3 py-2 text-xs text-gray-300 anim-in">{toast}</div>}

      {/* Aggregate summary */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-white tabular-nums">{readyCount}<span className="text-gray-600 font-normal text-xs">/{all.length}</span></p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Ready</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-orange-400 tabular-nums">{spotCount}</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Spot</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-neon-cyan tabular-nums">{totalCpu > 0 ? Math.round(usedCpu * 100 / totalCpu) : 0}%</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">CPU Avg</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-neon-cyan tabular-nums">{totalMem > 0 ? Math.round(usedMem * 100 / totalMem) : 0}%</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Mem Avg</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-neon-green tabular-nums">{totalPods}<span className="text-gray-600 font-normal text-xs">/{totalPodCap}</span></p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Pods</p>
        </div>
        <div className="stat-card p-2 text-center">
          <p className="text-base font-extrabold text-gray-300 tabular-nums">{zones.length}</p>
          <p className="text-[8px] text-gray-500 uppercase tracking-widest">Zones</p>
        </div>
      </div>

      {/* Pool filters */}
      {pools.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
          <button onClick={() => setPoolFilter('')} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${!poolFilter ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All ({all.length})</button>
          {pools.map(p => {
            const count = all.filter(n => n.nodepool === p).length
            return (
              <button key={p} onClick={() => setPoolFilter(poolFilter === p ? '' : p)} className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-medium border transition-colors ${poolFilter === p ? 'bg-purple-950/60 text-purple-300 border-purple-900/30' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>{p} ({count})</button>
            )
          })}
        </div>
      )}

      {filtered.map((n, i) => {
        const cpuPct = n.allocCpuM > 0 ? Math.round(n.usedCpuM * 100 / n.allocCpuM) : 0
        const memPct = n.allocMemMi > 0 ? Math.round(n.usedMemMi * 100 / n.allocMemMi) : 0
        const podPct = n.podCapacity > 0 ? Math.round(n.pods * 100 / n.podCapacity) : 0
        const hasPressure = n.conditions && n.conditions.length > 0
        return (
          <div key={n.name} className="stat-card p-3 anim-in cursor-pointer hover:ring-1 hover:ring-hull-600 transition-all" style={{ animationDelay: `${i * 40}ms` }} onClick={() => onNode(n.name)}>
            {/* Row 1: identity */}
            <div className="flex items-center gap-2.5">
              <StatusDot ok={n.ready && !n.cordoned && !hasPressure} />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white">{n.name}</span>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  {n.instanceType && <span className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-px text-[9px] font-mono text-neon-cyan">{n.instanceType}</span>}
                  {n.nodepool && <span className="rounded bg-purple-950/50 border border-purple-900/20 px-1.5 py-px text-[9px] font-medium text-purple-400">{n.nodepool}</span>}
                  {n.capacityType && (
                    <span className={`rounded border px-1.5 py-px text-[9px] font-medium ${n.capacityType === 'spot' ? 'bg-orange-950/40 border-orange-900/20 text-orange-400' : 'bg-hull-800 border-hull-700/50 text-gray-400'}`}>{n.capacityType}</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                {n.cordoned && <Pill color="bg-amber-950/40 text-neon-amber border border-amber-900/20">CORDONED</Pill>}
                <span className="text-[9px] text-gray-600">{n.age}</span>
              </div>
            </div>

            {/* Row 2: conditions / pressure warnings */}
            {hasPressure && (
              <div className="mt-2 flex gap-1.5 flex-wrap">
                {n.conditions.map(c => (
                  <span key={c} className="rounded bg-red-950/40 border border-red-900/20 px-1.5 py-0.5 text-[9px] font-bold text-neon-red animate-pulse">{c}</span>
                ))}
              </div>
            )}

            {/* Row 3: metadata grid */}
            <div className="mt-2.5 grid grid-cols-3 gap-x-2 gap-y-1 text-[9px]">
              <div><span className="text-gray-600 uppercase tracking-wider">Zone</span><p className="font-mono text-gray-300 truncate">{n.zone || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Arch</span><p className="font-mono text-gray-300">{n.arch || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">IP</span><p className="font-mono text-gray-300 truncate">{n.internalIp || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Kubelet</span><p className="font-mono text-gray-300 truncate">{n.kubelet || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Runtime</span><p className="font-mono text-gray-300 truncate">{n.runtime || '—'}</p></div>
              <div><span className="text-gray-600 uppercase tracking-wider">Taints</span><p className={`font-mono ${n.taints > 0 ? 'text-neon-amber' : 'text-gray-300'}`}>{n.taints}</p></div>
            </div>

            {/* Row 4: resource bars */}
            <div className="mt-3 space-y-1.5">
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">CPU</span>
                  <span className="font-mono text-[10px] text-gray-400">{n.usedCpuM}m / {n.allocCpuM}m <span className={`font-bold ${cpuPct > 80 ? 'text-neon-red' : cpuPct > 50 ? 'text-neon-amber' : 'text-neon-cyan'}`}>{cpuPct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className={`h-full rounded-full bg-gradient-to-r ${cpuPct > 80 ? 'from-red-500 to-red-400' : cpuPct > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'} transition-all duration-700`} style={{ width: `${Math.min(cpuPct, 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">Memory</span>
                  <span className="font-mono text-[10px] text-gray-400">{Math.round(n.usedMemMi / 1024 * 10) / 10}Gi / {Math.round(n.allocMemMi / 1024 * 10) / 10}Gi <span className={`font-bold ${memPct > 80 ? 'text-neon-red' : memPct > 50 ? 'text-neon-amber' : 'text-neon-cyan'}`}>{memPct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className={`h-full rounded-full bg-gradient-to-r ${memPct > 80 ? 'from-red-500 to-red-400' : memPct > 50 ? 'from-amber-500 to-amber-400' : 'from-neon-cyan to-cyan-400'} transition-all duration-700`} style={{ width: `${Math.min(memPct, 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">Pods</span>
                  <span className="font-mono text-[10px] text-gray-400">{n.pods} / {n.podCapacity || '?'} <span className={`font-bold ${podPct > 80 ? 'text-neon-red' : podPct > 50 ? 'text-neon-amber' : 'text-neon-green'}`}>{podPct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-hull-800/80 overflow-hidden">
                  <div className={`h-full rounded-full bg-gradient-to-r ${podPct > 80 ? 'from-red-500 to-red-400' : podPct > 50 ? 'from-amber-500 to-amber-400' : 'from-green-500 to-green-400'} transition-all duration-700`} style={{ width: `${Math.min(podPct, 100)}%` }} />
                </div>
              </div>
            </div>

            {/* Row 5: actions */}
            {isAdmin && <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
              {n.cordoned ? (
                <Btn small variant="success" onClick={() => act(n.name, 'uncordon')} disabled={!!busy}>
                  {busy === `${n.name}/uncordon` ? '…' : 'Uncordon'}
                </Btn>
              ) : (
                <>
                  <Btn small onClick={() => act(n.name, 'cordon')} disabled={!!busy}>
                    {busy === `${n.name}/cordon` ? '…' : 'Cordon'}
                  </Btn>
                  <Btn small variant="danger" onClick={() => setDrainTarget(n.name)}>
                    Drain
                  </Btn>
                </>
              )}
            </div>}
          </div>
        )
      })}
      {drainBg.bg && <DrainBgBanner bg={drainBg.bg} onDismiss={drainBg.dismiss} />}
      {drainTarget && <DrainWizardModal nodeName={drainTarget} onClose={() => setDrainTarget(null)} onDrained={() => { refetch(); setToast(`${drainTarget} drain complete`) }} onBackground={(total) => { drainBg.start(drainTarget, total); setDrainTarget(null) }} />}
    </div>
  )
}
