import { useState } from 'react'
import type { NodeDescData } from '../../types'
import { useFetch, post } from '../../hooks/useFetch'
import { useAuth } from '../../context/AuthContext'
import { Btn, Spinner } from '../ui/Atoms'
import { K9sBar } from '../ui/K9sBar'
import { MetricChart, METRIC_RANGES, seriesLastVal, fmtBytes } from '../ui/MetricChart'
import { useMetrics } from '../../hooks/useMetrics'
import { DrainWizardModal } from '../modals/DrainWizardModal'
import { DrainBgBanner, useDrainBg } from '../../hooks/useDrainBg'

type PodUsageEntry = { name: string; namespace: string; cpuUsedM: number; memUsedMi: number; cpuReqM: number; cpuLimM: number; memReqMi: number; memLimMi: number; status: string; ready: string; age: string }
type PodUsageData = { node: { allocCpuM: number; allocMemMi: number }; pods: PodUsageEntry[]; pressure: { cpuPct: number; memPct: number } }

export function NodePodHeatmap({ nodeName, highlightPod, onPod }: { nodeName: string; highlightPod?: string; onPod: (ns: string, name: string) => void }) {
  const { data, loading } = useFetch<PodUsageData>(nodeName ? `/api/nodes/${encodeURIComponent(nodeName)}/pod-usage` : null, 15000)

  if (!nodeName || loading || !data) return null
  const { node, pods, pressure } = data
  if (pods.length === 0) return null

  const pressureColor = (pct: number) => pct > 85 ? 'text-neon-red' : pct > 70 ? 'text-neon-amber' : 'text-neon-green'
  const pressureBarBg = (pct: number) => pct > 85 ? 'bg-neon-red' : pct > 70 ? 'bg-neon-amber' : 'bg-neon-green'

  const heatBg = (used: number, alloc: number) => {
    if (alloc <= 0) return ''
    const pct = (used / alloc) * 100
    if (pct > 40) return 'bg-red-950/50 text-red-300'
    if (pct > 20) return 'bg-amber-950/40 text-amber-300'
    if (pct > 5) return 'bg-emerald-950/30 text-emerald-300'
    return 'text-gray-400'
  }

  return (
    <div className="rounded border border-hull-700 bg-hull-900 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hull-700 bg-hull-800 px-2 py-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Pods</span>
        <span className="text-[10px] text-gray-500">({pods.length})</span>
        <div className="ml-auto flex items-center gap-3 text-[10px]">
          <span className={pressureColor(pressure.cpuPct)}>CPU {pressure.cpuPct}%</span>
          <span className={pressureColor(pressure.memPct)}>MEM {pressure.memPct}%</span>
        </div>
      </div>
      <div className="p-2 space-y-2">
          {(pressure.cpuPct > 80 || pressure.memPct > 85) && (
            <div className="rounded-lg border border-amber-900/30 bg-amber-950/20 px-3 py-1.5 text-[10px] text-neon-amber font-medium">
              {pressure.cpuPct > 80 && pressure.memPct > 85
                ? 'High CPU and Memory pressure — contention likely'
                : pressure.cpuPct > 80 ? 'High CPU pressure — pods may be throttled' : 'High Memory pressure — OOM risk'}
            </div>
          )}
          <div className="flex gap-2">
            <div className="flex-1 rounded bg-hull-800 p-2">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-gray-500">CPU</span>
                <span className={pressureColor(pressure.cpuPct)}>{pressure.cpuPct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-hull-700 overflow-hidden">
                <div className={`h-full rounded-full transition-all ${pressureBarBg(pressure.cpuPct)}`} style={{ width: `${Math.min(pressure.cpuPct, 100)}%` }} />
              </div>
            </div>
            <div className="flex-1 rounded bg-hull-800 p-2">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-gray-500">Memory</span>
                <span className={pressureColor(pressure.memPct)}>{pressure.memPct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-hull-700 overflow-hidden">
                <div className={`h-full rounded-full transition-all ${pressureBarBg(pressure.memPct)}`} style={{ width: `${Math.min(pressure.memPct, 100)}%` }} />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-gray-500 border-b border-hull-700">
                  <th className="text-left py-1 px-1.5 font-medium">Pod</th>
                  <th className="text-left py-1 px-1.5 font-medium">Namespace</th>
                  <th className="text-left py-1 px-1.5 font-medium">Status</th>
                  <th className="text-right py-1 px-1.5 font-medium">CPU Used</th>
                  <th className="text-right py-1 px-1.5 font-medium">MEM Used</th>
                  <th className="text-right py-1 px-1.5 font-medium">CPU Req/Lim</th>
                  <th className="text-right py-1 px-1.5 font-medium">MEM Req/Lim</th>
                  <th className="text-left py-1 px-1.5 font-medium">Ready</th>
                  <th className="text-left py-1 px-1.5 font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {pods.map(p => {
                  const isHighlight = highlightPod === p.name
                  return (
                    <tr key={`${p.namespace}/${p.name}`}
                      onClick={() => onPod(p.namespace, p.name)}
                      className={`border-b border-hull-800 cursor-pointer transition-colors hover:bg-hull-800 ${isHighlight ? 'ring-1 ring-blue-500/50 bg-blue-950/20' : ''}`}>
                      <td className="py-1.5 px-1.5 font-mono text-white truncate max-w-[200px]">
                        {isHighlight && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 mr-1.5 shrink-0" />}
                        {p.name}
                      </td>
                      <td className="py-1.5 px-1.5 text-gray-500 truncate max-w-[120px]">{p.namespace}</td>
                      <td className={`py-1.5 px-1.5 ${p.status === 'Running' ? 'text-neon-green' : p.status === 'Pending' ? 'text-neon-amber' : p.status === 'Terminating' ? 'text-gray-500' : 'text-neon-red'}`}>{p.status}</td>
                      <td className={`py-1.5 px-1.5 text-right font-mono rounded ${heatBg(p.cpuUsedM, node.allocCpuM)}`}>{p.cpuUsedM}m</td>
                      <td className={`py-1.5 px-1.5 text-right font-mono rounded ${heatBg(p.memUsedMi, node.allocMemMi)}`}>{p.memUsedMi}Mi</td>
                      <td className="py-1.5 px-1.5 text-right text-gray-600 font-mono">{p.cpuReqM || '-'}/{p.cpuLimM || '-'}</td>
                      <td className="py-1.5 px-1.5 text-right text-gray-600 font-mono">{p.memReqMi || '-'}/{p.memLimMi || '-'}</td>
                      <td className="py-1.5 px-1.5 text-gray-400">{p.ready}</td>
                      <td className="py-1.5 px-1.5 text-gray-600">{p.age}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
    </div>
  )
}

function NodeMetricsPanel({ nodeName }: { nodeName: string }) {
  const [timeRange, setTimeRange] = useState('1h')
  const { data, loading, err } = useMetrics(`/api/metrics/node?node=${encodeURIComponent(nodeName)}`, timeRange)

  if (loading) return <div className="rounded border border-hull-700 bg-hull-900 p-3 text-center"><Spinner /></div>
  if (err) return (
    <div className="rounded border border-hull-700 bg-hull-900 overflow-hidden">
      <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Metrics</span>
      </div>
      <p className="text-[10px] text-neon-amber text-center py-4">{err}</p>
    </div>
  )
  if (!data || Object.keys(data).length === 0) return null

  return (
    <div className="rounded border border-hull-700 bg-hull-900 overflow-hidden">
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
        <div className="grid grid-cols-2 gap-3">
          {data.cpu && <MetricChart title="CPU Usage %" series={data.cpu} unit="%" />}
          {data.memory && <MetricChart title="Memory Usage %" series={data.memory} unit="%" />}
        </div>
        {data.fs_used && <MetricChart title="Filesystem Usage %" series={data.fs_used} unit="%" height={90} />}
        <div className="grid grid-cols-2 gap-3">
          {(data.rr_cpu_used || data.cpu_used) && <MetricChart title="CPU — pod usage (cores)" series={data.rr_cpu_used || data.cpu_used} unit="cores"
            refLines={[
              ...(data.cpu_capacity ? [{ value: seriesLastVal(data.cpu_capacity), label: 'capacity', color: '#ef4444' }] : []),
              ...((data.rr_cpu_requests || data.cpu_requests) ? [{ value: seriesLastVal(data.rr_cpu_requests || data.cpu_requests), label: 'requests', color: '#f59e0b' }] : []),
              ...((data.rr_cpu_limits || data.cpu_limits) ? [{ value: seriesLastVal(data.rr_cpu_limits || data.cpu_limits), label: 'limits', color: '#a78bfa' }] : []),
            ]} />}
          {(data.rr_mem_used || data.mem_used) && <MetricChart title="Memory — pod working set" series={data.rr_mem_used || data.mem_used} unit="bytes"
            refLines={[
              ...(data.mem_capacity ? [{ value: seriesLastVal(data.mem_capacity), label: `capacity ${fmtBytes(seriesLastVal(data.mem_capacity))}`, color: '#ef4444' }] : []),
              ...((data.rr_mem_requests || data.mem_requests) ? [{ value: seriesLastVal(data.rr_mem_requests || data.mem_requests), label: `requests ${fmtBytes(seriesLastVal(data.rr_mem_requests || data.mem_requests))}`, color: '#f59e0b' }] : []),
              ...((data.rr_mem_limits || data.mem_limits) ? [{ value: seriesLastVal(data.rr_mem_limits || data.mem_limits), label: `limits ${fmtBytes(seriesLastVal(data.rr_mem_limits || data.mem_limits))}`, color: '#a78bfa' }] : []),
            ]} />}
        </div>
        {(data.rr_mem_rss || data.mem_rss || data.rr_mem_cache || data.mem_cache) && (
          <div className="grid grid-cols-2 gap-3">
            {(data.rr_mem_rss || data.mem_rss) && <MetricChart title="Memory RSS" series={data.rr_mem_rss || data.mem_rss} unit="bytes" height={90} />}
            {(data.rr_mem_cache || data.mem_cache) && <MetricChart title="Memory Cache" series={data.rr_mem_cache || data.mem_cache} unit="bytes" height={90} />}
          </div>
        )}
      </div>
    </div>
  )
}

export function NodeDescribeView({ name, onBack, onPod }: { name: string; onBack: () => void; onPod: (ns: string, name: string) => void }) {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const { data, err, loading, refetch } = useFetch<NodeDescData>(`/api/nodes/${name}/describe`)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showDrainWizard, setShowDrainWizard] = useState(false)
  const drainBg = useDrainBg()

  const act = async (action: string) => {
    setBusy(action)
    try { await post(`/api/nodes/${name}/${action}`); setToast(`${name} ${action}ed`); refetch() }
    catch (e: any) { setToast(`Error: ${e.message}`) }
    finally { setBusy(null); setTimeout(() => setToast(null), 3000) }
  }

  if (loading) return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2"><button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button><p className="text-sm font-medium text-white">{name}</p></div><Spinner /></div>
  if (err) return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2"><button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button></div><p className="p-4 text-neon-red">{err}</p></div>
  if (!data) return null

  const statusColor = data.status.includes('NotReady') ? 'text-neon-red' : data.status.includes('SchedulingDisabled') ? 'text-neon-amber' : 'text-neon-green'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toast && <div className="border-b border-hull-700 bg-hull-800 px-4 py-2 text-xs text-gray-300">{toast}</div>}
      <div className="flex items-center gap-2 border-b border-hull-700 bg-hull-900 px-4 py-2">
        <button onClick={onBack} className="rounded bg-hull-700 px-2 py-1 text-xs text-gray-400 hover:text-white">←</button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{data.name}</p>
          <p className="text-[10px] text-gray-600">{data.role} · {data.version} · {data.age}</p>
        </div>
        {isAdmin && <div className="flex gap-1.5">
          {data.cordoned ? (
            <Btn small variant="success" onClick={() => act('uncordon')} disabled={!!busy}>{busy === 'uncordon' ? '…' : 'Uncordon'}</Btn>
          ) : (
            <>
              <Btn small onClick={() => act('cordon')} disabled={!!busy}>{busy === 'cordon' ? '…' : 'Cordon'}</Btn>
              <Btn small variant="danger" onClick={() => setShowDrainWizard(true)}>Drain</Btn>
            </>
          )}
        </div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
        {/* Status + Resources */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Status</div>
          <div className="p-3 font-mono text-[11px] space-y-1.5">
            <div className="flex gap-4">
              <span className="text-gray-500 w-16 shrink-0">Status</span>
              <span className={statusColor}>{data.status}</span>
            </div>
            {data.addresses.map((a, i) => (
              <div key={i} className="flex gap-4">
                <span className="text-gray-500 w-16 shrink-0">{a.type}</span>
                <span className="text-gray-300">{a.address}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Resource usage */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Resources</div>
          <div className="p-3 space-y-2">
            <div className="font-mono text-[11px]">
              <div className="flex items-center gap-3">
                <span className="text-gray-500 w-10">CPU</span>
                <div className="flex-1"><K9sBar pct={data.cpuPercent} /></div>
                <span className={`tabular-nums ${data.cpuPercent > 80 ? 'text-neon-red' : data.cpuPercent > 50 ? 'text-neon-amber' : 'text-gray-400'}`}>{data.cpuPercent}%</span>
                <span className="text-gray-600">{data.usedCpuM}m / {data.allocCpuM}m</span>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-gray-500 w-10">MEM</span>
                <div className="flex-1"><K9sBar pct={data.memPercent} /></div>
                <span className={`tabular-nums ${data.memPercent > 80 ? 'text-neon-red' : data.memPercent > 50 ? 'text-neon-amber' : 'text-gray-400'}`}>{data.memPercent}%</span>
                <span className="text-gray-600">{data.usedMemMi}Mi / {data.allocMemMi}Mi</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-[10px] mt-2 border-t border-hull-700 pt-2">
              <div>
                <p className="text-gray-600 uppercase">Capacity</p>
                <p className="text-gray-400">CPU: {data.capacity.cpu}</p>
                <p className="text-gray-400">Mem: {data.capacity.memory}</p>
                <p className="text-gray-400">Pods: {data.capacity.pods}</p>
              </div>
              <div>
                <p className="text-gray-600 uppercase">Allocatable</p>
                <p className="text-gray-400">CPU: {data.allocatable.cpu}</p>
                <p className="text-gray-400">Mem: {data.allocatable.memory}</p>
                <p className="text-gray-400">Pods: {data.allocatable.pods}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Metrics graphs */}
        <NodeMetricsPanel nodeName={data.name} />

        {/* Conditions */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Conditions</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px] font-mono text-[11px]">
              <thead>
                <tr className="border-b border-hull-700 text-left text-[10px] uppercase text-gray-500">
                  <th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 font-medium">Age</th>
                  <th className="px-2 py-1 font-medium">Reason</th>
                  <th className="px-2 py-1 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {data.conditions.map((c, i) => (
                  <tr key={i} className="border-b border-hull-800 last:border-0">
                    <td className="whitespace-nowrap px-2 py-1 text-gray-400">{c.type}</td>
                    <td className={`whitespace-nowrap px-2 py-1 ${c.status === 'True' && c.type === 'Ready' ? 'text-neon-green' : c.status === 'True' ? 'text-neon-amber' : 'text-gray-500'}`}>{c.status}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-600">{c.age}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-500">{c.reason}</td>
                    <td className="px-2 py-1 text-gray-600 truncate max-w-[200px]">{c.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Events */}
        {data.events && data.events.length > 0 && (
          <div className="rounded border border-hull-700 bg-hull-900">
            <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan flex items-center justify-between">
              <span>Events <span className="font-normal text-gray-600">({data.events.length})</span></span>
              {data.events.some(e => e.type === 'Warning') && <span className="text-neon-amber font-normal normal-case tracking-normal text-[9px]">⚠ has warnings</span>}
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full min-w-[600px] font-mono text-[11px]">
                <thead className="sticky top-0 bg-hull-900 z-10">
                  <tr className="border-b border-hull-700 text-left text-[10px] uppercase text-gray-500">
                    <th className="px-2 py-1 font-medium w-12">Type</th>
                    <th className="px-2 py-1 font-medium">Reason</th>
                    <th className="px-2 py-1 font-medium w-16">Age</th>
                    <th className="px-2 py-1 font-medium">From</th>
                    <th className="px-2 py-1 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e, i) => (
                    <tr key={i} className="border-b border-hull-800 last:border-0">
                      <td className={`whitespace-nowrap px-2 py-1.5 font-bold ${e.type === 'Warning' ? 'text-neon-amber' : 'text-gray-500'}`}>{e.type === 'Warning' ? '⚠' : '●'}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 font-medium ${e.type === 'Warning' ? 'text-neon-amber' : 'text-gray-400'}`}>{e.reason}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-gray-500">{e.age}{e.count > 1 ? ` (x${e.count})` : ''}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-gray-600">{e.from}</td>
                      <td className="px-2 py-1.5 text-gray-400 break-words">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Pods on node (with resource usage heatmap) */}
        <NodePodHeatmap nodeName={data.name} onPod={(pns, pname) => onPod(pns, pname)} />

        {/* Taints */}
        {data.taints.length > 0 && (
          <div className="rounded border border-hull-700 bg-hull-900">
            <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Taints <span className="font-normal text-gray-600">({data.taints.length})</span></div>
            <div className="p-2 space-y-1">
              {data.taints.map((t, i) => (
                <div key={i} className="font-mono text-[11px]">
                  <span className="text-gray-400">{t.key}</span>
                  {t.value && <span className="text-gray-500">={t.value}</span>}
                  <span className="text-neon-amber">:{t.effect}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* System Info */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">System Info</div>
          <div className="p-2 font-mono text-[11px] space-y-0.5">
            {Object.entries({
              'OS': data.systemInfo.osImage,
              'Arch': data.systemInfo.arch,
              'Kernel': data.systemInfo.kernel,
              'Runtime': data.systemInfo.containerRuntime,
              'Kubelet': data.systemInfo.kubelet,
            }).map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <span className="text-gray-500 w-16 shrink-0">{k}</span>
                <span className="text-gray-400">{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Labels */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Labels <span className="font-normal text-gray-600">({Object.keys(data.labels).length})</span></div>
          <div className="p-2 space-y-0.5 max-h-40 overflow-auto">
            {Object.entries(data.labels).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => (
              <div key={k} className="font-mono text-[10px]">
                <span className="text-gray-500">{k}</span><span className="text-gray-600">=</span><span className="text-gray-400">{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Images */}
        <div className="rounded border border-hull-700 bg-hull-900">
          <div className="border-b border-hull-700 bg-hull-800 px-2 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-neon-cyan">Images <span className="font-normal text-gray-600">({data.images.length})</span></div>
          <div className="p-2 space-y-0.5 max-h-48 overflow-auto">
            {data.images.map((img, i) => (
              <div key={i} className="flex justify-between font-mono text-[10px]">
                <span className="truncate text-gray-400">{img.names[0]}</span>
                <span className="shrink-0 text-gray-600 ml-2">{img.size}Mi</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {drainBg.bg && <DrainBgBanner bg={drainBg.bg} onDismiss={drainBg.dismiss} />}
      {showDrainWizard && <DrainWizardModal nodeName={name} onClose={() => setShowDrainWizard(false)} onDrained={() => { refetch(); setToast(`${name} drain complete`) }} onBackground={(total: number) => { drainBg.start(name, total); setShowDrainWizard(false) }} />}
    </div>
  )
}
