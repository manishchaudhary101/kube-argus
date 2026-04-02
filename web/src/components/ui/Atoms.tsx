import React from 'react'

export const Pill = ({ children, color }: { children: React.ReactNode; color: string }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}>{children}</span>
)


export const StatusDot = ({ ok }: { ok: boolean }) => (
  <span className={`inline-block h-2.5 w-2.5 rounded-full ring-2 ${ok ? 'bg-neon-green ring-green-500/20 shadow-[0_0_8px_rgba(0,255,136,0.5)]' : 'bg-neon-red ring-red-500/20 shadow-[0_0_8px_rgba(255,51,85,0.5)]'}`} />
)

export const Btn = ({ children, onClick, variant = 'default', disabled, small }: { children: React.ReactNode; onClick: () => void; variant?: 'default' | 'danger' | 'success' | 'primary'; disabled?: boolean; small?: boolean }) => {
  const base = small ? 'px-2.5 py-1 text-[10px]' : 'px-3 py-1.5 text-xs'
  const colors = {
    default: 'bg-hull-700/80 text-gray-300 hover:bg-hull-600 border-hull-600',
    danger: 'bg-red-950/40 text-neon-red border-red-900/40 hover:bg-red-900/30 hover:shadow-[0_0_12px_rgba(255,51,85,0.15)]',
    success: 'bg-green-950/40 text-neon-green border-green-900/40 hover:bg-green-900/30 hover:shadow-[0_0_12px_rgba(0,255,136,0.15)]',
    primary: 'bg-cyan-950/40 text-neon-cyan border-cyan-900/40 hover:bg-cyan-900/30 hover:shadow-[0_0_12px_rgba(6,214,224,0.15)]',
  }
  return <button onClick={onClick} disabled={disabled} className={`${base} rounded-lg border font-medium transition-all duration-200 disabled:opacity-30 ${colors[variant]}`}>{children}</button>
}

export const SizingBadge = ({ resource, sizing }: { resource: string; sizing: string }) => {
  if (sizing === 'ok') return <span className="rounded-full bg-green-950/40 border border-green-900/20 px-1.5 py-0.5 text-[9px] font-medium text-neon-green">{resource} ✓</span>
  if (sizing === 'over') return <span className="rounded-full bg-amber-950/40 border border-amber-900/20 px-1.5 py-0.5 text-[9px] font-medium text-neon-amber">{resource} ↑ over</span>
  if (sizing === 'under') return <span className="rounded-full bg-red-950/40 border border-red-900/20 px-1.5 py-0.5 text-[9px] font-medium text-neon-red">{resource} ↓ under</span>
  return null
}

export const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="relative h-8 w-8">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
      <div className="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-b-neon-green" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
    </div>
  </div>
)

export const MiniStat = ({ label, value, sub, color = 'text-white', icon, onClick }: { label: string; value: string | number; sub?: string; color?: string; icon: string; onClick?: () => void }) => (
  <div className={`stat-card p-3 anim-in ${onClick ? 'cursor-pointer active:scale-95 transition-transform' : ''}`} onClick={onClick}>
    <div className="flex items-start justify-between">
      <span className="text-lg opacity-60">{icon}</span>
      <span className={`text-xl font-bold tabular-nums ${color}`}>{value}</span>
    </div>
    <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
    {sub && <p className="text-[9px] text-gray-600 mt-0.5">{sub}</p>}
  </div>
)


export const UserAvatar = ({ email }: { email: string }) => {
  const initials = email.split('@')[0].split('.').map(p => p[0]?.toUpperCase()).join('').slice(0, 2)
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-neon-cyan/20 to-neon-green/10 text-[10px] font-bold text-neon-cyan ring-1 ring-neon-cyan/20">{initials}</div>
  )
}

export function ContainerStateBadge({ state, reason }: { state: string; reason: string }) {
  const label = reason || state
  if (state === 'running') return <span className="rounded-full bg-green-950/50 px-2 py-0.5 text-[10px] font-medium text-neon-green">{label}</span>
  if (state === 'waiting') {
    const isDanger = /CrashLoop|OOMKill|Error|BackOff|ImagePull/i.test(reason)
    return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${isDanger ? 'bg-red-950/50 text-neon-red' : 'bg-amber-950/50 text-neon-amber'}`}>{label}</span>
  }
  return <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-medium text-gray-400">{label}</span>
}
