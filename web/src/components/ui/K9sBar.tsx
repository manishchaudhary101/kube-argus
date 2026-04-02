import React, { useRef, useEffect } from 'react'

export const K9sBar = ({ pct, large }: { pct: number; large?: boolean }) => {
  const filled = Math.round(Math.min(pct, 100) / 5)
  const empty = 20 - filled
  const color = pct > 80 ? 'text-neon-red' : pct > 50 ? 'text-neon-amber' : 'text-neon-green'
  return (
    <span className={`font-mono leading-none ${large ? 'text-sm' : 'text-[11px]'}`}>
      <span className={color}>{'█'.repeat(filled)}</span>
      <span className="text-hull-700">{'░'.repeat(empty)}</span>
    </span>
  )
}

export function Celld({ k, changed, className, children }: { k: string; changed: Set<string>; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLTableCellElement>(null)
  useEffect(() => {
    if (!changed.has(k) || !ref.current) return
    ref.current.classList.remove('k9s-changed')
    void ref.current.offsetWidth
    ref.current.classList.add('k9s-changed')
  }, [k, changed])
  return <td ref={ref} className={className}>{children}</td>
}
