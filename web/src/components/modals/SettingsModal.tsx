import { useState, useEffect } from 'react'

const Spinner = () => (
  <div className="relative h-5 w-5 inline-block align-middle">
    <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan" />
  </div>
)

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [webhookURL, setWebhookURL] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [enabled, setEnabled] = useState(false)
  // Masked values from server — shown as read-only when not editing
  const [savedWebhook, setSavedWebhook] = useState('')
  const [savedSecret, setSavedSecret] = useState('')
  const [editingWebhook, setEditingWebhook] = useState(false)
  const [editingSecret, setEditingSecret] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/settings/slack')
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => {
        setSavedWebhook(d.webhookURL || '')
        setSavedSecret(d.signingSecret || '')
        setEnabled(d.enabled)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }

  const hasNewWebhook = (editingWebhook || !savedWebhook) && webhookURL !== ''
  const hasNewSecret = (editingSecret || !savedSecret) && signingSecret !== ''

  const onWebhookChange = (val: string) => {
    setWebhookURL(val)
  }

  const test = async () => {
    const url = hasNewWebhook ? webhookURL : ''
    if (!url) {
      showToast('Enter a new Webhook URL first', false)
      return
    }
    setTesting(true)
    try {
      const resp = await fetch('/api/settings/slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookURL: url }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({ error: resp.statusText }))
        throw new Error(d.error || resp.statusText)
      }

      showToast('Test message sent to Slack — check your channel', true)
    } catch (e: any) {

      showToast(`Test failed: ${e.message}`, false)
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    // Build payload: send values that are new (first setup) or being changed
    const payload: Record<string, string> = {}
    if (hasNewWebhook) {
      payload.webhookURL = webhookURL
    }
    if (hasNewSecret) {
      payload.signingSecret = signingSecret
    }
    // Nothing to save
    if (Object.keys(payload).length === 0) {
      showToast('Nothing to save', false)
      return
    }

    setSaving(true)
    try {
      const resp = await fetch('/api/settings/slack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) throw new Error(await resp.text())
      showToast('Settings saved', true)
      // Refresh
      const d = await fetch('/api/settings/slack').then(r => r.json())
      setSavedWebhook(d.webhookURL || '')
      setSavedSecret(d.signingSecret || '')
      setEnabled(d.enabled)

      // Reset edit mode
      setEditingWebhook(false)
      setEditingSecret(false)
      setWebhookURL('')
      setSigningSecret('')
    } catch (e: any) {
      showToast(`Error: ${e.message}`, false)
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings/slack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookURL: '', signingSecret: '' }),
      })
      setSavedWebhook('')
      setSavedSecret('')
      setWebhookURL('')
      setSigningSecret('')
      setEnabled(false)

      setEditingWebhook(false)
      setEditingSecret(false)
      showToast('Slack integration disabled', true)
    } catch (e: any) {
      showToast(`Error: ${e.message}`, false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 mx-4 w-full max-w-lg overflow-hidden rounded-2xl border border-hull-600 bg-hull-900 shadow-2xl shadow-black/60 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-hull-700/40 px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-white">Settings</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Configure integrations</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {toast && (
          <div className={`mx-5 mt-3 rounded-md border px-3 py-2 text-xs ${toast.ok ? 'border-green-900/40 bg-green-950/30 text-neon-green' : 'border-red-900/40 bg-red-950/30 text-neon-red'}`}>
            {toast.msg}
          </div>
        )}

        <div className="p-5 space-y-5">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
                <path d="M14.5 2c-.83 0-1.5.67-1.5 1.5V7h3.5c.83 0 1.5-.67 1.5-1.5S17.33 4 16.5 4H14.5V2z"/>
                <path d="M6 7.5C6 6.67 6.67 6 7.5 6H11v3.5c0 .83-.67 1.5-1.5 1.5S8 10.33 8 9.5V7.5z"/>
                <path d="M17 9.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V12h-3V9.5z"/>
                <path d="M9.5 22c.83 0 1.5-.67 1.5-1.5V17H7.5c-.83 0-1.5.67-1.5 1.5S6.67 20 7.5 20h2v2z"/>
              </svg>
              <h3 className="text-xs font-semibold text-white uppercase tracking-wider">Slack Notifications</h3>
              {enabled && (
                <span className="ml-auto rounded-full bg-neon-green/10 border border-neon-green/20 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-neon-green">Active</span>
              )}
            </div>
            <p className="text-[10px] text-gray-500 mb-1">Get notified in Slack when someone requests JIT access. Admins can approve or deny directly from Slack.</p>
            <p className="text-[9px] text-gray-600 mb-3">Alternatively, set <span className="font-mono text-gray-500">SLACK_WEBHOOK_URL</span> and <span className="font-mono text-gray-500">SLACK_SIGNING_SECRET</span> env vars.</p>

            {loading ? (
              <div className="flex justify-center py-4"><Spinner /></div>
            ) : (
              <div className="space-y-3">
                {/* Webhook URL */}
                <div>
                  <label className="block text-[10px] font-medium text-gray-400 mb-1">Webhook URL</label>
                  {savedWebhook && !editingWebhook ? (
                    <div className="flex items-center gap-2">
                      <span className="flex-1 rounded-lg border border-hull-600 bg-hull-800/50 px-3 py-2 text-xs text-gray-400 font-mono truncate">{savedWebhook}</span>
                      <button onClick={() => { setEditingWebhook(true); setWebhookURL('') }} className="shrink-0 rounded-lg border border-hull-600 bg-hull-800 px-3 py-1.5 text-[10px] font-medium text-gray-300 hover:bg-hull-700 transition-colors">Change</button>
                    </div>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={webhookURL}
                        onChange={e => onWebhookChange(e.target.value)}
                        placeholder="https://hooks.slack.com/services/..."
                        autoFocus={editingWebhook}
                        className="w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2 text-xs text-white placeholder-gray-600 outline-none focus:border-neon-cyan/50 focus:ring-1 focus:ring-neon-cyan/20 transition-colors"
                      />
                      {editingWebhook && (
                        <button onClick={() => { setEditingWebhook(false); setWebhookURL('') }} className="mt-1 text-[9px] text-gray-500 hover:text-gray-300">Cancel</button>
                      )}
                    </>
                  )}
                  <p className="text-[9px] text-gray-600 mt-1">Create at: Slack App → Incoming Webhooks → Add New Webhook</p>
                </div>

                {/* Signing Secret */}
                <div>
                  <label className="block text-[10px] font-medium text-gray-400 mb-1">Signing Secret <span className="text-gray-600">(optional — enables Approve/Deny buttons)</span></label>
                  {savedSecret && !editingSecret ? (
                    <div className="flex items-center gap-2">
                      <span className="flex-1 rounded-lg border border-hull-600 bg-hull-800/50 px-3 py-2 text-xs text-gray-400 font-mono">{savedSecret}</span>
                      <button onClick={() => { setEditingSecret(true); setSigningSecret('') }} className="shrink-0 rounded-lg border border-hull-600 bg-hull-800 px-3 py-1.5 text-[10px] font-medium text-gray-300 hover:bg-hull-700 transition-colors">Change</button>
                    </div>
                  ) : (
                    <>
                      <input
                        type="password"
                        value={signingSecret}
                        onChange={e => setSigningSecret(e.target.value)}
                        placeholder="your-signing-secret"
                        autoFocus={editingSecret}
                        className="w-full rounded-lg border border-hull-600 bg-hull-800 px-3 py-2 text-xs text-white placeholder-gray-600 outline-none focus:border-neon-cyan/50 focus:ring-1 focus:ring-neon-cyan/20 transition-colors"
                      />
                      {editingSecret && (
                        <button onClick={() => { setEditingSecret(false); setSigningSecret('') }} className="mt-1 text-[9px] text-gray-500 hover:text-gray-300">Cancel</button>
                      )}
                    </>
                  )}
                  <p className="text-[9px] text-gray-600 mt-1">Found in: Slack App → Basic Information → Signing Secret. Set Interactivity URL to <span className="font-mono text-gray-500">https://&lt;your-domain&gt;/api/slack/interact</span></p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  {hasNewWebhook && (
                    <button onClick={test} disabled={testing} className="rounded-lg border border-hull-600 bg-hull-800 px-4 py-1.5 text-[10px] font-medium text-gray-300 transition-colors hover:bg-hull-700 disabled:opacity-40">
                      {testing ? 'Testing...' : 'Test Connection'}
                    </button>
                  )}
                  {(hasNewWebhook || hasNewSecret) && (
                    <button onClick={save} disabled={saving} className="rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-1.5 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-40">
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  )}
                  {enabled && (
                    <button onClick={clear} className="ml-auto rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-1.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-900/20">
                      Disable
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
