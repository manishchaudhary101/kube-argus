package main

import (
	"context"
	"log/slog"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autov2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsapi "k8s.io/metrics/pkg/apis/metrics/v1beta1"
)

// ─── Background Cache ────────────────────────────────────────────────

// rsOwner holds the resolved owner of a ReplicaSet (typically a Deployment).
type rsOwner struct {
	Kind string
	Name string
}

type clusterCache struct {
	mu             sync.RWMutex
	nodes          *corev1.NodeList
	pods           *corev1.PodList
	deployments    *appsv1.DeploymentList
	statefulsets   *appsv1.StatefulSetList
	daemonsets     *appsv1.DaemonSetList
	services       *corev1.ServiceList
	jobs           *batchv1.JobList
	cronjobs       *batchv1.CronJobList
	namespaces     *corev1.NamespaceList
	events         *corev1.EventList
	ingresses      *netv1.IngressList
	hpas           *autov2.HorizontalPodAutoscalerList
	configMeta     []configMeta
	secretMeta     []configMeta
	nodeMetrics    *metricsapi.NodeMetricsList
	podMetrics     *metricsapi.PodMetricsList
	pdbs           *policyv1.PodDisruptionBudgetList
	replicasets    *appsv1.ReplicaSetList
	pvcs           *corev1.PersistentVolumeClaimList
	pvs            *corev1.PersistentVolumeList
	storageClasses *storagev1.StorageClassList
	configDrift    []interface{}
	lastRefresh    time.Time

	// Pre-computed lookup maps (rebuilt each refresh cycle).
	podMetricsMap map[string][2]int64          // "ns/name" → [cpuMillis, memMiB]
	rsOwners      map[string]rsOwner           // "ns/rsName" → resolved owner
}

type configMeta struct {
	Name         string
	Namespace    string
	Keys         []string
	Type         string
	CreatedAt    time.Time
	LastModified time.Time
	Version      string
}

var cache = &clusterCache{}

