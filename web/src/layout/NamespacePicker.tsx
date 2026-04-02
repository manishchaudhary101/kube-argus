import { useState, useRef, useEffect } from 'react'

export function NamespacePicker({ namespaces, value, onChange }: { namespaces: string[]; value: string; onChange: (ns: string) => void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => { if (!open) setFilter('') }, [open])

  const filtered = filter ? namespaces.filter(n => n.toLowerCase().includes(filter.toLowerCase())) : namespaces

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-all ${value ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/30 hover:bg-neon-cyan/20' : 'glass text-gray-400 border-transparent hover:text-gray-300'}`}>
        <span className="text-[10px]">⬡</span>
        <span className="max-w-[100px] truncate">{value || 'All Namespaces'}</span>
        {value && (
          <span onClick={e => { e.stopPropagation(); onChange(''); setOpen(false) }}
            className="ml-0.5 text-[9px] text-gray-500 hover:text-white transition-colors">&times;</span>
        )}
        <svg width="8" height="8" viewBox="0 0 8 8" className={`transition-transform ${open ? 'rotate-180' : ''}`}><path d="M1 3l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl border border-hull-600/60 bg-hull-950 shadow-2xl shadow-black/60 overflow-hidden">
          <div className="p-2 border-b border-hull-700/40">
            <input autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter namespaces…"
              className="w-full rounded-lg border border-hull-600/40 bg-hull-800/60 px-2.5 py-1.5 text-[11px] text-gray-300 outline-none placeholder:text-gray-700 focus:border-neon-cyan/30" />
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button onClick={() => { onChange(''); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2 ${!value ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-gray-400 hover:bg-hull-800/60 hover:text-white'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${!value ? 'bg-neon-cyan' : 'bg-gray-700'}`} />
              All Namespaces
              <span className="ml-auto text-[9px] text-gray-600">{namespaces.length}</span>
            </button>
            {filtered.map(n => (
              <button key={n} onClick={() => { onChange(n); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2 ${value === n ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-gray-400 hover:bg-hull-800/60 hover:text-white'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${value === n ? 'bg-neon-cyan' : 'bg-gray-700'}`} />
                <span className="truncate font-mono">{n}</span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-3 py-3 text-[10px] text-gray-600 text-center">No namespaces match</p>}
          </div>
        </div>
      )}
    </div>
  )
}
