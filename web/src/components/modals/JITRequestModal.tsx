import { useState } from 'react'

export function JITRequestModal({ ns, pod, ownerKind, ownerName, accessType, onClose, onSubmitted }: { ns: string; pod: string; ownerKind?: string; ownerName?: string; accessType?: 'exec' | 'restart' | 'cron-trigger'; onClose: () => void; onSubmitted: () => void }) {
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState('1h')
  const [custom, setCustom] = useState(false)
  const [customVal, setCustomVal] = useState('8')
  const [customUnit, setCustomUnit] = useState<'h' | 'd'>('h')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveDuration = custom
    ? (customUnit === 'd' ? `${parseInt(customVal || '0') * 24}h` : `${customVal || '0'}h`)
    : duration

  const submit = async () => {
    if (!reason.trim()) { setError('Reason is required'); return }
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch('/api/jit/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: ns, pod, ownerKind: ownerKind || '', ownerName: ownerName || '', reason: reason.trim(), duration: effectiveDuration })
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
            <h2 className="text-sm font-bold text-white">{accessType === 'restart' ? 'Request Restart Access' : ownerKind === 'CronJob' ? 'Request CronTrigger Access' : 'Request Pod Shell/Exec Access'}</h2>
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
            <p className="text-[10px] text-gray-500">{accessType === 'restart' ? `Grants permission to restart this ${ownerKind.toLowerCase()}` : `Access will apply to all pods owned by this ${ownerKind.toLowerCase()}`}</p>
          )}

          <div>
            <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Duration</label>
            <div className="grid grid-cols-5 gap-1.5">
              {(['30m', '1h', '2h', '4h', 'custom'] as const).map(d => (
                <button key={d} onClick={() => { if (d === 'custom') { setDuration(''); setCustom(true) } else { setDuration(d); setCustom(false) } }}
                  className={`rounded-lg py-1.5 text-xs font-medium transition-all ${
                    (d === 'custom' ? custom : duration === d && !custom)
                      ? 'bg-neon-cyan/15 border border-neon-cyan/40 text-neon-cyan'
                      : 'bg-hull-800 border border-hull-700 text-gray-400 hover:text-white hover:border-hull-600'
                  }`}>
                  {d === 'custom' ? 'Custom' : d}
                </button>
              ))}
            </div>
            {custom && (
              <div className="flex items-center gap-2 mt-2">
                <input type="number" min={1} max={168} value={customVal} onChange={e => setCustomVal(e.target.value)}
                  className="w-20 rounded-lg bg-hull-800 border border-hull-700 px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-neon-cyan/40" />
                <select value={customUnit} onChange={e => setCustomUnit(e.target.value as 'h' | 'd')}
                  className="rounded-lg bg-hull-800 border border-hull-700 px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-neon-cyan/40">
                  <option value="h">hours</option>
                  <option value="d">days</option>
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">Reason</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder={accessType === 'restart' ? 'Why do you need to restart this workload?' : ownerKind === 'CronJob' ? 'Why do you need to trigger this CronJob?' : 'Why do you need shell access?'}
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