func (c *clusterCache) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var nodes *corev1.NodeList
	var pods *corev1.PodList
	var deps *appsv1.DeploymentList
	var sts *appsv1.StatefulSetList
	var ds *appsv1.DaemonSetList
	var svcs *corev1.ServiceList
	var jobs *batchv1.JobList
	var cjobs *batchv1.CronJobList
	var nsList *corev1.NamespaceList
	var events *corev1.EventList
	var ings *netv1.IngressList
	var hpas *autov2.HorizontalPodAutoscalerList
	var cmMeta []configMeta
	var secMeta []configMeta
	var nodeMetrics *metricsapi.NodeMetricsList
	var podMetrics *metricsapi.PodMetricsList
	var pdbs *policyv1.PodDisruptionBudgetList
	var rsList *appsv1.ReplicaSetList
	var pvcList *corev1.PersistentVolumeClaimList
	var pvList *corev1.PersistentVolumeList
	var scList *storagev1.StorageClassList

	storeBatch := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if nodes != nil { c.nodes = nodes }
		if pods != nil { c.pods = pods }
		if deps != nil { c.deployments = deps }
		if sts != nil { c.statefulsets = sts }
		if ds != nil { c.daemonsets = ds }
		if svcs != nil { c.services = svcs }
		if jobs != nil { c.jobs = jobs }
		if cjobs != nil { c.cronjobs = cjobs }
		if nsList != nil { c.namespaces = nsList }
		if events != nil { c.events = events }
		if ings != nil { c.ingresses = ings }
		if hpas != nil { c.hpas = hpas }
		if cmMeta != nil { c.configMeta = cmMeta }
		if secMeta != nil { c.secretMeta = secMeta }
		if nodeMetrics != nil { c.nodeMetrics = nodeMetrics }
		if podMetrics != nil { c.podMetrics = podMetrics }
		if pdbs != nil { c.pdbs = pdbs }
		if rsList != nil { c.replicasets = rsList }
		if pvcList != nil { c.pvcs = pvcList }
		if pvList != nil { c.pvs = pvList }
		if scList != nil { c.storageClasses = scList }
		c.lastRefresh = time.Now()
	}

	// Batch 1: critical path — nodes, pods, metrics, namespaces (overview needs these)
	var wg1 sync.WaitGroup
	wg1.Add(5)
	go func() { defer wg1.Done(); nodes, _ = clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg1.Done(); pods, _ = clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg1.Done(); nsList, _ = clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{}) }()
	go func() {
		defer wg1.Done()
		if metricsCl != nil {
			var err error
			nodeMetrics, err = metricsCl.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
			if err != nil {
				slog.Warn("metrics-server node metrics failed", "error", err)
			}
		}
	}()
	go func() {
		defer wg1.Done()
		if metricsCl != nil {
			var err error
			podMetrics, err = metricsCl.MetricsV1beta1().PodMetricses("").List(ctx, metav1.ListOptions{})
			if err != nil {
				slog.Warn("metrics-server pod metrics failed", "error", err)
			}
		}
	}()
	wg1.Wait()
	storeBatch()

	// Pre-build podMetricsMap — used by /api/pods, /api/workloads, /api/nodes.
	pm := map[string][2]int64{}
	if podMetrics != nil {
		for _, m := range podMetrics.Items {
			var cpu, mem int64
			for _, ct := range m.Containers {
				cpu += ct.Usage.Cpu().MilliValue()
				mem += ct.Usage.Memory().Value() / (1024 * 1024)
			}
			pm[m.Namespace+"/"+m.Name] = [2]int64{cpu, mem}
		}
		podSparklines.record(pm)
	}
	c.mu.Lock()
	c.podMetricsMap = pm
	c.mu.Unlock()

	runtime.Gosched()

	// Batch 2: workloads + events + ConfigMaps metadata (lightweight)
	var wg2 sync.WaitGroup
	wg2.Add(7)
	go func() {
		defer wg2.Done()
		deps, _ = clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
		sts, _ = clientset.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
		ds, _ = clientset.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	}()
	go func() { defer wg2.Done(); svcs, _ = clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{}) }()
	go func() {
		defer wg2.Done()
		jobs, _ = clientset.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
		cjobs, _ = clientset.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
	}()
	go func() { defer wg2.Done(); events, _ = clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg2.Done(); rsList, _ = clientset.AppsV1().ReplicaSets("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg2.Done(); pdbs, _ = clientset.PolicyV1().PodDisruptionBudgets("").List(ctx, metav1.ListOptions{}) }()
	go func() {
		defer wg2.Done()
		if result, err := clientset.CoreV1().ConfigMaps("").List(ctx, metav1.ListOptions{}); err == nil {
			meta := make([]configMeta, 0, len(result.Items))
			for _, cm := range result.Items {
				if cm.Name == "kube-root-ca.crt" { continue }
				keys := make([]string, 0, len(cm.Data)+len(cm.BinaryData))
				for k := range cm.Data { keys = append(keys, k) }
				for k := range cm.BinaryData { keys = append(keys, k+" (binary)") }
				sort.Strings(keys)
				lastMod := cm.CreationTimestamp.Time
			if lm, ok := cm.Annotations["kubectl.kubernetes.io/last-applied-configuration"]; ok && len(lm) > 0 {
				lastMod = cm.CreationTimestamp.Time
			}
			if cm.ManagedFields != nil {
				for _, mf := range cm.ManagedFields {
					if mf.Time != nil && mf.Time.Time.After(lastMod) { lastMod = mf.Time.Time }
				}
			}
			meta = append(meta, configMeta{Name: cm.Name, Namespace: cm.Namespace, Keys: keys, CreatedAt: cm.CreationTimestamp.Time, LastModified: lastMod, Version: cm.ResourceVersion})
			}
			cmMeta = meta
		}
	}()
	wg2.Wait()
	storeBatch()

	// Pre-build ReplicaSet → owner map so /api/pods can resolve
	// pod → RS → Deployment in O(1) instead of O(pods × replicaSets).
	rsMap := map[string]rsOwner{}
	if rsList != nil {
		for _, rs := range rsList.Items {
			for _, ref := range rs.OwnerReferences {
				if ref.Controller != nil && *ref.Controller {
					rsMap[rs.Namespace+"/"+rs.Name] = rsOwner{Kind: ref.Kind, Name: ref.Name}
					break
				}
			}
		}
	}
	c.mu.Lock()
	c.rsOwners = rsMap
	c.mu.Unlock()

	runtime.Gosched()

	// Batch 3: secondary resources — Secrets (heavy binary), ingresses, HPAs, storage
	var wg3 sync.WaitGroup
	wg3.Add(6)
	go func() { defer wg3.Done(); ings, _ = clientset.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg3.Done(); hpas, _ = clientset.AutoscalingV2().HorizontalPodAutoscalers("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg3.Done(); pvcList, _ = clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg3.Done(); pvList, _ = clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{}) }()
	go func() { defer wg3.Done(); scList, _ = clientset.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{}) }()
	go func() {
		defer wg3.Done()
		if result, err := clientset.CoreV1().Secrets("").List(ctx, metav1.ListOptions{}); err == nil {
			meta := make([]configMeta, 0, len(result.Items))
			for _, s := range result.Items {
				if s.Type == corev1.SecretTypeServiceAccountToken { continue }
				if strings.HasPrefix(string(s.Type), "helm.sh/") { continue }
				keys := make([]string, 0, len(s.Data)+len(s.StringData))
				for k := range s.Data { keys = append(keys, k) }
				for k := range s.StringData { keys = append(keys, k) }
				sort.Strings(keys)
				lastMod := s.CreationTimestamp.Time
			if s.ManagedFields != nil {
				for _, mf := range s.ManagedFields {
					if mf.Time != nil && mf.Time.Time.After(lastMod) { lastMod = mf.Time.Time }
				}
			}
			meta = append(meta, configMeta{Name: s.Name, Namespace: s.Namespace, Keys: keys, Type: string(s.Type), CreatedAt: s.CreationTimestamp.Time, LastModified: lastMod, Version: s.ResourceVersion})
			}
			secMeta = meta
		}
	}()
	wg3.Wait()
	storeBatch()

	// Compute config drift outside the lock — pods, cmMeta, secMeta are local
	// variables that won't change, so no lock is needed for the computation.
	drift := computeConfigDrift(pods, cmMeta, secMeta)
	c.mu.Lock()
	c.configDrift = drift
	c.mu.Unlock()
}

func startCacheLoop() {
	cache.refresh()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		for range ticker.C {
			cache.refresh()
		}
	}()
}
