import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Evt, PodDescribe } from '../../types'
import { useFetch, post } from '../../hooks/useFetch'
import { useAuth } from '../../context/AuthContext'
import { Spinner, StatusDot, ContainerStateBadge } from '../ui/Atoms'
import { MetricChart, useMetrics, METRIC_RANGES, YamlModal, refColor } from './WorkloadDetailView'
import { RestartTimeline } from '../ui/RestartTimeline'
import type { MetricsData, RefLine } from './WorkloadDetailView'
import { JITRequestModal } from '../modals/JITRequestModal'

// ─── Resource Bar ────────────────────────────────────────────────────

function ResourceBar({ used, req, lim, label, unit }: { used: number; req: number; lim: number; label: string; unit: string }) {
  const cap = lim || req || used || 1
  const usedPct = Math.min((used / cap) * 100, 100)
  const reqPct = req ? Math.min((req / cap) * 100, 100) : 0
  const overLim = lim > 0 && used >= lim
  const barColor = overLim ? 'bg-neon-red' : 'bg-neon-cyan'
  return (
    <div className="min-w-[80px]">
      <div className="flex justify-between text-[9px]">
        <span className="text-gray-500">{label}</span>
        <span className={`tabular-nums ${overLim ? 'text-neon-red' : 'text-gray-400'}`}>{used}{unit}</span>
      </div>
      <div className="relative mt-0.5 h-1.5 w-full rounded-full bg-hull-700">
        {reqPct > 0 && <div className="absolute top-0 h-full rounded-full bg-hull-600 opacity-40" style={{ width: `${reqPct}%` }} />}
        <div className={`absolute top-0 h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${usedPct}%` }} />
      </div>
      <div className="flex justify-between text-[8px] text-gray-600 mt-px">
        {req > 0 ? <span>req:{req}{unit}</span> : <span />}
        {lim > 0 ? <span>lim:{lim}{unit}</span> : <span />}
      </div>
    </div>
  )
}

// ─── AI Helpers ──────────────────────────────────────────────────────

function useAIStream() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async (url: string, body?: object) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setText('')
    setError(null)
    setLoading(true)

    try {
      const resp = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const err = await resp.text()
        try { setError(JSON.parse(err).error || err) } catch { setError(err) }
        setLoading(false)
        return
      }

      const reader = resp.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) { setError('No response stream'); setLoading(false); return }

      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.done) break
            if (parsed.text) setText(prev => prev + parsed.text)
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    }
    setLoading(false)
  }, [])

  const cancel = useCallback(() => { abortRef.current?.abort(); setLoading(false) }, [])

  return { text, loading, error, run, cancel }
}

function simpleMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => '<ul>' + m + '</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')

  html = html.replace(/(<br\/>)?\|(.+)\|(<br\/>)\|[-| ]+\|(<br\/>)([\s\S]*?)(?=<br\/><br\/>|<h|$)/g, (_, _pre, header, _br1, _br2, body) => {
    const headers = header.split('|').map((h: string) => `<th>${h.trim()}</th>`).join('')
    const rows = body.split('<br/>').filter((r: string) => r.includes('|')).map((row: string) => {
      const cells = row.split('|').map((c: string) => `<td>${c.trim()}</td>`).join('')
      return `<tr>${cells}</tr>`
    }).join('')
    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`
  })

  return html
}

function AIResponsePanel({ text, loading, error }: { text: string; loading: boolean; error: string | null }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [text])

  if (error) return <div className="rounded-lg bg-red-950/20 border border-red-900/30 p-3"><p className="text-neon-red text-xs">{error}</p></div>

  if (!text && loading) return (
    <div className="flex items-center gap-2 py-6 justify-center">
      <span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse" />
      <span className="text-[11px] text-gray-400">AI is analyzing...</span>
    </div>
  )

  if (!text && !loading) return null

  return (
    <div className="rounded-lg bg-hull-900/60 border border-hull-700/30 p-2.5 overflow-y-auto max-h-[40vh]">
      <div className="prose prose-invert prose-xs max-w-none text-[10px] leading-snug text-gray-300 [&_h1]:text-xs [&_h1]:text-white [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-0.5 [&_h2]:text-[11px] [&_h2]:text-white [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-0.5 [&_h3]:text-[10px] [&_h3]:text-gray-200 [&_h3]:font-bold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-0.5 [&_strong]:text-white [&_code]:text-neon-cyan [&_code]:bg-hull-800 [&_code]:px-1 [&_code]:rounded [&_code]:text-[9px] [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_li]:leading-snug [&_table]:text-[9px] [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_th]:text-gray-400 [&_th]:border-b [&_th]:border-hull-700 [&_td]:px-1.5 [&_td]:py-0.5 [&_td]:border-b [&_td]:border-hull-800">
        <div dangerouslySetInnerHTML={{ __html: simpleMarkdown(text) }} />
        {loading && <span className="inline-block h-2 w-8 bg-neon-cyan/30 rounded animate-pulse ml-1" />}
      </div>
      <div ref={endRef} />
    </div>
  )
}

function AIDiagnoseButton({ namespace, pod }: { namespace: string; pod: string }) {
  const ai = useAIStream()
  const [show, setShow] = useState(false)

  const diagnose = () => {
    setShow(true)
    ai.run('/api/ai/diagnose', { namespace, pod })
  }

  return (
    <>
      <button onClick={diagnose} disabled={ai.loading}
        className="rounded-lg border border-purple-500/30 bg-purple-950/20 px-2 py-0.5 text-[9px] font-bold text-purple-400 hover:bg-purple-950/40 disabled:opacity-30 transition-colors flex items-center gap-1">
        <span className="text-[10px]">✦</span> {ai.loading ? 'Diagnosing...' : 'AI Diagnose'}
      </button>
      {show && (ai.text || ai.loading || ai.error) && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">AI Diagnosis</span>
            <button onClick={() => setShow(false)} className="text-[9px] text-gray-600 hover:text-white">&times;</button>
          </div>
          <AIResponsePanel text={ai.text} loading={ai.loading} error={ai.error} />
        </div>
      )}
    </>
  )
}

// ─── Pod Metrics Panel ───────────────────────────────────────────────

type ContainerResources = { container: string; cpuReqM: number; cpuLimM: number; memReqMi: number; memLimMi: number }
type PodMetricsResponse = MetricsData & { resources?: ContainerResources[] }

export function PodMetricsPanel({ namespace, pod }: { namespace: string; pod: string }) {
  const [timeRange, setTimeRange] = useState('1h')
  const { data, loading, err } = useMetrics(`/api/metrics/pod?namespace=${encodeURIComponent(namespace)}&pod=${encodeURIComponent(pod)}`, timeRange)

  const podData = data as PodMetricsResponse | null
  const hasData = podData && Object.keys(podData).filter(k => k !== 'resources').length > 0

  const cpuRefLines = useMemo(() => {
    if (!podData?.resources) return []
    const lines: RefLine[] = []
    let totalReq = 0, totalLim = 0
    for (const r of podData.resources) {
      totalReq += r.cpuReqM || 0
      totalLim += r.cpuLimM || 0
    }
    if (totalReq > 0) lines.push({ value: totalReq, label: `req ${totalReq}m`, color: refColor.req })
    if (totalLim > 0) lines.push({ value: totalLim, label: `lim ${totalLim}m`, color: refColor.lim })
    return lines
  }, [podData?.resources])

  const memRefLines = useMemo(() => {
    if (!podData?.resources) return []
    const lines: RefLine[] = []
    let totalReq = 0, totalLim = 0
    for (const r of podData.resources) {
      totalReq += r.memReqMi || 0
      totalLim += r.memLimMi || 0
    }
    if (totalReq > 0) lines.push({ value: totalReq, label: `req ${totalReq > 1024 ? (totalReq/1024).toFixed(1)+'Gi' : Math.round(totalReq)+'Mi'}`, color: refColor.req })
    if (totalLim > 0) lines.push({ value: totalLim, label: `lim ${totalLim > 1024 ? (totalLim/1024).toFixed(1)+'Gi' : Math.round(totalLim)+'Mi'}`, color: refColor.lim })
    return lines
  }, [podData?.resources])

  return (
    <div className="rounded border border-hull-700 bg-hull-900">
      <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Metrics</span>
        <div className="flex gap-1">
          {METRIC_RANGES.map(r => (
            <button key={r} onClick={() => setTimeRange(r)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${timeRange === r ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-gray-600 hover:text-gray-400'}`}>{r}</button>
          ))}
        </div>
      </div>
      <div className="p-3 space-y-3">
        {loading && <div className="flex items-center justify-center py-6"><span className="inline-block h-2 w-2 rounded-full bg-neon-cyan animate-pulse mr-2" /><span className="text-[10px] text-gray-500">Loading metrics...</span></div>}
        {err && <p className="text-[10px] text-neon-amber text-center py-4">{err}</p>}
        {!loading && !err && !hasData && <p className="text-[10px] text-gray-500 text-center py-4">No metric data returned for this pod</p>}
        {hasData && (() => {
          const cpuSeries = podData.rr_cpu || podData.cpu
          const memSeries = podData.rr_memory || podData.memory
          const totalCpuReq = podData.resources?.reduce((a, r) => a + (r.cpuReqM || 0), 0) || 0
          const totalCpuLim = podData.resources?.reduce((a, r) => a + (r.cpuLimM || 0), 0) || 0
          const totalMemReq = podData.resources?.reduce((a, r) => a + (r.memReqMi || 0), 0) || 0
          const totalMemLim = podData.resources?.reduce((a, r) => a + (r.memLimMi || 0), 0) || 0
          const fmtMem = (v: number) => v > 1024 ? `${(v/1024).toFixed(1)} GiB` : `${Math.round(v)} MiB`
          const fmtCpu = (v: number) => v >= 1000 ? `${(v/1000).toFixed(1)} cores` : `${v}m`
          return (
          <>
            {podData.resources && podData.resources.length > 0 && (
              <div className="stat-card p-2.5">
                <div className="text-[9px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Container Resources</div>
                <div className="space-y-1">
                  {podData.resources.map(r => (
                    <div key={r.container} className="flex items-center gap-2 text-[9px] font-mono">
                      <span className="text-neon-cyan font-bold min-w-[80px] truncate">{r.container}</span>
                      <span className="text-gray-500">CPU:</span>
                      <span className="text-yellow-400">{r.cpuReqM ? fmtCpu(r.cpuReqM) : '—'} req</span>
                      <span className="text-gray-700">/</span>
                      <span className="text-red-400">{r.cpuLimM ? fmtCpu(r.cpuLimM) : '—'} lim</span>
                      <span className="text-gray-700 ml-2">|</span>
                      <span className="text-gray-500 ml-1">Mem:</span>
                      <span className="text-yellow-400">{r.memReqMi ? fmtMem(r.memReqMi) : '—'} req</span>
                      <span className="text-gray-700">/</span>
                      <span className="text-red-400">{r.memLimMi ? fmtMem(r.memLimMi) : '—'} lim</span>
                    </div>
                  ))}
                </div>
                {podData.resources.length > 1 && (
                  <div className="flex items-center gap-2 text-[9px] font-mono mt-1 pt-1 border-t border-hull-700">
                    <span className="text-gray-400 font-bold min-w-[80px]">Total</span>
                    <span className="text-gray-500">CPU:</span>
                    <span className="text-yellow-400">{totalCpuReq ? fmtCpu(totalCpuReq) : '—'}</span>
                    <span className="text-gray-700">/</span>
                    <span className="text-red-400">{totalCpuLim ? fmtCpu(totalCpuLim) : '—'}</span>
                    <span className="text-gray-700 ml-2">|</span>
                    <span className="text-gray-500 ml-1">Mem:</span>
                    <span className="text-yellow-400">{totalMemReq ? fmtMem(totalMemReq) : '—'}</span>
                    <span className="text-gray-700">/</span>
                    <span className="text-red-400">{totalMemLim ? fmtMem(totalMemLim) : '—'}</span>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {cpuSeries && <MetricChart title="CPU — actual usage vs request/limit" series={cpuSeries} unit="millicores" refLines={cpuRefLines} />}
              {memSeries && <MetricChart title="Memory — working set vs request/limit" series={memSeries} unit="MiB" refLines={memRefLines} />}
            </div>
            {(podData.rr_rss || podData.rr_cache) && (
              <div className="grid grid-cols-2 gap-3">
                {podData.rr_rss && <MetricChart title="Memory RSS (non-reclaimable physical memory)" series={podData.rr_rss} unit="MiB" height={90} />}
                {podData.rr_cache && <MetricChart title="Memory Cache (reclaimable page cache)" series={podData.rr_cache} unit="MiB" height={90} />}
              </div>
            )}
            {podData.throttle && podData.throttle.length > 0 && (
              <MetricChart title="CPU Throttling — % of time this pod is being throttled" series={podData.throttle} unit="%" height={90}
                refLines={[{ value: 25, label: '25% warn', color: refColor.warn }]} />
            )}
            <div className="grid grid-cols-2 gap-3">
              {podData.net_rx && <MetricChart title="Network In — bytes received per second" series={podData.net_rx} unit="bytes/s" height={90} />}
              {podData.net_tx && <MetricChart title="Network Out — bytes sent per second" series={podData.net_tx} unit="bytes/s" height={90} />}
            </div>
            {podData.restarts && podData.restarts.length > 0 && (
              <MetricChart title="Container Restarts — increasing = crash loop" series={podData.restarts} unit="" height={80} />
            )}
            <RestartTimeline namespace={namespace} pod={pod} />
          </>
          )
        })()}
      </div>
    </div>
  )
}

// ─── Pod Detail ──────────────────────────────────────────────────────

export function PodDetailView({ ns, name, onBack, onWorkload }: { ns: string; name: string; onBack: () => void; onWorkload?: (ns: string, name: string, kind: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [tab, setTab] = useState<'logs' | 'events' | 'info' | 'metrics'>('info')
  const [logs, setLogs] = useState<string[]>([])
  const [logStatus, setLogStatus] = useState<'connecting' | 'streaming' | 'ended' | 'error'>('connecting')
  const logEndRef = useRef<HTMLDivElement>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const { data: events } = useFetch<Evt[]>(`/api/pods/${ns}/${name}/events`, 15000)
  const { data: desc } = useFetch<PodDescribe>(`/api/pods/${ns}/${name}/describe`, 10000)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showShell, setShowShell] = useState(false)
  const [showYaml, setShowYaml] = useState(false)
  const [showJITModal, setShowJITModal] = useState(false)
  const [jitGranted, setJitGranted] = useState(false)
  const [jitPending, setJitPending] = useState(false)
  const [jitExpiresIn, setJitExpiresIn] = useState('')
  const [logContainer, setLogContainer] = useState('')
  const [logTail, setLogTail] = useState(300)
  const [logSearch, setLogSearch] = useState('')
  const [prevLogContainer, setPrevLogContainer] = useState<string | null>(null)
  const [prevLog, setPrevLog] = useState<string | null>(null)
  const [prevLogLoading, setPrevLogLoading] = useState(false)

  useEffect(() => {
    setLogs([])
    setLogStatus('connecting')
    const containerParam = logContainer ? `&container=${logContainer}` : ''
    const es = new EventSource(`/api/pods/${ns}/${name}/logs?tail=${logTail}&follow=true${containerParam}`)
    es.onmessage = (e) => {
      setLogs(prev => {
        const next = [...prev, e.data]
        return next.length > 5000 ? next.slice(-3000) : next
      })
      setLogStatus('streaming')
    }
    es.onerror = () => {
      setLogStatus(s => s === 'streaming' ? 'ended' : 'error')
      es.close()
    }
    return () => es.close()
  }, [ns, name, logContainer, logTail])

  useEffect(() => {
    if (autoScroll && tab === 'logs' && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, tab, autoScroll])

  const handleLogScroll = useCallback(() => {
    const el = logContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAutoScroll(atBottom)
  }, [])

  const prevJitState = useRef<{ pending: boolean; granted: boolean }>({ pending: false, granted: false })

  useEffect(() => {
    if (isAdmin) return
    const myOwnerKind = desc?.ownerKind || ''
    const myOwnerName = desc?.ownerName || ''
    const check = () => {
      fetch('/api/jit/my-grants').then(r => r.json()).then((grants: any[]) => {
        const grant = grants.find((g: any) => g.namespace === ns && g.ownerKind === myOwnerKind && g.ownerName === myOwnerName)
        if (grant && grant.expiresAt) {
          if (prevJitState.current.pending && !prevJitState.current.granted) {
            setToast('Access approved — shell is now available')
            setTimeout(() => setToast(null), 5000)
          }
          setJitGranted(true)
          setJitPending(false)
          const diff = new Date(grant.expiresAt).getTime() - Date.now()
          if (diff > 3600000) setJitExpiresIn(`${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`)
          else if (diff > 60000) setJitExpiresIn(`${Math.ceil(diff / 60000)}m`)
          else if (diff > 0) setJitExpiresIn(`${Math.ceil(diff / 1000)}s`)
          else { setJitGranted(false); setJitExpiresIn('') }
          prevJitState.current = { pending: false, granted: true }
        } else {
          setJitGranted(false)
          setJitExpiresIn('')
          prevJitState.current = { ...prevJitState.current, granted: false }
        }
      }).catch(() => {})
      fetch('/api/jit/requests').then(r => r.json()).then((reqs: any[]) => {
        const matchOwner = (r: any) => r.namespace === ns && r.ownerKind === myOwnerKind && r.ownerName === myOwnerName
        const hasPending = reqs.some((r: any) => matchOwner(r) && r.status === 'pending')
        if (prevJitState.current.pending && !hasPending && !jitGranted) {
          if (reqs.some((r: any) => matchOwner(r) && r.status === 'denied')) {
            setToast('Access request was denied')
            setTimeout(() => setToast(null), 5000)
          } else if (reqs.some((r: any) => matchOwner(r) && r.status === 'expired')) {
            setToast('Access request expired — no action taken within 48h')
            setTimeout(() => setToast(null), 5000)
          }
        }
        setJitPending(hasPending)
        prevJitState.current = { ...prevJitState.current, pending: hasPending }
      }).catch(() => {})
    }
    check()
    const id = setInterval(check, 15000)
    return () => clearInterval(id)
  }, [isAdmin, ns, desc?.ownerKind, desc?.ownerName])

  const deletePod = async () => {
    setDeleting(true)
    try {
      await post(`/api/pods/${ns}/${name}/delete`)
      setToast('Pod deleted')
      setTimeout(onBack, 1500)
    } catch (e: any) {
      setToast(`Error: ${e.message}`)
      setDeleting(false)
      setTimeout(() => setToast(null), 3000)
    }
  }

  const fetchPrevLog = async (container: string) => {
    setPrevLogContainer(container)
    setPrevLogLoading(true)
    setPrevLog(null)
    try {
      const r = await fetch(`/api/pods/${ns}/${name}/previous-logs?container=${container}`)
      if (!r.ok) throw new Error(await r.text())
      setPrevLog(await r.text())
    } catch (e: any) {
      setPrevLog(`Error: ${e.message}`)
    } finally { setPrevLogLoading(false) }
  }

  const tabs = ['info', 'logs', 'events', 'metrics'] as const
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showShell && <PodShell ns={ns} name={name} onClose={() => setShowShell(false)} />}
      {showYaml && <YamlModal kind="Pod" ns={ns} name={name} onClose={() => setShowYaml(false)} />}
      {showJITModal && <JITRequestModal ns={ns} pod={name} ownerKind={desc?.ownerKind} ownerName={desc?.ownerName} accessType="exec" onClose={() => setShowJITModal(false)} onSubmitted={() => { setShowJITModal(false); setJitPending(true) }} />}
      {toast && <div className={`border-b px-4 py-2 text-xs font-medium ${toast.includes('approved') ? 'border-green-900/40 bg-green-950/30 text-neon-green' : toast.includes('denied') ? 'border-red-900/40 bg-red-950/30 text-neon-red' : toast.includes('expired') ? 'border-amber-900/40 bg-amber-950/30 text-neon-amber' : 'border-hull-700 bg-hull-800 text-gray-300'}`}>{toast}</div>}
      <div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2">
        <button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{name}</p>
          <p className="text-[10px] text-gray-600">{ns}{desc ? ` · ${desc.status} · ${desc.node}` : ''}</p>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => setShowYaml(true)} className="rounded-md border border-hull-600 bg-hull-800 px-2.5 py-1 text-[10px] font-medium text-gray-300 hover:text-white hover:bg-hull-700 transition-colors">YAML</button>
        {isAdmin ? (
          <>
            <button onClick={() => setShowShell(true)} className="rounded-md border border-cyan-900/40 bg-cyan-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-cyan-900/30">Shell</button>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} className="rounded-md border border-red-900/40 bg-red-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-red transition-colors hover:bg-red-900/40">Delete</button>
            ) : (
              <>
                <button onClick={() => setConfirmDelete(false)} className="rounded-md border border-hull-600 bg-hull-800 px-2 py-1 text-[10px] text-gray-400">Cancel</button>
                <button onClick={deletePod} disabled={deleting} className="rounded-md border border-red-900/50 bg-red-950/60 px-2 py-1 text-[10px] font-bold text-neon-red transition-colors hover:bg-red-900/40 disabled:opacity-40">
                  {deleting ? '…' : 'Confirm'}
                </button>
              </>
            )}
          </>
        ) : jitGranted ? (
          <button onClick={() => setShowShell(true)} className="rounded-md border border-cyan-900/40 bg-cyan-950/40 px-2.5 py-1 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-cyan-900/30 flex items-center gap-1.5">
            Shell <span className="text-[9px] text-cyan-600">{jitExpiresIn}</span>
          </button>
        ) : jitPending ? (
          <span className="rounded-md border border-amber-900/40 bg-amber-950/30 px-2.5 py-1 text-[10px] font-medium text-amber-400">Pending Approval...</span>
        ) : (
          <button onClick={() => setShowJITModal(true)} className="rounded-md border border-amber-900/40 bg-amber-950/30 px-2.5 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/20">Request Shell Access</button>
        )}
        </div>
      </div>
      <div className="flex gap-1 border-b border-hull-700 bg-hull-900 px-4 py-1">
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${tab === t ? 'bg-hull-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'info' && desc && (
          <div className="space-y-3">
            {/* Summary row */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-hull-700 bg-hull-800 p-2">
                <p className="text-[9px] uppercase text-gray-600">Status</p>
                <p className={`text-sm font-bold ${desc.status === 'Running' ? 'text-neon-green' : desc.status === 'Pending' ? 'text-neon-amber' : 'text-neon-red'}`}>{desc.status}</p>
              </div>
              <div className="rounded-lg border border-hull-700 bg-hull-800 p-2">
                <p className="text-[9px] uppercase text-gray-600">QoS</p>
                <p className="text-sm font-bold text-gray-300">{desc.qos}</p>
              </div>
              <div className="rounded-lg border border-hull-700 bg-hull-800 p-2">
                <p className="text-[9px] uppercase text-gray-600">Age</p>
                <p className="text-sm font-bold text-gray-300">{desc.age}</p>
              </div>
            </div>
            {desc.ip && <p className="text-[10px] text-gray-600">Pod IP: <span className="font-mono text-gray-400">{desc.ip}</span></p>}

            {desc.ownerKind && desc.ownerName && (
              <div className="flex items-center gap-2 rounded-lg border border-hull-700 bg-hull-800/60 px-3 py-2">
                <span className="text-[10px] text-gray-500">Owned by</span>
                <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase ${desc.ownerKind === 'Deployment' ? 'bg-blue-950/30 text-blue-400 border-blue-900/30' : desc.ownerKind === 'StatefulSet' ? 'bg-purple-950/30 text-purple-400 border-purple-900/30' : desc.ownerKind === 'DaemonSet' ? 'bg-indigo-950/30 text-indigo-400 border-indigo-900/30' : desc.ownerKind === 'CronJob' ? 'bg-sky-950/30 text-sky-300 border-sky-900/30' : desc.ownerKind === 'Job' ? 'bg-sky-950/30 text-sky-400 border-sky-900/30' : 'bg-hull-700/50 text-gray-400 border-hull-600/50'}`}>{desc.ownerKind}</span>
                {onWorkload && ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job'].includes(desc.ownerKind) ? (
                  <button onClick={() => onWorkload(ns, desc.ownerName!, desc.ownerKind!)} className="text-[11px] font-medium text-neon-cyan hover:underline transition-colors">{desc.ownerName}</button>
                ) : (
                  <span className="text-[11px] font-medium text-gray-300">{desc.ownerName}</span>
                )}
              </div>
            )}

            {/* AI Diagnose */}
            {desc.status !== 'Running' && desc.status !== 'Completed' && desc.status !== 'Succeeded' && (
              <AIDiagnoseButton namespace={ns} pod={name} />
            )}

            {/* Containers */}
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Containers</h3>
            {desc.containers.map(ct => (
              <div key={ct.name} className="rounded-lg border border-hull-700 bg-hull-800 p-3">
                <div className="flex items-center gap-2">
                  <StatusDot ok={ct.ready} />
                  <span className="flex-1 truncate text-sm font-medium text-white">{ct.name}</span>
                  <ContainerStateBadge state={ct.state} reason={ct.reason} />
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{ct.image}</p>
                <div className="mt-1.5 flex flex-wrap gap-3 text-[10px]">
                  {ct.restarts > 0 && <span className="text-neon-amber">↻ {ct.restarts} restarts</span>}
                  {ct.message && <span className="truncate text-gray-500">{ct.message}</span>}
                </div>
                {/* Probes */}
                {(ct.livenessProbe || ct.readinessProbe || ct.startupProbe) && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="text-[9px] text-gray-600 uppercase tracking-wider mr-0.5">Probes</span>
                    {[{ label: 'Liveness', probe: ct.livenessProbe }, { label: 'Readiness', probe: ct.readinessProbe }, { label: 'Startup', probe: ct.startupProbe }].map(({ label, probe }) => probe ? (
                      <span key={label} title={`${label}: ${probe.type}${probe.path ? ' ' + probe.path : ''}${probe.port ? ':' + probe.port : ''}${probe.command ? ' ' + probe.command : ''} · every ${probe.periodSeconds}s · fail after ${probe.failureThreshold} attempts`}
                        className={`rounded border px-1.5 py-0.5 text-[9px] font-medium cursor-help ${ct.ready ? 'border-green-900/40 bg-green-950/30 text-neon-green' : 'border-amber-900/40 bg-amber-950/30 text-neon-amber'}`}>
                        {label} ✓
                      </span>
                    ) : (
                      <span key={label} className="rounded border border-hull-700 bg-hull-900/40 px-1.5 py-0.5 text-[9px] text-gray-700">{label}</span>
                    ))}
                  </div>
                )}
                {/* Restart Snapshot */}
                {ct.restarts > 0 && ct.lastTermReason && (
                  <div className="mt-2 rounded border border-hull-700 bg-hull-900/40 p-2 space-y-1">
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${ct.lastTermReason === 'OOMKilled' ? 'bg-red-950/50 text-neon-red border border-red-900/30' : 'bg-amber-950/50 text-neon-amber border border-amber-900/30'}`}>{ct.lastTermReason}</span>
                      {ct.lastTermExitCode !== undefined && <span className="text-gray-500 font-mono">exit {ct.lastTermExitCode}</span>}
                      {ct.lastTermAt && <span className="text-gray-600">{ct.lastTermAt}</span>}
                      <button onClick={() => fetchPrevLog(ct.name)} className="ml-auto rounded border border-hull-600 bg-hull-800 px-2 py-0.5 text-[9px] text-gray-400 hover:text-white transition-colors">Prev Log</button>
                    </div>
                    {ct.lastTermMessage && <p className="text-[10px] text-gray-500 truncate">{ct.lastTermMessage}</p>}
                    {prevLogContainer === ct.name && (
                      <div className="mt-1.5">
                        {prevLogLoading ? <Spinner /> : (
                          <pre className="max-h-[200px] overflow-auto rounded bg-hull-950 border border-hull-700/30 p-2 font-mono text-[10px] text-gray-400 whitespace-pre-wrap">{prevLog || 'No previous logs'}</pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {(ct.cpuUsedM > 0 || ct.memUsedMi > 0 || ct.cpuReqM > 0 || ct.memReqMi > 0) && (
                  <div className="mt-2.5 grid grid-cols-2 gap-3">
                    <ResourceBar used={ct.cpuUsedM} req={ct.cpuReqM} lim={ct.cpuLimM} label="CPU" unit="m" />
                    <ResourceBar used={ct.memUsedMi} req={ct.memReqMi} lim={ct.memLimMi} label="MEM" unit="Mi" />
                  </div>
                )}
              </div>
            ))}

            {/* Init Containers */}
            {desc.initContainers && desc.initContainers.length > 0 && (
              <>
                <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Init Containers</h3>
                {desc.initContainers.map(ct => (
                  <div key={ct.name} className="rounded-lg border border-hull-700 bg-hull-800 p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={ct.state === 'terminated' && ct.reason !== 'Error'} />
                      <span className="flex-1 truncate text-sm font-medium text-white">{ct.name}</span>
                      <span className="rounded bg-amber-950/40 border border-amber-900/30 px-1.5 py-0.5 text-[8px] font-bold uppercase text-amber-400">init</span>
                      <ContainerStateBadge state={ct.state} reason={ct.reason} />
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{ct.image}</p>
                    {ct.restarts > 0 && <p className="mt-1 text-[10px] text-neon-amber">↻ {ct.restarts} restarts</p>}
                    {ct.message && <p className="mt-0.5 text-[10px] text-gray-500 truncate">{ct.message}</p>}
                  </div>
                ))}
              </>
            )}

            {/* Conditions */}
            {desc.conditions.length > 0 && (
              <>
                <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Conditions</h3>
                <div className="space-y-1">
                  {desc.conditions.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.status === 'True' ? 'bg-neon-green' : 'bg-neon-red'}`} />
                      <span className="text-gray-400">{c.type}</span>
                      <span className="text-gray-600">{c.status}</span>
                      {c.reason && <span className="text-gray-600">({c.reason})</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {tab === 'info' && !desc && <Spinner />}
        {tab === 'logs' && (() => {
          const errorRe = /\b(ERROR|FATAL|PANIC|Exception)\b/i
          const warnRe = /\b(WARN|WARNING)\b/i
          const searchLower = logSearch.toLowerCase()
          const filtered = logSearch ? logs.filter(l => l.toLowerCase().includes(searchLower)) : logs
          const highlightLine = (line: string) => {
            if (!logSearch) return line
            const idx = line.toLowerCase().indexOf(searchLower)
            if (idx === -1) return line
            const before = line.slice(0, idx)
            const match = line.slice(idx, idx + logSearch.length)
            const after = line.slice(idx + logSearch.length)
            return <>{before}<mark>{match}</mark>{after}</>
          }
          return (
          <div className="relative">
            <div className="flex items-center justify-between mb-2 px-1 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${logStatus === 'streaming' ? 'bg-neon-green animate-pulse' : logStatus === 'connecting' ? 'bg-neon-amber animate-pulse' : logStatus === 'ended' ? 'bg-gray-600' : 'bg-neon-red'}`} />
                <span className="text-[10px] text-gray-600 uppercase tracking-wider">{logStatus === 'streaming' ? 'Live' : logStatus === 'connecting' ? 'Connecting…' : logStatus === 'ended' ? 'Stream ended' : 'Error'}</span>
                <span className="text-[10px] text-gray-700">{logSearch ? `${filtered.length}/${logs.length}` : logs.length} lines</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <input value={logSearch} onChange={e => setLogSearch(e.target.value)} placeholder="Search logs…"
                    className="w-36 sm:w-48 rounded-lg border border-hull-600 bg-hull-800 pl-6 pr-2 py-0.5 text-[10px] text-gray-300 placeholder-gray-700 outline-none focus:border-neon-cyan/40" />
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-600">⌕</span>
                  {logSearch && <button onClick={() => setLogSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-600 hover:text-gray-300">✕</button>}
                </div>
                <select value={logTail} onChange={e => setLogTail(Number(e.target.value))} className="rounded-lg border border-hull-600 bg-hull-800 px-2 py-0.5 text-[10px] text-gray-300 outline-none">
                  <option value={100}>100 lines</option>
                  <option value={300}>300 lines</option>
                  <option value={1000}>1k lines</option>
                </select>
                {desc && ((desc.initContainers?.length ?? 0) > 0 || desc.containers.length > 1) && (
                  <select value={logContainer} onChange={e => setLogContainer(e.target.value)} className="rounded-lg border border-hull-600 bg-hull-800 px-2 py-0.5 text-[10px] text-gray-300 outline-none">
                    <option value="">All containers</option>
                    {desc.initContainers?.map(c => (
                      <option key={`init-${c.name}`} value={c.name}>[init] {c.name}</option>
                    ))}
                    {desc.containers.map(c => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                )}
                <button onClick={() => setAutoScroll(!autoScroll)} className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${autoScroll ? 'border-neon-cyan/30 text-neon-cyan bg-neon-cyan/5' : 'border-hull-600 text-gray-500 hover:text-gray-300'}`}>
                  {autoScroll ? '⬇ Auto-scroll' : '⬇ Scroll paused'}
                </button>
              </div>
            </div>
            <div ref={logContainerRef} onScroll={handleLogScroll} className="max-h-[60vh] overflow-y-auto rounded-lg bg-hull-950 border border-hull-700/30 p-2 scrollbar-hide">
              {filtered.length > 0 ? (
                <div className="font-mono text-[11px] leading-relaxed">
                  {filtered.map((line, i) => {
                    const levelClass = errorRe.test(line) ? 'text-neon-red/90 log-line-error' : warnRe.test(line) ? 'text-neon-amber/90 log-line-warn' : 'text-gray-400'
                    return <div key={i} className={`whitespace-pre-wrap ${levelClass}${logSearch ? ' log-line-match' : ''}`}>{highlightLine(line)}</div>
                  })}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-gray-400">{logStatus === 'connecting' ? 'Connecting to log stream…' : logSearch ? 'No matching lines' : 'No logs available'}</pre>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
          )
        })()}
        {tab === 'events' && (
          <div className="space-y-1.5">
            {events?.length === 0 && <p className="text-xs text-gray-600">No events</p>}
            {events?.map((e, i) => (
              <div key={i} className="rounded border border-hull-700 bg-hull-800 p-2 text-[11px]">
                <div className="flex gap-2">
                  <span className={e.type === 'Warning' ? 'text-neon-amber' : 'text-neon-green'}>{e.type}</span>
                  <span className="font-medium text-white">{e.reason}</span>
                  <span className="text-gray-600">{e.age} · ×{e.count}</span>
                </div>
                <p className="mt-0.5 text-gray-500">{e.message}</p>
              </div>
            ))}
          </div>
        )}
        {tab === 'metrics' && <PodMetricsPanel namespace={ns} pod={name} />}
      </div>
    </div>
  )
}

// ─── Pod Shell ───────────────────────────────────────────────────────

export function PodShell({ ns, name, container, onClose }: { ns: string; name: string; container?: string; onClose: () => void }) {
  const termRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let term: any = null
    let fitAddon: any = null
    let disposed = false

    const init = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      if (disposed || !termRef.current) return

      const isNotion = document.documentElement.getAttribute('data-theme') === 'notion'
      term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
        theme: isNotion ? {
          background: '#f8fafc',
          foreground: '#18181b',
          cursor: '#2563eb',
          selectionBackground: '#dbeafe',
          black: '#18181b', red: '#be123c', green: '#059669', yellow: '#b45309',
          blue: '#2563eb', magenta: '#7c3aed', cyan: '#0369a1', white: '#f8fafc',
        } : {
          background: '#0a0e14',
          foreground: '#c5c8c6',
          cursor: '#06d6e0',
          selectionBackground: '#2a4858',
          black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
          blue: '#81a2be', magenta: '#b294bb', cyan: '#06d6e0', white: '#c5c8c6',
        },
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(termRef.current)
      fitAddon.fit()

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const params = new URLSearchParams({ namespace: ns, pod: name })
      if (container) params.set('container', container)
      const ws = new WebSocket(`${proto}//${window.location.host}/api/exec?${params}`)
      wsRef.current = ws

      ws.onopen = () => {
        term.write('\r\n\x1b[36mConnected to pod shell\x1b[0m\r\n\r\n')
      }
      ws.onmessage = (e) => {
        term.write(e.data)
      }
      ws.onclose = () => {
        term.write('\r\n\x1b[33mSession closed\x1b[0m\r\n')
      }
      ws.onerror = () => {
        term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n')
      }

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data)
      })

      const resizeOb = new ResizeObserver(() => { if (fitAddon) fitAddon.fit() })
      resizeOb.observe(termRef.current)
    }

    init()

    return () => {
      disposed = true
      if (wsRef.current) wsRef.current.close()
      if (term) term.dispose()
    }
  }, [ns, name, container])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-hull-950/95 backdrop-blur-sm pt-safe">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-hull-700/40">
        <div className="min-w-0">
          <p className="text-xs font-bold text-white truncate">Shell: {name}</p>
          <p className="text-[10px] text-gray-500">{ns}{container ? ` / ${container}` : ''}</p>
        </div>
        <button onClick={onClose} className="rounded-lg bg-red-950/40 border border-red-900/20 px-3 py-1 text-[11px] font-medium text-red-400 hover:bg-red-950/60 transition-colors">Close</button>
      </div>
      <div ref={termRef} className="flex-1 p-1" />
    </div>
  )
}
