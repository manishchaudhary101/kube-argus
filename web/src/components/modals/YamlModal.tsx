import { useState, useEffect, useContext, createContext } from 'react'
import yaml from 'js-yaml'

type UserInfo = { email: string; role: string; authMode?: string }
const AuthCtx = createContext<UserInfo>({ email: 'anonymous', role: 'viewer', authMode: 'none' })
const useAuth = () => useContext(AuthCtx)

const Spinner = () => (
  <div className="flex justify-center py-16">
    <div className="relative h-8 w-8">
      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
      <div className="absolute inset-1 animate-spin rounded-full border-2 border-transparent border-b-neon-green" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
    </div>
  </div>
)

// ─── YAML Viewer/Editor Modal ───────────────────────────────────────

export function highlightYaml(text: string): string {
  return text.replace(/^(\s*)([\w.\-/]+)(:)/gm, '$1<span class="text-neon-cyan">$2</span><span class="text-gray-500">$3</span>')
    .replace(/: (true|false)/g, ': <span class="text-purple-400">$1</span>')
    .replace(/: (\d+[\d.]*)/g, ': <span class="text-amber-400">$1</span>')
    .replace(/: "([^"]*)"/g, ': <span class="text-green-400">"$1"</span>')
    .replace(/: '([^']*)'/g, ': <span class="text-green-400">\'$1\'</span>')
    .replace(/^(\s*- )/gm, '<span class="text-gray-500">$1</span>')
    .replace(/#.*/g, '<span class="text-gray-600">$&</span>')
}

export function YamlModal({ kind, ns, name, onClose }: { kind: string; ns: string; name: string; onClose: () => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [content, setContent] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/yaml/${kind}/${ns}/${name}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => {
        const cleaned = { ...d }
        delete cleaned.managedFields
        if (cleaned.metadata) {
          const m = { ...cleaned.metadata }
          delete m.managedFields
          cleaned.metadata = m
        }
        const y = yaml.dump(cleaned, { lineWidth: 120, noRefs: true, sortKeys: false })
        setContent(y)
        setEditContent(y)
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [kind, ns, name])

  const handleApply = async () => {
    setSaving(true)
    setError(null)
    try {
      const parsed = yaml.load(editContent)
      const resp = await fetch(`/api/yaml/${kind}/${ns}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text)
      }
      setToast('Applied successfully')
      setEditMode(false)
      setTimeout(() => setToast(null), 3000)
      const fresh = await fetch(`/api/yaml/${kind}/${ns}/${name}`)
      if (fresh.ok) {
        const d = await fresh.json()
        const cleaned = { ...d }
        delete cleaned.managedFields
        if (cleaned.metadata) { const m = { ...cleaned.metadata }; delete m.managedFields; cleaned.metadata = m }
        const y = yaml.dump(cleaned, { lineWidth: 120, noRefs: true, sortKeys: false })
        setContent(y)
        setEditContent(y)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(editMode ? editContent : content).then(() => {
      setToast('Copied to clipboard')
      setTimeout(() => setToast(null), 2000)
    })
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 mx-4 w-full max-w-4xl max-h-[85vh] overflow-hidden rounded-2xl border border-hull-600 bg-hull-900 shadow-2xl shadow-black/60 flex flex-col" onClick={e => e.stopPropagation()}>
        {toast && <div className="absolute top-3 right-14 z-20 rounded-lg border border-hull-600 bg-hull-800 px-3 py-1.5 text-[10px] text-neon-green shadow-lg">{toast}</div>}
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="rounded border border-hull-600 bg-hull-800 px-1.5 py-0.5 text-[9px] font-bold uppercase text-gray-400">{kind}</span>
            <h2 className="text-sm font-bold text-white truncate">{name}</h2>
            <span className="text-[10px] text-gray-500">{ns}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={copyToClipboard} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">Copy</button>
            {isAdmin && !editMode && (
              <button onClick={() => setEditMode(true)} className="rounded-lg border border-cyan-900/40 bg-cyan-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-cyan-900/30">Edit</button>
            )}
            {editMode && (
              <>
                <button onClick={() => { setEditMode(false); setEditContent(content); setError(null) }} className="rounded-lg border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] text-gray-400 hover:text-white transition-colors">Cancel</button>
                <button onClick={handleApply} disabled={saving} className="rounded-lg border border-blue-900/50 bg-blue-950/60 px-2.5 py-1 text-[10px] font-medium text-neon-blue transition-colors hover:bg-blue-900/40 disabled:opacity-40">
                  {saving ? 'Applying…' : 'Apply'}
                </button>
              </>
            )}
            <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:text-white transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        {error && <div className="px-5 py-2 bg-red-950/30 border-b border-red-900/30 text-[11px] text-neon-red break-all">{error}</div>}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Spinner /></div>
          ) : editMode ? (
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full h-full min-h-[400px] bg-hull-950 text-gray-300 font-mono text-[11px] leading-relaxed p-4 resize-none border-0 outline-none"
              spellCheck={false}
            />
          ) : (
            <pre
              className="p-4 font-mono text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap break-all"
              dangerouslySetInnerHTML={{ __html: highlightYaml(content) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
