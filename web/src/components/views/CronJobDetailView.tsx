import { useState } from 'react'
import { useFetch, post } from '../../hooks/useFetch'
import { useAuth } from '../../context/AuthContext'
import { JITRequestModal } from '../modals/JITRequestModal'
import { Pill, Spinner } from '../ui/Atoms'

type CronJobRun = { name: string; startTime: string | null; endTime: string | null; durationS: number; status: string; succeeded: number; failed: number; active: number }
type CronJobHistory = { name: string; namespace: string; schedule: string; suspended: boolean; lastSchedule: string | null; activeCount: number; runs: CronJobRun[] }
type JITGrant = { namespace: string; ownerKind: string; ownerName: string; status: string; expiresAt: string | null }

export function CronJobDetailView({ ns, name, onBack, onPod }: { ns: string; name: string; onBack: () => void; onPod: (ns: string, name: string) => void }) {
  const { data, err, loading, refetch } = useFetch<CronJobHistory>(`/api/cronjobs/${name}?namespace=${ns}`, 10000)
  const { role } = useAuth()
  const { data: grants } = useFetch<JITGrant[]>(role === 'viewer' ? '/api/jit/my-grants' : null)

  const [triggerLoading, setTriggerLoading] = useState(false)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [showJITModal, setShowJITModal] = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void onPod

  const hasGrant = role === 'admin' || (grants ?? []).some(
    g => g.ownerKind === 'CronJob' && g.ownerName === name && g.namespace === ns
  )
  const canTrigger = role === 'admin' || hasGrant

  const handleTrigger = async () => {
    setTriggerLoading(true)
    setTriggerError(null)
    try {
      await post(`/api/cronjobs/${ns}/${name}/trigger`)
      refetch()
    } catch (e: unknown) {
      setTriggerError(e instanceof Error ? e.message : String(e))
    } finally {
      setTriggerLoading(false)
    }
  }

  if (loading) return <div className="p-4"><Spinner /></div>
  if (err) return <div className="p-4"><button onClick={onBack} className="text-neon-cyan text-xs mb-2">← Back</button><p className="text-neon-red">{err}</p></div>
  if (!data) return null

  const succeeded = data.runs.filter(r => r.status === 'succeeded').length
  const failed = data.runs.filter(r => r.status === 'failed').length
  const running = data.runs.filter(r => r.status === 'running').length

  const statusBadge = (s: string) =>
    s === 'succeeded' ? 'bg-green-950/50 text-neon-green border border-green-900/40' :
    s === 'failed' ? 'bg-red-950/50 text-neon-red border border-red-900/40' :
    s === 'running' ? 'bg-blue-950/50 text-neon-blue border border-blue-900/40' :
    'bg-hull-800 text-gray-400 border border-hull-700/50'

  const fmtDuration = (s: number) => {
    if (s <= 0) return '—'
    if (s < 60) return `${Math.round(s)}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  return (
    <div className="p-4 space-y-3">
      {showJITModal && (
        <JITRequestModal
          ns={ns}
          pod=""
          ownerKind="CronJob"
          ownerName={name}
          onClose={() => setShowJITModal(false)}
          onSubmitted={() => setShowJITModal(false)}
        />
      )}

      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-neon-cyan text-xs hover:underline">← Back</button>
        <Pill color="border bg-sky-950/30 text-sky-300 border-sky-900/30">CRONJOB</Pill>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-white">{data.name}</h2>
          <p className="text-[10px] text-gray-500">{data.namespace}</p>
        </div>
        <div className="flex items-center gap-2">
          {triggerError && <span className="text-[10px] text-neon-red">{triggerError}</span>}
          {canTrigger ? (
            <button
              onClick={handleTrigger}
              disabled={triggerLoading}
              className="rounded-lg bg-gradient-to-r from-neon-cyan/20 to-neon-green/10 border border-neon-cyan/30 px-3 py-1.5 text-[11px] font-semibold text-neon-cyan transition-all hover:shadow-[0_0_12px_rgba(6,214,224,0.15)] disabled:opacity-40"
            >
              {triggerLoading ? 'Running…' : '▶ Run Now'}
            </button>
          ) : (
            <button
              onClick={() => setShowJITModal(true)}
              className="rounded-md border border-amber-900/40 bg-amber-950/30 px-2.5 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/20"
            >
              Request Access
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="stat-card p-2.5 text-center">
          <p className="text-sm font-bold text-neon-cyan font-mono">{data.schedule}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Schedule</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className={`text-lg font-extrabold tabular-nums ${data.suspended ? 'text-neon-amber' : 'text-neon-green'}`}>{data.suspended ? 'Yes' : 'No'}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Suspended</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-neon-blue tabular-nums">{data.activeCount}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Active Jobs</p>
        </div>
        <div className="stat-card p-2.5 text-center">
          <p className="text-lg font-extrabold text-white tabular-nums">{data.runs.length}</p>
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Total Runs</p>
        </div>
      </div>

      {data.lastSchedule && (
        <p className="text-[10px] text-gray-500">Last scheduled: <span className="text-gray-300">{new Date(data.lastSchedule).toLocaleString()}</span></p>
      )}

      <div className="flex gap-3 text-[10px]">
        <span className="text-neon-green font-medium">{succeeded} succeeded</span>
        <span className="text-neon-red font-medium">{failed} failed</span>
        <span className="text-neon-blue font-medium">{running} running</span>
      </div>

      {data.runs.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No execution history yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500 text-left border-b border-hull-700/30">
                <th className="pb-1.5 pr-3 font-medium">Job</th>
                <th className="pb-1.5 pr-3 font-medium">Started</th>
                <th className="pb-1.5 pr-3 font-medium">Duration</th>
                <th className="pb-1.5 pr-3 font-medium">Status</th>
                <th className="pb-1.5 pr-3 font-medium text-right">Pods</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map(run => (
                <tr key={run.name} className="border-b border-hull-800/40 hover:bg-hull-800/30 transition-colors">
                  <td className="py-1.5 pr-3 font-mono text-gray-300 truncate max-w-[200px]">{run.name}</td>
                  <td className="py-1.5 pr-3 text-gray-400">{run.startTime ? new Date(run.startTime).toLocaleString() : '—'}</td>
                  <td className="py-1.5 pr-3 text-gray-400 tabular-nums">{fmtDuration(run.durationS)}</td>
                  <td className="py-1.5 pr-3"><span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${statusBadge(run.status)}`}>{run.status}</span></td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {run.succeeded > 0 && <span className="text-neon-green">{run.succeeded}✓</span>}
                    {run.failed > 0 && <span className="text-neon-red ml-1">{run.failed}✗</span>}
                    {run.active > 0 && <span className="text-neon-blue ml-1">{run.active}⟳</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
