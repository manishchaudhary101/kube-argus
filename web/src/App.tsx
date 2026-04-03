import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import type { UserInfo, SearchResult } from './types'
import { AuthCtx } from './context/AuthContext'
import { useFetch } from './hooks/useFetch'
import { Spinner, UserAvatar } from './components/ui/Atoms'
import { SearchModal } from './components/modals/SearchModal'
import { AuditTrailModal } from './components/modals/AuditTrailModal'
import { OnlineUsersModal } from './components/modals/OnlineUsersModal'
import { InfoPopover } from './components/modals/InfoPopover'
import { UserMenuDropdown } from './layout/UserMenuDropdown'
import { NamespacePicker } from './layout/NamespacePicker'
import { TABS, parseRoute } from './routing'
import type { TabId } from './routing'

import { OverviewView } from './components/views/OverviewView'
import { NodesView } from './components/views/NodesView'
import { WorkloadsView } from './components/views/WorkloadsView'
import { WorkloadDetailView } from './components/views/WorkloadDetailView'
import { PodsView } from './components/views/PodsView'
import { PodDetailView } from './components/views/PodDetailView'
import { NodeDescribeView } from './components/views/NodeDescribeView'
import { ServicesView } from './components/views/ServicesView'
import { IngressesView } from './components/views/IngressesView'
import { IngressDetailView } from './components/views/IngressesView'
import { EventsView } from './components/views/EventsView'
import { TroubledPodsView } from './components/views/TroubledPodsView'
import { SpotInterruptionsView } from './components/views/SpotInterruptionsView'
import { PodResilienceView } from './components/views/SpotInterruptionsView'
import { TopologySpreadView } from './components/views/TopologySpreadView'
import { HPAView } from './components/views/HPAView'
import { ConfigView } from './components/views/ConfigView'
import { PVCsView } from './components/views/PVCsView'
import { SpotAdvisorView } from './components/views/SpotAdvisorView'
import { CronJobDetailView } from './components/views/CronJobDetailView'

