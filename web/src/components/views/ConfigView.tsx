import { useState, useMemo } from 'react'
import type { ConfigItem, ConfigDataResp } from '../../types'
import { useFetch } from '../../hooks/useFetch'
import { Spinner } from '../ui/Atoms'
import { YamlModal } from '../modals/YamlModal'

type DriftEntry = { kind: string; name: string; namespace: string; lastModified: string; modifiedAgo: string; driftedPods: { name: string; namespace: string; startedAgo: string; workload: string }[]; totalPods: number; driftedCount: number }

export function ConfigDataPanel({ item, onClose }: { item: ConfigItem; onClose: () => void }) {
  const kind = item.kind === 'Secret' ? 'secret' : 'configmap'
  const { data, err, loading } = useFetch<ConfigDataResp>(`/api/configs/${item.namespace}/${item.name}?kind=${kind}`)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const toggleReveal = (key: string) => {
    setRevealedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const copyValue = (key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    })
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <button onClick={onClose} className="text-neon-cyan text-xs hover:underline">← Back</button>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold border ${item.kind === 'Secret' ? 'bg-amber-950/40 border-amber-900/30 text-amber-400' : 'bg-sky-950/40 border-sky-900/30 text-sky-400'}`}>
          {item.kind === 'Secret' ? 'SEC' : 'CM'}
        </span>
        <span className="text-sm font-bold text-white font-mono truncate">{item.name}</span>
        <span className="text-[10px] text-gray-500">{item.namespace}</span>
      </div>

      {loading && <Spinner />}
      {err && <p className="text-neon-red text-xs">{err}</p>}
      {data && (
        <div className="space-y-1.5">
          {data.masked && (
            <div className="rounded-lg bg-amber-950/20 border border-amber-900/30 px-2.5 py-1.5">
              <span className="text-[10px] text-amber-400">Secret values are hidden for non-admin users</span>
            </div>
          )}
          {data.entries.length === 0 ? (
            <p className="text-gray-500 text-[11px] italic py-4 text-center">No data entries</p>
          ) : data.entries.map(e => (
            <div key={e.key} className="stat-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-[11px] font-mono font-medium text-neon-cyan truncate min-w-0 flex-1">{e.key}</span>
                <div className="flex gap-1 shrink-0">
                  {data.masked ? (
                    <span className="text-[10px] text-gray-600 font-mono">••••••••</span>
                  ) : (
                    <>
                      {item.kind === 'Secret' && (
                        <button onClick={() => toggleReveal(e.key)} className="rounded px-1.5 py-0.5 text-[9px] border border-hull-600/50 text-gray-400 hover:text-white hover:border-hull-500 transition-colors">
                          {revealedKeys.has(e.key) ? 'Hide' : 'Reveal'}
                        </button>
                      )}
                      <button onClick={() => copyValue(e.key, e.value)} className="rounded px-1.5 py-0.5 text-[9px] border border-hull-600/50 text-gray-400 hover:text-neon-green hover:border-green-900/50 transition-colors">
                        {copiedKey === e.key ? '✓' : 'Copy'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {(!data.masked && (item.kind !== 'Secret' || revealedKeys.has(e.key))) && (
                <div className="border-t border-hull-700/30 bg-hull-900/50 px-3 py-2">
                  <pre className="text-[10px] font-mono text-gray-300 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{e.value}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ConfigView({ namespace }: { namespace: string }) {
  const q = namespace ? `?namespace=${namespace}` : ''
  const { data, err, loading } = useFetch<ConfigItem[]>(`/api/configs${q}`, 15000)
  const { data: driftData } = useFetch<DriftEntry[]>(`/api/config-drift${q}`, 30000)
  const [kindFilter, setKindFilter] = useState<'' | 'ConfigMap' | 'Secret'>('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [viewing, setViewing] = useState<ConfigItem | null>(null)
  const [yamlTarget, setYamlTarget] = useState<{ kind: string; ns: string; name: string } | null>(null)

  const driftMap = useMemo(() => {
    const m = new Map<string, DriftEntry>()
    if (driftData) driftData.forEach(d => m.set(`${d.kind}-${d.namespace}-${d.name}`, d))
    return m
  }, [driftData])

  if (viewing) return <ConfigDataPanel item={viewing} onClose={() => setViewing(null)} />

  if (loading) return <Spinner />
  if (err) return <p className="p-4 text-neon-red">{err}</p>

  const all = data ?? []
  const filtered = all.filter(c =>
    (kindFilter === '' || c.kind === kindFilter) &&
    (search === '' || c.name.toLowerCase().includes(search.toLowerCase()) || c.namespace.toLowerCase().includes(search.toLowerCase()))
  )
  const cmCount = all.filter(c => c.kind === 'ConfigMap').length
  const secCount = all.filter(c => c.kind === 'Secret').length
  const driftCount = driftMap.size

  return (
    <div className="space-y-2 p-3">
      {yamlTarget && <YamlModal kind={yamlTarget.kind} ns={yamlTarget.ns} name={yamlTarget.name} onClose={() => setYamlTarget(null)} />}
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="rounded bg-indigo-950/60 border border-indigo-900/50 px-2 py-0.5 text-indigo-400 font-bold tracking-wide">⚙ CONFIG</span>
        {driftCount > 0 && <span className="rounded bg-amber-950/50 border border-amber-900/30 px-2 py-0.5 text-neon-amber font-bold text-[10px]">{driftCount} drifted</span>}
        <div className="flex gap-1">
          <button onClick={() => setKindFilter('')} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium border transition-colors ${kindFilter === '' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>All ({all.length})</button>
          <button onClick={() => setKindFilter(kindFilter === 'ConfigMap' ? '' : 'ConfigMap')} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium border transition-colors ${kindFilter === 'ConfigMap' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>CM ({cmCount})</button>
          <button onClick={() => setKindFilter(kindFilter === 'Secret' ? '' : 'Secret')} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium border transition-colors ${kindFilter === 'Secret' ? 'bg-hull-700 text-white border-hull-600' : 'text-gray-500 border-hull-800 hover:text-gray-300'}`}>Sec ({secCount})</button>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter..." className="ml-auto rounded-lg border border-hull-600/50 bg-hull-800/60 px-2 py-0.5 text-[11px] text-gray-300 outline-none w-28 placeholder:text-gray-700" />
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-3xl mb-2 opacity-40">⚙</span>
          <p className="text-gray-500 text-sm">No configs found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map(c => {
            const key = `${c.kind}-${c.namespace}-${c.name}`
            const isExpanded = expanded === key
            const drift = driftMap.get(key)
            return (
              <div key={key} className={`stat-card overflow-hidden ${drift ? 'ring-1 ring-amber-900/30' : ''}`}>
                <div className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-hull-800/40 transition-colors" onClick={() => setExpanded(isExpanded ? null : key)}>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold border ${c.kind === 'Secret' ? 'bg-amber-950/40 border-amber-900/30 text-amber-400' : 'bg-sky-950/40 border-sky-900/30 text-sky-400'}`}>
                    {c.kind === 'Secret' ? 'SEC' : 'CM'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-white">{c.name}</span>
                    <span className="text-[10px] text-gray-500">{c.namespace}</span>
                  </div>
                  {drift && (
                    <span className="shrink-0 rounded border border-amber-900/30 bg-amber-950/40 px-1.5 py-0.5 text-[9px] font-medium text-neon-amber" title={`Modified ${drift.modifiedAgo} ago — ${drift.driftedCount} of ${drift.totalPods} pods running stale data`}>
                      {drift.driftedCount} pod{drift.driftedCount !== 1 ? 's' : ''} stale
                    </span>
                  )}
                  <div className="text-right shrink-0">
                    <span className="text-[11px] tabular-nums text-gray-400">{c.keyCount} key{c.keyCount !== 1 ? 's' : ''}</span>
                    <span className="block text-[9px] text-gray-600">{c.age}</span>
                    <span className="block text-[9px] text-gray-600">modified {c.modifiedAgo} ago</span>
                  </div>
                  <span className={`text-gray-600 text-[10px] transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▸</span>
                </div>
                {isExpanded && (
                  <div className="border-t border-hull-700/30 bg-hull-900/40 px-3 py-2 space-y-2">
                    {drift && (
                      <div className="rounded-lg border border-amber-900/30 bg-amber-950/20 px-3 py-2">
                        <p className="text-[10px] font-bold text-neon-amber mb-1.5">Drift Detected — modified {drift.modifiedAgo} ago, {drift.driftedCount}/{drift.totalPods} pods stale</p>
                        <div className="space-y-1">
                          {drift.driftedPods.map(dp => (
                            <div key={dp.name} className="flex items-center gap-2 text-[10px]">
                              <span className="h-1.5 w-1.5 rounded-full bg-neon-amber shrink-0" />
                              <span className="font-mono text-gray-300 truncate">{dp.name}</span>
                              {dp.workload && <span className="text-gray-600 text-[9px]">{dp.workload}</span>}
                              <span className="text-gray-600 text-[9px] ml-auto shrink-0">started {dp.startedAgo} ago</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {c.type && <p className="text-[10px] text-gray-500">Type: <span className="text-gray-400 font-mono">{c.type}</span></p>}
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-gray-500">Keys:</p>
                      <div className="flex gap-1.5">
                        <button onClick={(e) => { e.stopPropagation(); setYamlTarget({ kind: c.kind, ns: c.namespace, name: c.name }) }} className="rounded-lg px-2 py-0.5 text-[9px] font-medium border border-hull-600 text-gray-400 hover:text-white transition-colors">YAML</button>
                        <button onClick={(e) => { e.stopPropagation(); setViewing(c) }} className="rounded-lg px-2 py-0.5 text-[9px] font-medium border border-neon-cyan/30 text-neon-cyan hover:bg-cyan-950/30 transition-colors">
                          View Data
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.keys.length === 0 ? <span className="text-[10px] text-gray-600 italic">empty</span> : c.keys.map(k => (
                        <span key={k} className="rounded bg-hull-800 border border-hull-700/50 px-1.5 py-0.5 text-[10px] font-mono text-gray-300">{k}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
