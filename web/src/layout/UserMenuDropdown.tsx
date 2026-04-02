import React, { useEffect } from 'react'

export type OnlineUser = { email: string; role: string; lastSeen: string; ip: string }

export function UserMenuDropdown({ email, role, onClose, onAudit, onOnlineUsers, containerRef }: { email: string; role: string; onClose: () => void; onAudit: () => void; onOnlineUsers: () => void; containerRef: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, containerRef])

  return (
    <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-hull-600 bg-hull-950 shadow-2xl shadow-black/60 z-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-hull-700/30">
        <p className="text-[11px] font-medium text-white truncate">{email}</p>
        <p className={`text-[9px] font-bold uppercase tracking-widest mt-0.5 ${role === 'admin' ? 'text-neon-cyan' : 'text-gray-500'}`}>{role}</p>
      </div>
      <div className="py-1">
        {role === 'admin' && (
          <>
            <button onClick={onOnlineUsers} className="flex w-full items-center gap-2.5 px-4 py-2 text-[11px] text-gray-400 hover:bg-hull-800/60 hover:text-white transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Online Users
            </button>
            <button onClick={onAudit} className="flex w-full items-center gap-2.5 px-4 py-2 text-[11px] text-gray-400 hover:bg-hull-800/60 hover:text-white transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              Audit Trail
            </button>
          </>
        )}
        <a href="/auth/logout" className="flex w-full items-center gap-2.5 px-4 py-2 text-[11px] text-gray-400 hover:bg-hull-800/60 hover:text-neon-red transition-colors no-underline">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </a>
      </div>
    </div>
  )
}
