export type UserInfo = { email: string; role: string; authMode?: string }
export type NodeInfo = { name: string; ready: boolean; status: string; role: string; nodepool: string; instanceType: string; age: string; ageSec: number; version: string; internalIP: string; cordoned: boolean; allocCpuM: number; allocMemMi: number; usedCpuM: number; usedMemMi: number; cpuPercent: number; memPercent: number; pods: number }
export type OverviewData = {
  nodes: NodeInfo[]; nodesReady: number; nodesTotal: number
  pods: { running: number; pending: number; failed: number; succeeded: number; total: number }
  deployments: { ready: number; total: number }; namespaces: number
  cacheAgeMs?: number
  cluster?: { cpuCapacityM: number; memCapacityMi: number; cpuAllocatableM: number; memAllocatableMi: number; cpuUsedM: number; memUsedMi: number }
  counts?: { services: number; ingresses: number; statefulsets: number; daemonsets: number; jobs: number; cronjobs: number }
  topNamespaces?: { ns: string; pods: number }[]
  warnings?: { type: string; reason: string; object: string; message: string; age: string; ns: string }[]
}
export type NodeDetail = { name: string; ready: boolean; cordoned: boolean; nodepool: string; age: string; allocCpuM: number; allocMemMi: number; usedCpuM: number; usedMemMi: number; pods: number; podCapacity: number; instanceType: string; zone: string; capacityType: string; arch: string; kubelet: string; runtime: string; internalIp: string; taints: number; conditions: string[] }
export type Workload = { kind: string; name: string; namespace: string; ready: number; desired: number; age: string; images: string; pdb?: { name: string; status: string; disruptionsAllowed: number }; strategy?: { type: string; maxSurge?: string; maxUnavailable?: string; partition?: number }; cpuReqM: number; cpuLimM: number; cpuUsedM: number; memReqMi: number; memLimMi: number; memUsedMi: number }
export type Pod = { name: string; namespace: string; status: string; restarts: number; age: string; node: string; ready: string; podIP?: string; ownerKind?: string; ownerName?: string; cpuReqM: number; cpuLimM: number; cpuUsedM: number; memReqMi: number; memLimMi: number; memUsedMi: number; cpuSizing: string; memSizing: string; labels?: Record<string, string>; containerStates?: { name: string; state: string; reason?: string }[] }
export type Evt = { type: string; reason: string; message: string; age: string; count: number }
export type ProbeInfo = { type: string; path?: string; port?: string; command?: string; periodSeconds?: number; failureThreshold?: number }
export type ContainerInfo = { name: string; image: string; ready: boolean; state: string; reason: string; message: string; restarts: number; started: boolean; cpuReqM: number; cpuLimM: number; cpuUsedM: number; memReqMi: number; memLimMi: number; memUsedMi: number; lastTermReason?: string; lastTermExitCode?: number; lastTermMessage?: string; lastTermAt?: string; livenessProbe?: ProbeInfo; readinessProbe?: ProbeInfo; startupProbe?: ProbeInfo }
export type PodDescribe = { name: string; namespace: string; node: string; status: string; ip: string; qos: string; age: string; containers: ContainerInfo[]; initContainers?: ContainerInfo[]; conditions: { type: string; status: string; reason: string; message: string }[]; ownerKind?: string; ownerName?: string }
export type IngressRule = { host: string; path: string; backend: string; port: string }
export type Ingress = { name: string; namespace: string; class: string; hosts: string[]; addresses: string[]; tls: boolean; rules: IngressRule[]; age: string }
export type IngressDescData = {
  name: string; namespace: string; class: string; age: string; defaultBackend: string
  tls: { hosts: string[]; secretName: string }[]
  rules: { host: string; path: string; pathType: string; backend: string; port: string }[]
  addresses: string[]
  annotations: Record<string, string>; labels: Record<string, string>
  events: { type: string; reason: string; message: string; age: string; count: number }[]
}
export type Service = { name: string; namespace: string; type: string; clusterIP: string; externalIP: string; ports: string; age: string; selector: string }
export type ClusterEvent = { type: string; reason: string; object: string; kind: string; message: string; age: string; count: number; namespace: string }
export type SearchResult = { kind: string; name: string; namespace: string }
export type HPAMetric = { name: string; type: string; current: string; target: string }
export type HPACondition = { type: string; status: string; reason: string; message: string }
export type HPA = { name: string; namespace: string; reference: string; minReplicas: number; maxReplicas: number; currentReplicas: number; desiredReplicas: number; metrics: HPAMetric[]; conditions: HPACondition[]; age: string }
export type ConfigItem = { kind: string; name: string; namespace: string; keys: string[]; keyCount: number; type?: string; age: string; modifiedAgo: string; recentChange: boolean }
export type ConfigDataResp = { kind: string; name: string; namespace: string; entries: { key: string; value: string }[]; masked: boolean }
export type SpotAlternative = { instanceType: string; vcpus: number; memoryGB: number; interruptRange: number; interruptLabel: string; savingsPct: number; spotPrice: number; nodesNeeded: number; totalMonthlyCost: number; monthlySaving: number; fitNote: string; score: number }
export type SpotCurrent = { instanceType: string; count: number; vcpus: number; memoryGiB: number; interruptRange: number; interruptLabel: string; savingsPct: number; spotPrice: number; monthlyCost: number; totalMonthlyCost: number; nodepools: string[]; totalUsedCpuM: number; totalUsedMemMi: number; totalReqCpuM: number; totalReqMemMi: number; totalAllocCpuM: number; totalAllocMemMi: number; avgCpuPct: number; avgMemPct: number; effectiveCpuM: number; effectiveMemMi: number }
export type SpotConsolidation = { instanceType: string; vcpus: number; memoryGB: number; interruptRange: number; interruptLabel: string; spotPrice: number; nodesNeeded: number; replacesNodes: number; replacesTypes: string[]; totalMonthlyCost: number; monthlySaving: number; reason: string; score: number }
export type SpotRecommendation = { current: SpotCurrent; alternatives: SpotAlternative[] }
export type ClusterCostData = { totalNodes: number; spotNodes: number; onDemandNodes: number; spotMonthlyCost: number; onDemandMonthlyCost: number; totalMonthlyCost: number; onDemandByType: { instanceType: string; count: number }[] }
export type SpotAdvisorData = { ready: boolean; message?: string; region: string; totalSpotNodes: number; recommendations: SpotRecommendation[]; consolidations?: SpotConsolidation[]; totalEffectiveCpuM?: number; totalEffectiveMemMi?: number; lastRefresh: string; clusterCost?: ClusterCostData }
export type NodeEvent = { type: string; reason: string; age: string; from: string; message: string; count: number }
export type NodeDescData = {
  name: string; status: string; role: string; age: string; version: string; cordoned: boolean
  addresses: { type: string; address: string }[]
  conditions: { type: string; status: string; reason: string; message: string; age: string }[]
  taints: { key: string; value: string; effect: string }[]
  capacity: { cpu: string; memory: string; pods: string }
  allocatable: { cpu: string; memory: string; pods: string }
  systemInfo: { os: string; arch: string; kernel: string; containerRuntime: string; kubelet: string; kubeProxy: string; osImage: string }
  labels: Record<string, string>
  images: { names: string[]; size: number }[]
  pods: { name: string; namespace: string; status: string; ready: string; age: string }[]
  events?: NodeEvent[]
  usedCpuM: number; usedMemMi: number; allocCpuM: number; allocMemMi: number; cpuPercent: number; memPercent: number
}

export type ServicePort = { name: string; port: number; targetPort: string; nodePort: number; protocol: string }
export type EndpointAddr = { ip: string; hostname: string; nodeName: string; ready: boolean }
export type EndpointPort = { name: string; port: number; protocol: string }
export type EndpointSubset = { addresses: EndpointAddr[]; ports: EndpointPort[] }
export type ServiceDescData = {
  name: string; namespace: string; type: string; clusterIP: string; externalIPs: string[]
  ports: ServicePort[]; selector: Record<string, string>; labels: Record<string, string>; annotations: Record<string, string>
  endpoints: EndpointSubset[]
  events: { type: string; reason: string; message: string; age: string; count: number }[]
  age: string
}
export type HPADescData = {
  name: string; namespace: string
  scaleTargetRef: { kind: string; name: string }
  minReplicas: number; maxReplicas: number; currentReplicas: number; desiredReplicas: number
  metrics: HPAMetric[]; conditions: (HPACondition & { age?: string })[]
  labels: Record<string, string>; annotations: Record<string, string>
  age: string
}
