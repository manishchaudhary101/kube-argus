import { useState } from 'react'

export function JITRequestModal({ ns, pod, ownerKind, ownerName, onClose, onSubmitted }: { ns: string; pod: string; ownerKind?: string; ownerName?: string; onClose: () => void; onSubmitted: () => void }) {
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState('1h')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!reason.trim()) { setError('Reason is required'); return }
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch('/api/jit/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: ns, pod, ownerKind: ownerKind || '', ownerName: ownerName || '', reason: reason.trim(), duration })
      })
      if (!r.ok) {
        const text = await r.text()
        throw new Error(text || 'Request failed')
      }
      onSubmitted()
    } catch (e: any) {
      setError(e.message || 'Request failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-hull-700/50 bg-hull-900 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-4">
          <div>
            <h2 className="text-sm font-bold text-white">Request Shell Access</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">JIT access request — requires admin approval</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-500 hover:text-white transition-colors" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Namespace</label>
              <div className="rounded-lg bg-hull-800 border border-hull-700 px-3 py-2 text-xs text-gray-300 font-mono">{ns}</div>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">{ownerKind || 'Pod'}</label>
              <div className="rounded-lg bg-hull-800 border border-hull-700 px-3 py-2 text-xs text-gray-300 font-mono truncate">{ownerName || pod}</div>
            </div>
          </div>
          {ownerKind && ownerName && (
            <p className="text-[10px] text-gray-500">Access will apply to all pods owned by this {ownerKind.toLowerCase()}</p>
          )}

          <div>
            <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Duration</label>
            <div className="grid grid-cols-4 gap-1.5">
              {(['30m', '1h', '2h', '4h'] as const).map(d => (
                <button key={d} onClick={() => setDuration(d)}
                  className={`rounded-lg py-1.5 text-xs font-medium transition-all ${
                    duration === d
                      ? 'bg-neon-cyan/15 border border-neon-cyan/40 text-neon-cyan'
                      : 'bg-hull-800 border border-hull-700 text-gray-400 hover:text-white hover:border-hull-600'
                  }`}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Reason</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Why do you need shell access?"
              className="w-full rounded-lg bg-hull-800 border border-hull-700 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-neon-cyan/40 resize-none" />
          </div>

          {error && <p className="text-[11px] text-neon-red">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-hull-700/40 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-hull-600 bg-hull-800 px-4 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button onClick={submit} disabled={submitting}
            className="rounded-lg bg-gradient-to-r from-neon-cyan/20 to-neon-green/10 border border-neon-cyan/30 px-4 py-1.5 text-xs font-semibold text-neon-cyan transition-all hover:shadow-[0_0_20px_rgba(6,214,224,0.15)] disabled:opacity-40">
            {submitting ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  )
}
