import { useState, useCallback } from 'react'

export type BgDrain = { node: string; evicted: number; failed: number; total: number; done: boolean }

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
