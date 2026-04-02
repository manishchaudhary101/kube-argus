import { useState, Fragment } from 'react'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'
import { YamlModal } from '../modals/YamlModal'

type PVCEntry = { name: string; namespace: string; status: string; volumeName: string; storageClass: string; capacity: string; accessModes: string[]; age: string; workload?: { kind: string; name: string } }
type PVEntry = { name: string; status: string; capacity: string; reclaimPolicy: string; storageClass: string; claimRef: string; age: string; source: string }
type SCEntry = { name: string; provisioner: string; reclaimPolicy: string; bindingMode: string; isDefault: boolean }
type StorageData = { pvcs: PVCEntry[]; pvs: PVEntry[]; storageClasses: SCEntry[] }

export function PVCsView({ namespace }: { namespace: string }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<StorageData>(`/api/storage${q}`, 15000)
  const [expandedPVC, setExpandedPVC] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<'pvcs' | 'pvs' | 'scs'>('pvcs')
  const [showYaml, setShowYaml] = useState<{ kind: string; ns: string; name: string } | null>(null)

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>
  if (!data) return null

  const pvcs = data.pvcs || []
  const pvs = data.pvs || []
  const scs = data.storageClasses || []

  const pvcBound = pvcs.filter(p => p.status === 'Bound').length
  const pvcPending = pvcs.filter(p => p.status === 'Pending').length
  const pvcLost = pvcs.filter(p => p.status === 'Lost').length
  const pvAvail = pvs.filter(p => p.status === 'Available').length
  const pvReleased = pvs.filter(p => p.status === 'Released').length

  const statusColor = (s: string) => {
    switch (s) {
      case 'Bound': return 'text-neon-green'
      case 'Pending': return 'text-neon-amber'
      case 'Available': return 'text-neon-cyan'
      case 'Released': return 'text-gray-400'
      case 'Lost': case 'Failed': return 'text-neon-red'
      default: return 'text-gray-500'
    }
  }
  const statusBg = (s: string) => {
    switch (s) {
      case 'Bound': return 'bg-green-950/40 border-green-900/30'
      case 'Pending': return 'bg-amber-950/40 border-amber-900/30'
      case 'Available': return 'bg-cyan-950/40 border-cyan-900/30'
      case 'Released': return 'bg-hull-800/40 border-hull-700/30'
      case 'Lost': case 'Failed': return 'bg-red-950/40 border-red-900/30'
      default: return 'bg-hull-800/40 border-hull-700/30'
    }
  }

  const sortedPVCs = [...pvcs].sort((a, b) => {
    const order: Record<string, number> = { Pending: 0, Lost: 1, Bound: 2 }
    return (order[a.status] ?? 3) - (order[b.status] ?? 3)
  })

  const pvByName: Record<string, PVEntry> = {}
  pvs.forEach(pv => { pvByName[pv.name] = pv })

  return (
    <div className="space-y-2.5 p-3">
      {showYaml && <YamlModal kind={showYaml.kind} ns={showYaml.ns} name={showYaml.name} onClose={() => setShowYaml(null)} />}

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 text-[11px]">
        <button onClick={() => setSubTab('pvcs')} className={`rounded-lg px-3 py-1 font-medium border transition-colors ${subTab === 'pvcs' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>
          PVCs <span className="ml-1 tabular-nums text-[10px]">({pvcs.length})</span>
          {(pvcPending > 0 || pvcLost > 0) && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-neon-amber" />}
        </button>
        <button onClick={() => setSubTab('pvs')} className={`rounded-lg px-3 py-1 font-medium border transition-colors ${subTab === 'pvs' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>
          PVs <span className="ml-1 tabular-nums text-[10px]">({pvs.length})</span>
          {(pvAvail + pvReleased > 0) && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />}
        </button>
        <button onClick={() => setSubTab('scs')} className={`rounded-lg px-3 py-1 font-medium border transition-colors ${subTab === 'scs' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>
          Storage Classes <span className="ml-1 tabular-nums text-[10px]">({scs.length})</span>
        </button>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-gray-600">
          <span><span className="text-neon-green font-bold tabular-nums">{pvcBound}</span> bound</span>
          {pvcPending > 0 && <span><span className="text-neon-amber font-bold tabular-nums">{pvcPending}</span> pending</span>}
          {pvcLost > 0 && <span><span className="text-neon-red font-bold tabular-nums">{pvcLost}</span> lost</span>}
          {(pvAvail + pvReleased > 0) && <span><span className="text-gray-400 font-bold tabular-nums">{pvAvail + pvReleased}</span> orphaned PVs</span>}
        </div>
      </div>

      {/* PVCs Tab */}
      {subTab === 'pvcs' && (
        <div className="stat-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-hull-700/40 text-left text-[9px] text-gray-600 uppercase tracking-wider">
                  <th className="px-3 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Namespace</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Capacity</th>
                  <th className="px-2 py-1.5">StorageClass</th>
                  <th className="px-2 py-1.5">Access</th>
                  <th className="px-2 py-1.5">Workload</th>
                  <th className="px-2 py-1.5">Age</th>
                </tr>
              </thead>
              <tbody>
                {sortedPVCs.map(pvc => {
                  const isExpanded = expandedPVC === `${pvc.namespace}/${pvc.name}`
                  const boundPV = pvc.volumeName ? pvByName[pvc.volumeName] : undefined
                  return (
                    <Fragment key={`${pvc.namespace}/${pvc.name}`}>
                      <tr onClick={() => setExpandedPVC(isExpanded ? null : `${pvc.namespace}/${pvc.name}`)}
                        className={`border-b border-hull-800/40 cursor-pointer transition-colors hover:bg-hull-800/30 ${pvc.status === 'Pending' ? 'bg-amber-950/10' : pvc.status === 'Lost' ? 'bg-red-950/10' : ''}`}>
                        <td className="px-3 py-2 font-mono text-white truncate max-w-[200px]">{pvc.name}</td>
                        <td className="px-2 py-2 text-gray-500">{pvc.namespace}</td>
                        <td className="px-2 py-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${statusBg(pvc.status)} ${statusColor(pvc.status)}`}>{pvc.status}</span>
                        </td>
                        <td className="px-2 py-2 text-gray-400 font-mono">{pvc.capacity || '—'}</td>
                        <td className="px-2 py-2 text-gray-500 truncate max-w-[120px]">{pvc.storageClass || '—'}</td>
                        <td className="px-2 py-2 text-gray-600 text-[9px]">{pvc.accessModes?.join(', ') || '—'}</td>
                        <td className="px-2 py-2 text-gray-400">{pvc.workload ? `${pvc.workload.kind}/${pvc.workload.name}` : <span className="text-gray-700">—</span>}</td>
                        <td className="px-2 py-2 text-gray-600">{pvc.age}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} className="px-3 py-3 bg-hull-900/40">
                            <div className="grid grid-cols-2 gap-3 text-[10px]">
                              <div>
                                <p className="text-gray-600 uppercase tracking-wider text-[8px] mb-1">Volume</p>
                                <p className="font-mono text-gray-300">{pvc.volumeName || 'unbound'}</p>
                              </div>
                              {boundPV && (
                                <>
                                  <div>
                                    <p className="text-gray-600 uppercase tracking-wider text-[8px] mb-1">Source</p>
                                    <p className="text-gray-300">{boundPV.source}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-600 uppercase tracking-wider text-[8px] mb-1">Reclaim Policy</p>
                                    <p className="text-gray-300">{boundPV.reclaimPolicy}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-600 uppercase tracking-wider text-[8px] mb-1">PV Status</p>
                                    <p className={statusColor(boundPV.status)}>{boundPV.status}</p>
                                  </div>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {sortedPVCs.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-600 text-xs">No PersistentVolumeClaims found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PVs Tab */}
      {subTab === 'pvs' && (
        <div className="stat-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-hull-700/40 text-left text-[9px] text-gray-600 uppercase tracking-wider">
                  <th className="px-3 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Capacity</th>
                  <th className="px-2 py-1.5">Reclaim</th>
                  <th className="px-2 py-1.5">StorageClass</th>
                  <th className="px-2 py-1.5">Claim</th>
                  <th className="px-2 py-1.5">Source</th>
                  <th className="px-2 py-1.5">Age</th>
                </tr>
              </thead>
              <tbody>
                {pvs.map(pv => (
                  <tr key={pv.name} className={`border-b border-hull-800/40 ${pv.status === 'Available' || pv.status === 'Released' ? 'bg-hull-800/20' : ''}`}>
                    <td className="px-3 py-2 font-mono text-white truncate max-w-[200px]">{pv.name}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${statusBg(pv.status)} ${statusColor(pv.status)}`}>{pv.status}</span>
                    </td>
                    <td className="px-2 py-2 text-gray-400 font-mono">{pv.capacity}</td>
                    <td className="px-2 py-2 text-gray-500">{pv.reclaimPolicy}</td>
                    <td className="px-2 py-2 text-gray-500 truncate max-w-[120px]">{pv.storageClass || '—'}</td>
                    <td className="px-2 py-2 text-gray-400 font-mono truncate max-w-[200px]">{pv.claimRef || <span className="text-gray-700 italic">orphaned</span>}</td>
                    <td className="px-2 py-2 text-gray-500">{pv.source}</td>
                    <td className="px-2 py-2 text-gray-600">{pv.age}</td>
                  </tr>
                ))}
                {pvs.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-600 text-xs">No PersistentVolumes found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Storage Classes Tab */}
      {subTab === 'scs' && (
        <div className="space-y-1.5">
          {scs.map(sc => (
            <div key={sc.name} className="stat-card flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-white font-medium">{sc.name}</span>
                  {sc.isDefault && <span className="rounded border border-neon-cyan/30 bg-cyan-950/30 px-1.5 py-0.5 text-[8px] font-bold text-neon-cyan">DEFAULT</span>}
                </div>
                <p className="text-[9px] text-gray-500 mt-0.5">{sc.provisioner}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[9px] text-gray-500">Reclaim: <span className="text-gray-400">{sc.reclaimPolicy}</span></p>
                <p className="text-[9px] text-gray-500">Binding: <span className="text-gray-400">{sc.bindingMode}</span></p>
              </div>
            </div>
          ))}
          {scs.length === 0 && <p className="text-center text-gray-600 text-xs py-6">No StorageClasses found</p>}
        </div>
      )}
    </div>
  )
}
