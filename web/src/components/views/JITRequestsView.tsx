import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../context/AuthContext'

interface JITRequest {
  id: string
  email: string
  namespace: string
  pod: string
  ownerKind: string
  ownerName: string
  reason: string
  duration: string
  status: string
  createdAt: string
  approvedBy?: string
  expiresAt?: string
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-950/50 text-amber-400 border-amber-900/40',
  active: 'bg-emerald-950/50 text-emerald-400 border-emerald-900/40',
  denied: 'bg-red-950/50 text-red-400 border-red-900/40',
  expired: 'bg-hull-800 text-gray-500 border-hull-700',
  revoked: 'bg-red-950/30 text-red-500 border-red-900/30',
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function timeRemaining(expiresAt: string): string {
  const exp = new Date(expiresAt).getTime()
  const diff = exp - Date.now()
  if (diff <= 0) return 'expired'
  if (diff < 60000) return `${Math.ceil(diff / 1000)}s`
  if (diff < 3600000) return `${Math.ceil(diff / 60000)}m`
  return `${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`
}

export function JITRequestsModal({ onClose }: { onClose: () => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [requests, setRequests] = useState<JITRequest[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchRequests = useCallback(() => {
    fetch('/api/jit/requests').then(r => r.json()).then(setRequests).catch(() => {})
  }, [])

  useEffect(() => {
    fetchRequests()
    const id = setInterval(fetchRequests, 10000)
    return () => clearInterval(id)
  }, [fetchRequests])

  const doAction = async (id: string, action: string) => {
    setActionLoading(`${id}-${action}`)
    try {
      const r = await fetch(`/api/jit/${id}/${action}`, { method: 'POST' })
      if (!r.ok) throw new Error(await r.text())
      fetchRequests()
    } catch { /* ignore */ }
    setActionLoading(null)
  }

  const filtered = filter === 'all' ? requests : requests.filter(r => r.status === filter)
  const pendingCount = requests.filter(r => r.status === 'pending').length
  const activeCount = requests.filter(r => r.status === 'active').length

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 mx-4 w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-2xl border border-hull-600 bg-hull-900 shadow-2xl shadow-black/60 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-white">Access Requests</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">
              Just-in-Time shell access approval workflow
              {pendingCount > 0 && <span className="ml-2 text-amber-400">{pendingCount} pending</span>}
              {activeCount > 0 && <span className="ml-2 text-emerald-400">{activeCount} active</span>}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="flex items-center gap-2 px-5 py-2 border-b border-hull-700/20">
          {['all', 'pending', 'active', 'denied', 'expired', 'revoked'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-2.5 py-1 text-[10px] font-medium transition-all ${
                filter === f ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30' : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
          <span className="ml-auto text-[9px] text-gray-600">{filtered.length} requests</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-600">
              <p className="text-sm">No {filter === 'all' ? '' : filter + ' '}requests</p>
              <p className="text-[10px] mt-1">Viewers can request shell access from the pod detail page</p>
            </div>
          ) : (
            <div className="space-y-2 p-4">
              {filtered.map(req => (
                <div key={req.id} className="rounded-xl border border-hull-700/50 bg-hull-800/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[req.status] || STATUS_STYLES.expired}`}>
                          {req.status}
                        </span>
                        <span className="text-xs font-medium text-gray-300">{req.email}</span>
                        <span className="text-[10px] text-gray-600">{timeAgo(req.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] mt-1 flex-wrap">
                        <span className="text-gray-500">ns: <span className="font-mono text-gray-300">{req.namespace}</span></span>
                        {req.ownerKind && req.ownerName ? (
                          <span className="text-gray-500">{req.ownerKind.toLowerCase()}: <span className="font-mono text-gray-300">{req.ownerName}</span></span>
                        ) : (
                          <span className="text-gray-500">pod: <span className="font-mono text-gray-300">{req.pod}</span></span>
                        )}
                        <span className="text-gray-500">duration: <span className="text-gray-300">{req.duration}</span></span>
                        {req.status === 'active' && req.expiresAt && (
                          <span className="text-emerald-500">expires in {timeRemaining(req.expiresAt)}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1.5 line-clamp-2">{req.reason}</p>
                      {req.approvedBy && (
                        <p className="text-[10px] text-gray-600 mt-1">
                          {req.status === 'denied' ? 'Denied' : req.status === 'revoked' ? 'Revoked' : 'Approved'} by {req.approvedBy}
                        </p>
                      )}
                    </div>

                    {isAdmin && (
                      <div className="flex gap-1.5 shrink-0">
                        {req.status === 'pending' && (
                          <>
                            <button onClick={() => doAction(req.id, 'approve')} disabled={actionLoading === `${req.id}-approve`}
                              className="rounded-lg border border-emerald-900/40 bg-emerald-950/40 px-3 py-1.5 text-[10px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-900/30 disabled:opacity-40">
                              {actionLoading === `${req.id}-approve` ? '...' : 'Approve'}
                            </button>
                            <button onClick={() => doAction(req.id, 'deny')} disabled={actionLoading === `${req.id}-deny`}
                              className="rounded-lg border border-red-900/40 bg-red-950/40 px-3 py-1.5 text-[10px] font-semibold text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-40">
                              {actionLoading === `${req.id}-deny` ? '...' : 'Deny'}
                            </button>
                          </>
                        )}
                        {req.status === 'active' && (
                          <button onClick={() => doAction(req.id, 'revoke')} disabled={actionLoading === `${req.id}-revoke`}
                            className="rounded-lg border border-red-900/40 bg-red-950/40 px-3 py-1.5 text-[10px] font-semibold text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-40">
                            {actionLoading === `${req.id}-revoke` ? '...' : 'Revoke'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
