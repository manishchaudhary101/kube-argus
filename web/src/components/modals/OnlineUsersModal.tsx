import { useState, useEffect, useCallback } from 'react'

type OnlineUser = { email: string; role: string; lastSeen: string; ip: string }
type Status = 'online' | 'away' | 'offline'

const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="relative h-8 w-8">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
      <div className="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-b-neon-green" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
    </div>
  </div>
)

function getStatus(lastSeen: string): Status {
  const sec = Math.floor((Date.now() - new Date(lastSeen).getTime()) / 1000)
  if (sec < 300) return 'online'
  if (sec < 3600) return 'away'
  return 'offline'
}

const statusDot: Record<Status, string> = {
  online: 'bg-neon-green',
  away: 'bg-neon-amber',
  offline: 'bg-gray-600',
}

const statusLabel: Record<Status, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
}

// ─── Online Users Modal ─────────────────────────────────────────────

export function OnlineUsersModal({ currentEmail, onClose }: { currentEmail: string; onClose: () => void }) {
  const [users, setUsers] = useState<OnlineUser[]>([])
  const [loading, setLoading] = useState(true)

  const fetchUsers = useCallback(() => {
    fetch('/api/online-users')
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => { if (Array.isArray(d)) setUsers(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])
  useEffect(() => { const iv = setInterval(fetchUsers, 15000); return () => clearInterval(iv) }, [fetchUsers])

  const timeAgo = (iso: string) => {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (sec < 10) return 'just now'
    if (sec < 60) return `${sec}s ago`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
    return `${Math.floor(sec / 3600)}h ago`
  }

  const onlineCount = users.filter(u => getStatus(u.lastSeen) === 'online').length
  const groups: { status: Status; items: OnlineUser[] }[] = (['online', 'away', 'offline'] as Status[])
    .map(s => ({ status: s, items: users.filter(u => getStatus(u.lastSeen) === s) }))
    .filter(g => g.items.length > 0)

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 mx-4 w-full max-w-md max-h-[70vh] overflow-hidden rounded-2xl border border-hull-600 bg-hull-900 shadow-2xl shadow-black/60 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-white">Online Users</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">{onlineCount} online now · {users.length} seen in last 24h</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Spinner /></div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-xs">No active users</div>
          ) : (
            groups.map(g => (
              <div key={g.status}>
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-hull-900/95 backdrop-blur-sm px-5 py-2 border-b border-hull-800/40">
                  <span className={`h-2 w-2 rounded-full ${statusDot[g.status]}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{statusLabel[g.status]} — {g.items.length}</span>
                </div>
                <div className="divide-y divide-hull-800/50">
                  {g.items.map(u => (
                    <div key={u.email} className="flex items-center gap-3 px-5 py-3 hover:bg-hull-800/30 transition-colors">
                      <div className="relative">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-neon-cyan/20 to-neon-green/10 text-[10px] font-bold text-neon-cyan ring-1 ring-neon-cyan/20">
                          {u.email.split('@')[0].split('.').map(p => p[0]?.toUpperCase()).join('').slice(0, 2)}
                        </div>
                        <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ${statusDot[getStatus(u.lastSeen)]} ring-2 ring-hull-900`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[11px] font-medium truncate ${u.email === currentEmail ? 'text-neon-cyan' : 'text-white'}`}>
                          {u.email.split('@')[0]}{u.email === currentEmail ? ' (you)' : ''}
                        </p>
                        <p className="text-[9px] text-gray-500">{u.email}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`text-[8px] font-bold uppercase tracking-widest ${u.role === 'admin' ? 'text-neon-cyan' : 'text-gray-600'}`}>{u.role}</span>
                        <p className="text-[9px] text-gray-600 mt-0.5">{timeAgo(u.lastSeen)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