function App() {
  const initial = parseRoute()
  const [tab, setTabRaw] = useState<TabId>(initial.tab)
  const [ns, setNs] = useState('')
  const [workloadKind, setWorkloadKind] = useState('')
  const [podTarget, setPodTargetRaw] = useState<{ ns: string; name: string } | null>(initial.pod)
  const [nodeTarget, setNodeTargetRaw] = useState<string | null>(initial.node)
  const [ingressTarget, setIngressTargetRaw] = useState<{ ns: string; name: string } | null>(initial.ingress)
  const [workloadTarget, setWorkloadTargetRaw] = useState<{ ns: string; name: string; kind: string } | null>(initial.workload)
  const [showSearch, setShowSearch] = useState(false)
  const [sideOpen, setSideOpen] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const [showOnlineUsers, setShowOnlineUsers] = useState(false)
  const [troubledSub, setTroubledSub] = useState<'pods' | 'spot' | 'resilience'>('pods')
  const [troubledExpanded, setTroubledExpanded] = useState(false)
  const [spotHiddenReasons, setSpotHiddenReasons] = useState<string[]>([])
  const [nodePool, setNodePoolRaw] = useState(initial.nodePool)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authModeHint, setAuthModeHint] = useState<string>('none')
  const { data: namespaces } = useFetch<string[]>('/api/namespaces')
  const { data: clusterInfo } = useFetch<{ name: string }>('/api/cluster-info')

  const pushUrl = useCallback((path: string) => {
    if (window.location.pathname + window.location.search !== path) window.history.pushState(null, '', path)
  }, [])

  const nodesUrl = useCallback((pool?: string) => {
    const p = pool ?? nodePool
    return p ? `/nodes?pool=${encodeURIComponent(p)}` : '/nodes'
  }, [nodePool])

  const workloadUrl = useCallback((wt: { ns: string; name: string; kind: string }) => {
    return `/workloads/${wt.kind.toLowerCase()}/${wt.ns}/${wt.name}`
  }, [])

  const tabUrl = useCallback((t: string) => {
    if (t === 'overview') return '/'
    if (t === 'nodes') return nodesUrl()
    return `/${t}`
  }, [nodesUrl])

  const setTab = useCallback((t: TabId) => {
    setTabRaw(t)
    setPodTargetRaw(null)
    setNodeTargetRaw(null)
    setIngressTargetRaw(null)
    setWorkloadTargetRaw(null)
    if (t !== 'nodes') setNodePoolRaw('')
    pushUrl(tabUrl(t))
  }, [pushUrl, tabUrl])

  const setNodePool = useCallback((pool: string) => {
    setNodePoolRaw(pool)
    pushUrl(pool ? `/nodes?pool=${encodeURIComponent(pool)}` : '/nodes')
  }, [pushUrl])

  const setPodTarget = useCallback((v: { ns: string; name: string } | null) => {
    setPodTargetRaw(v)
    if (v) {
      pushUrl(`/pods/${v.ns}/${v.name}`)
    } else {
      if (nodeTarget) pushUrl(`/nodes/${nodeTarget}`)
      else if (workloadTarget) pushUrl(workloadUrl(workloadTarget))
      else pushUrl(tabUrl(tab))
    }
  }, [pushUrl, tab, nodeTarget, workloadTarget, workloadUrl, tabUrl])

  const setNodeTarget = useCallback((v: string | null) => {
    setNodeTargetRaw(v)
    if (v) pushUrl(`/nodes/${v}`)
    else pushUrl(tabUrl(tab))
  }, [pushUrl, tab, tabUrl])

  const setIngressTarget = useCallback((v: { ns: string; name: string } | null) => {
    setIngressTargetRaw(v)
    if (v) pushUrl(`/ingress/${v.ns}/${v.name}`)
    else pushUrl('/ingress')
  }, [pushUrl])

  const setWorkloadTarget = useCallback((v: { ns: string; name: string; kind: string } | null) => {
    setWorkloadTargetRaw(v)
    if (v) pushUrl(workloadUrl(v))
    else pushUrl(tabUrl(tab))
  }, [pushUrl, tab, workloadUrl, tabUrl])

  useEffect(() => {
    const onPop = () => {
      const r = parseRoute()
      setTabRaw(r.tab)
      setPodTargetRaw(r.pod)
      setNodeTargetRaw(r.node)
      setIngressTargetRaw(r.ingress)
      setWorkloadTargetRaw(r.workload)
      setNodePoolRaw(r.nodePool)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    fetch('/api/me').then(async r => {
      if (r.status === 401) {
        const body = await r.json().catch(() => ({}))
        setAuthModeHint(body.authMode || 'oidc')
        setUser(null); setAuthLoading(false); return null
      }
      return r.json()
    }).then(d => { if (d) { setUser(d); setAuthModeHint(d.authMode || 'none'); setAuthLoading(false) } }).catch(() => { setUser({ email: 'anonymous', role: 'viewer', authMode: 'none' }); setAuthLoading(false) })
  }, [])

  if (authLoading) return (
    <div className="flex h-full items-center justify-center bg-hull-950">
      <div className="flex flex-col items-center gap-4">
        <Spinner />
        <p className="text-xs text-gray-600">Connecting to cluster...</p>
      </div>
    </div>
  )

  if (!user) return (
    <div className="flex h-full items-center justify-center bg-hull-950 pt-safe">
      <div className="mx-4 w-full max-w-sm text-center">
        <div className="stat-card ring-glow p-8">
          <h1 className="text-2xl font-extrabold tracking-wider text-white mb-1">KUBE-<span className="text-neon-cyan glow-cyan">ARGUS</span></h1>
          <p className="text-xs text-gray-500 mb-6">Kubernetes Cluster Dashboard</p>
          {authModeHint === 'google' ? (
            <a href="/auth/login" className="inline-flex items-center gap-3 rounded-xl bg-white/[.06] border border-white/10 px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-white/10 hover:border-white/20 no-underline">
              <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </a>
          ) : (
            <a href="/auth/login" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-neon-cyan/20 to-neon-green/10 border border-neon-cyan/30 px-6 py-3 text-sm font-semibold text-neon-cyan transition-all hover:shadow-[0_0_20px_rgba(6,214,224,0.2)] hover:border-neon-cyan/50 no-underline">
              Sign in with SSO
            </a>
          )}
          <p className="mt-4 text-[10px] text-gray-700">Authenticated access only</p>
        </div>
      </div>
    </div>
  )
  const userInfo = user || { email: 'anonymous', role: 'viewer', authMode: 'none' }

  const handleSearchSelect = (r: SearchResult) => {
    if (r.kind === 'Pod') {
      setPodTarget({ ns: r.namespace, name: r.name })
    } else if (r.kind === 'Node') {
      setNodeTarget(r.name)
    } else if (r.kind === 'Ingress') {
      setIngressTarget({ ns: r.namespace, name: r.name })
    } else if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(r.kind)) {
      setWorkloadTarget({ ns: r.namespace, name: r.name, kind: r.kind })
    } else if (r.kind === 'Service') {
      setNs(r.namespace)
      setTab('services')
    }
  }

  const detailContent = podTarget ? (
    <PodDetailView ns={podTarget.ns} name={podTarget.name} onBack={() => setPodTarget(null)} onWorkload={(wns: string, wname: string, wkind: string) => { setPodTargetRaw(null); setNodeTargetRaw(null); setWorkloadTarget({ ns: wns, name: wname, kind: wkind }) }} />
  ) : nodeTarget ? (
    <NodeDescribeView name={nodeTarget} onBack={() => setNodeTarget(null)} onPod={(pns: string, pname: string) => { setPodTargetRaw({ ns: pns, name: pname }); pushUrl(`/pods/${pns}/${pname}`) }} />
  ) : workloadTarget ? (
    workloadTarget.kind === 'CronJob'
      ? <CronJobDetailView ns={workloadTarget.ns} name={workloadTarget.name} onBack={() => setWorkloadTarget(null)} onPod={(pns: string, pname: string) => { setPodTargetRaw({ ns: pns, name: pname }); pushUrl(`/pods/${pns}/${pname}`) }} />
      : <WorkloadDetailView ns={workloadTarget.ns} name={workloadTarget.name} kind={workloadTarget.kind} onBack={() => setWorkloadTarget(null)} onPod={(pns: string, pname: string) => { setPodTargetRaw({ ns: pns, name: pname }); pushUrl(`/pods/${pns}/${pname}`) }} />
  ) : ingressTarget ? (
    <IngressDetailView ns={ingressTarget.ns} name={ingressTarget.name} onBack={() => setIngressTarget(null)} />
  ) : null

  return (
    <AuthCtx.Provider value={userInfo}>
      <div className="flex h-full overflow-hidden bg-hull-950 pt-safe">
        {showSearch && <SearchModal onClose={() => setShowSearch(false)} onSelect={handleSearchSelect} />}
        {showAudit && <AuditTrailModal onClose={() => setShowAudit(false)} />}
        {showOnlineUsers && <OnlineUsersModal currentEmail={userInfo.email} onClose={() => setShowOnlineUsers(false)} />}

        {!sideOpen && <div className="fixed left-0 top-0 z-30 h-full w-2 cursor-pointer" onMouseEnter={() => setSideOpen(true)} />}

        {sideOpen && <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setSideOpen(false)} />}

        <aside onMouseLeave={() => setSideOpen(false)} className={`fixed left-0 top-0 z-50 flex h-full w-56 flex-col border-r border-hull-700/40 bg-hull-950/95 backdrop-blur-xl transition-transform duration-300 ease-out pt-safe ${sideOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-hull-700/30">
            <h1 className="text-sm font-extrabold tracking-wider text-white">KUBE-<span className="text-neon-cyan glow-cyan">ARGUS</span></h1>
            <button onClick={() => setSideOpen(false)} className="rounded-lg p-1 text-gray-500 hover:text-white transition-colors" aria-label="Close sidebar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto py-2 px-2">
            {TABS.map(t => (
              <Fragment key={t.id}>
                <button
                  onClick={() => {
                    if (t.id === 'troubled') {
                      setTroubledExpanded(prev => !prev)
                    } else {
                      setTab(t.id); if (t.id !== 'workloads') setWorkloadKind(''); setSideOpen(false)
                    }
                  }}
                  className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 mb-0.5 ${tab === t.id ? 'bg-hull-800/80 text-neon-cyan shadow-[inset_0_0_20px_rgba(6,214,224,0.04)]' : 'text-gray-500 hover:bg-hull-800/40 hover:text-gray-300'}`}
                >
                  {tab === t.id && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r-full bg-neon-cyan shadow-[0_0_8px_rgba(6,214,224,0.6)]" />}
                  <span className="text-base w-5 text-center">{t.icon}</span>
                  <span className="flex-1 text-left">{t.label}</span>
                  {t.id === 'troubled' && <span className={`text-[10px] text-gray-600 transition-transform duration-200 ${troubledExpanded ? 'rotate-90' : ''}`}>▸</span>}
                </button>
                {t.id === 'troubled' && troubledExpanded && (
                  <div className="ml-8 mb-1 space-y-0.5">
                    {([['pods', 'Troubled Pods'], ['spot', 'Node Disruptions'], ['resilience', 'Pod Resilience']] as const).map(([id, label]) => (
                      <button key={id} onClick={() => { setTab('troubled'); setTroubledSub(id as 'pods' | 'spot' | 'resilience'); setSideOpen(false); }}
                        className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-all ${tab === 'troubled' && troubledSub === id ? 'text-neon-cyan bg-hull-800/50' : 'text-gray-600 hover:text-gray-400 hover:bg-hull-800/30'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </Fragment>
            ))}
          </nav>

          <div className="border-t border-hull-700/30 px-3 py-3">
            <div className="flex items-center gap-2.5">
              <UserAvatar email={userInfo.email} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-gray-300 leading-tight truncate">{userInfo.email.split('@')[0]}</p>
                <p className={`text-[9px] font-bold uppercase tracking-widest ${userInfo.role === 'admin' ? 'text-neon-cyan' : 'text-gray-500'}`}>{userInfo.role}</p>
              </div>
            </div>
            {clusterInfo && <div className="mt-2 rounded-lg bg-gradient-to-r from-amber-950/40 to-amber-950/20 border border-amber-900/20 px-2 py-1 font-mono text-[10px] text-neon-amber text-center truncate">{clusterInfo.name}</div>}
          </div>
        </aside>

        {detailContent ? (
          <div className="flex flex-1 flex-col overflow-hidden">{detailContent}</div>
        ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="shrink-0 glass border-0 border-b border-hull-700/40 px-3 py-2.5 relative z-40">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <button onClick={() => setSideOpen(true)} className="rounded-lg p-1.5 text-gray-400 hover:text-white hover:bg-hull-800/60 transition-all active:scale-90" aria-label="Open sidebar" aria-expanded={sideOpen}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                </button>
                <h1 className="text-sm font-extrabold tracking-wider text-white">KUBE-<span className="text-neon-cyan glow-cyan">ARGUS</span></h1>
                {clusterInfo && <span className="hidden sm:inline rounded-lg bg-gradient-to-r from-amber-950/40 to-amber-950/20 border border-amber-900/20 px-2 py-0.5 font-mono text-[10px] text-neon-amber">{clusterInfo.name}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowSearch(true)} className="flex items-center gap-1.5 rounded-lg glass px-2.5 py-1 text-[11px] text-gray-400 transition-all hover:text-neon-cyan hover:shadow-[0_0_8px_rgba(6,214,224,0.1)]" aria-label="Search resources">
                  <span>⌕</span><span className="hidden sm:inline">Search</span>
                </button>
                {(tab === 'workloads' || tab === 'pods' || tab === 'ingress' || tab === 'services' || tab === 'events' || tab === 'hpa' || tab === 'config' || tab === 'pvcs') && namespaces && namespaces.length > 0 && (
                  <NamespacePicker namespaces={namespaces} value={ns} onChange={setNs} />
                )}
                <div className="relative">
                  <button onClick={() => setShowInfo(v => !v)} className="rounded-lg p-1.5 text-gray-500 hover:text-neon-cyan hover:bg-hull-800/60 transition-all" title="Dashboard Info" aria-label="Dashboard info">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  </button>
                  {showInfo && <InfoPopover tab={tab} onClose={() => setShowInfo(false)} />}
                </div>
                <div className="relative" ref={userMenuRef}>
                  <button onClick={() => setShowUserMenu(v => !v)} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-hull-800/60 transition-all" aria-label="User menu" aria-expanded={showUserMenu}>
                    <UserAvatar email={userInfo.email} />
                    <div className="hidden sm:block text-left">
                      <p className="text-[10px] font-medium text-gray-300 leading-tight truncate max-w-[100px]">{userInfo.email.split('@')[0]}</p>
                      <p className={`text-[8px] font-bold uppercase tracking-widest ${userInfo.role === 'admin' ? 'text-neon-cyan' : 'text-gray-500'}`}>{userInfo.role}</p>
                    </div>
                    <svg className="hidden sm:block text-gray-600" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                  {showUserMenu && <UserMenuDropdown email={userInfo.email} role={userInfo.role} onClose={() => setShowUserMenu(false)} onAudit={() => { setShowUserMenu(false); setShowAudit(true) }} onOnlineUsers={() => { setShowUserMenu(false); setShowOnlineUsers(true) }} containerRef={userMenuRef} />}
                </div>
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto overflow-x-hidden" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
            {tab === 'overview' && <OverviewView onNodeTap={(name) => { setNodeTarget(name) }} onTab={(t, kind) => { setTab(t as TabId); if (t === 'workloads') setWorkloadKind(kind || ''); }} />}
            {tab === 'nodes' && <NodesView onNode={(name) => setNodeTarget(name)} poolFilter={nodePool} onPoolChange={setNodePool} />}
            {tab === 'workloads' && <WorkloadsView namespace={ns} initialKind={workloadKind} onWorkload={(ns, name, kind) => setWorkloadTarget({ ns, name, kind })} />}
            {tab === 'pods' && <PodsView namespace={ns} onPod={(ns, name) => setPodTarget({ ns, name })} />}
            {tab === 'services' && <ServicesView namespace={ns} />}
            {tab === 'ingress' && <IngressesView namespace={ns} onIngress={(ns, name) => setIngressTarget({ ns, name })} />}
          {tab === 'hpa' && <HPAView namespace={ns} />}
          {tab === 'pvcs' && <PVCsView namespace={ns} />}
          {tab === 'config' && <ConfigView namespace={ns} />}
          {tab === 'spot' && <SpotAdvisorView />}
          {tab === 'events' && <EventsView namespace={ns} />}
          {tab === 'troubled' && troubledSub === 'pods' && <TroubledPodsView onPod={(ns, name) => setPodTarget({ ns, name })} />}
          {tab === 'troubled' && troubledSub === 'spot' && <SpotInterruptionsView onNode={(name) => setNodeTarget(name)} hiddenReasons={spotHiddenReasons} onToggleReason={(r) => setSpotHiddenReasons(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])} />}
          {tab === 'troubled' && troubledSub === 'resilience' && <PodResilienceView />}
          {tab === 'topology' && <TopologySpreadView />}
          </main>
        </div>
        )}
      </div>
    </AuthCtx.Provider>
  )
}

export default App
