import { useState, useEffect, useCallback, useRef } from 'react'

export type DrainPodEntry = { name: string; namespace: string; owner: string; ownerKind: string; category: string; warning?: string; pdbName?: string; pdbAllow?: number }
export type DrainPreview = { pods: DrainPodEntry[]; summary: Record<string, number> }

export type BgDrain = { node: string; evicted: number; failed: number; total: number; done: boolean }

const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="relative h-8 w-8">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
      <div className="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-b-neon-green" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
    </div>
  </div>
)

const Btn = ({ children, onClick, variant = 'default', disabled, small }: { children: React.ReactNode; onClick: () => void; variant?: 'default' | 'danger' | 'success' | 'primary'; disabled?: boolean; small?: boolean }) => {
  const base = small ? 'px-2.5 py-1 text-[10px]' : 'px-3 py-1.5 text-xs'
  const colors = {
    default: 'bg-hull-700/80 text-gray-300 hover:bg-hull-600 border-hull-600',
    danger: 'bg-red-950/40 text-neon-red border-red-900/40 hover:bg-red-900/30 hover:shadow-[0_0_12px_rgba(255,51,85,0.15)]',
    success: 'bg-green-950/40 text-neon-green border-green-900/40 hover:bg-green-900/30 hover:shadow-[0_0_12px_rgba(0,255,136,0.15)]',
    primary: 'bg-cyan-950/40 text-neon-cyan border-cyan-900/40 hover:bg-cyan-900/30 hover:shadow-[0_0_12px_rgba(6,214,224,0.15)]',
  }
  return <button onClick={onClick} disabled={disabled} className={`${base} rounded-lg border font-medium transition-all duration-200 disabled:opacity-30 ${colors[variant]}`}>{children}</button>
}

// ─── Drain Wizard Modal ─────────────────────────────────────────────

export function useDrainBg() {
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

export function DrainBgBanner({ bg, onDismiss }: { bg: BgDrain; onDismiss: () => void }) {
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

export function DrainWizardModal({ nodeName, onClose, onDrained, onBackground }: { nodeName: string; onClose: () => void; onDrained: () => void; onBackground: (totalPods: number) => void }) {
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
