import { useState, useEffect, useCallback, useRef } from 'react'

type SearchResult = { kind: string; name: string; namespace: string }

// ─── Search Modal ───────────────────────────────────────────────────
export function SearchModal({ onClose, onSelect }: { onClose: () => void; onSelect: (r: SearchResult) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { inputRef.current?.focus() }, [])

  const doSearch = useCallback((q: string) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
  }, [])

  const handleInput = (v: string) => {
    setQuery(v)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(v), 300)
  }

  const kindIcon = (k: string) => {
    switch (k) {
      case 'Pod': return '◉'
      case 'Deployment': return '▣'
      case 'Service': return '⇌'
      case 'Ingress': return '↗'
      case 'Node': return '⬢'
      default: return '●'
    }
  }
  const kindColor = (k: string) => {
    switch (k) {
      case 'Pod': return 'text-neon-green'
      case 'Deployment': return 'text-neon-cyan'
      case 'Service': return 'text-indigo-400'
      case 'Ingress': return 'text-indigo-300'
      case 'Node': return 'text-neon-amber'
      default: return 'text-gray-400'
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-hull-950/95 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-auto w-full max-w-lg px-4 pt-12" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 rounded-lg border border-hull-600 bg-hull-900 px-3 py-2">
          <span className="text-gray-500">⌕</span>
          <input ref={inputRef} type="text" value={query} onChange={e => handleInput(e.target.value)} placeholder="Search pods, deployments, services, nodes…" className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-gray-600" />
          {loading && <div className="h-4 w-4 animate-spin rounded-full border-2 border-hull-600 border-t-neon-cyan" />}
          <button onClick={onClose} className="text-xs text-gray-600 hover:text-gray-400">ESC</button>
        </div>
        <div className="mt-2 max-h-[60vh] overflow-auto rounded-lg border border-hull-700 bg-hull-900">
          {query.length < 2 && <p className="p-4 text-center text-xs text-gray-600">Type at least 2 characters</p>}
          {query.length >= 2 && results.length === 0 && !loading && <p className="p-4 text-center text-xs text-gray-600">No results</p>}
          {results.map((r, i) => (
            <button key={i} onClick={() => { onSelect(r); onClose() }} className="flex w-full items-center gap-3 border-b border-hull-800 px-4 py-3 text-left transition-colors hover:bg-hull-800 active:bg-hull-700 last:border-0">
              <span className={`text-lg ${kindColor(r.kind)}`}>{kindIcon(r.kind)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{r.name}</p>
                <p className="text-[10px] text-gray-600">{r.kind}{r.namespace ? ` · ${r.namespace}` : ''}</p>
              </div>
              <span className="text-gray-700">›</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
