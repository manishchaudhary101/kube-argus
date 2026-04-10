import { useState, useEffect, useCallback } from 'react'

const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="relative h-8 w-8">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
      <div className="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-b-neon-green" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
    </div>
  </div>
)

// ─── Audit Trail Modal ──────────────────────────────────────────────

export type AuditEvent = { time: string; actor: string; role: string; action: string; resource: string; detail: string; ip: string }

export const AUDIT_ACTION_STYLE: Record<string, { bg: string; text: string }> = {
  login: { bg: 'bg-neon-green/10 border-neon-green/20', text: 'text-neon-green' },
  logout: { bg: 'bg-gray-700/30 border-gray-600/30', text: 'text-gray-400' },
  'pod.delete': { bg: 'bg-neon-red/10 border-neon-red/20', text: 'text-neon-red' },
  'pod.exec': { bg: 'bg-neon-cyan/10 border-neon-cyan/20', text: 'text-neon-cyan' },
  'workload.restart': { bg: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-400' },
  'workload.scale': { bg: 'bg-neon-amber/10 border-neon-amber/20', text: 'text-neon-amber' },
  'resource.edit': { bg: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-400' },
  'cronjob.trigger': { bg: 'bg-sky-500/10 border-sky-500/20', text: 'text-sky-400' },
  'jit.request': { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400' },
  'jit.approve': { bg: 'bg-neon-green/10 border-neon-green/20', text: 'text-neon-green' },
  'jit.deny': { bg: 'bg-neon-red/10 border-neon-red/20', text: 'text-neon-red' },
  'jit.revoke': { bg: 'bg-neon-red/10 border-neon-red/20', text: 'text-neon-red' },
  'jit.expired': { bg: 'bg-gray-700/30 border-gray-600/30', text: 'text-gray-400' },
}

export function AuditTrailModal({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)

  const fetchAudit = useCallback(() => {
    fetch('/api/audit?limit=500')
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => { if (Array.isArray(d)) setEvents(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { fetchAudit() }, [fetchAudit])
  useEffect(() => { const iv = setInterval(fetchAudit, 30000); return () => clearInterval(iv) }, [fetchAudit])

  const filtered = filter === 'all' ? events
    : filter === 'logins' ? events.filter(e => e.action === 'login' || e.action === 'logout')
    : filter === 'jit' ? events.filter(e => e.action.startsWith('jit.'))
    : events.filter(e => e.action !== 'login' && e.action !== 'logout' && !e.action.startsWith('jit.'))

  const timeAgo = (iso: string) => {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (sec < 60) return `${sec}s ago`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
    return `${Math.floor(sec / 86400)}d ago`
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 mx-4 w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-2xl border border-hull-600 bg-hull-900 shadow-2xl shadow-black/60 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-white">Audit Trail</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">{events.length} events tracked this session</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="flex items-center gap-2 px-5 py-2 border-b border-hull-700/20">
          {(['all', 'logins', 'jit', 'actions'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1 text-[10px] font-medium transition-all ${filter === f ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30' : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}>
              {f === 'all' ? 'All' : f === 'logins' ? 'Logins' : f === 'jit' ? 'Access Requests' : 'Actions'}
            </button>
          ))}
          <span className="ml-auto text-[9px] text-gray-600">{filtered.length} events</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-xs">No audit events recorded yet</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-gray-600 border-b border-hull-700/30">
                  <th className="text-left px-5 py-2 font-medium">Time</th>
                  <th className="text-left px-2 py-2 font-medium">Actor</th>
                  <th className="text-left px-2 py-2 font-medium">Action</th>
                  <th className="text-left px-2 py-2 font-medium">Resource</th>
                  <th className="text-left px-2 py-2 font-medium">Detail</th>
                  <th className="text-left px-2 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => {
                  const style = AUDIT_ACTION_STYLE[e.action] || { bg: 'bg-hull-800 border-hull-600', text: 'text-gray-400' }
                  return (
                    <tr key={i} className="border-b border-hull-800/50 hover:bg-hull-800/30 transition-colors">
                      <td className="px-5 py-2 text-gray-500 whitespace-nowrap" title={new Date(e.time).toLocaleString()}>{timeAgo(e.time)}</td>
                      <td className="px-2 py-2 text-gray-300 font-medium truncate max-w-[140px]" title={e.actor}>{e.actor}</td>
                      <td className="px-2 py-2">
                        <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${style.bg} ${style.text}`}>{e.action}</span>
                      </td>
                      <td className="px-2 py-2 text-gray-400 font-mono text-[10px] truncate max-w-[180px]" title={e.resource}>{e.resource || '—'}</td>
                      <td className="px-2 py-2 text-gray-500 truncate max-w-[120px]" title={e.detail}>{e.detail || '—'}</td>
                      <td className="px-2 py-2 text-gray-600 font-mono text-[10px]">{e.ip}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
