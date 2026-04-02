package main

import (
	"net/http"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ─── Storage (PVs, PVCs, StorageClasses) ────────────────────────────

func apiStorage(w http.ResponseWriter, r *http.Request) {
	c, cancel := ctx()
	defer cancel()
	nsFilter := r.URL.Query().Get("namespace")

	type pvcWorkload struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	type pvcEntry struct {
		Name         string       `json:"name"`
		Namespace    string       `json:"namespace"`
		Status       string       `json:"status"`
		VolumeName   string       `json:"volumeName"`
		StorageClass string       `json:"storageClass"`
		Capacity     string       `json:"capacity"`
		AccessModes  []string     `json:"accessModes"`
		Age          string       `json:"age"`
		Workload     *pvcWorkload `json:"workload,omitempty"`
	}
	type pvEntry struct {
		Name          string `json:"name"`
		Status        string `json:"status"`
		Capacity      string `json:"capacity"`
		ReclaimPolicy string `json:"reclaimPolicy"`
		StorageClass  string `json:"storageClass"`
		ClaimRef      string `json:"claimRef"`
		Age           string `json:"age"`
		Source        string `json:"source"`
	}
	type scEntry struct {
		Name          string `json:"name"`
		Provisioner   string `json:"provisioner"`
		ReclaimPolicy string `json:"reclaimPolicy"`
		BindingMode   string `json:"bindingMode"`
		IsDefault     bool   `json:"isDefault"`
	}

	var wg sync.WaitGroup
	var pvcList *corev1.PersistentVolumeClaimList
	var pvList *corev1.PersistentVolumeList
	var scList *storagev1.StorageClassList
	var podList *corev1.PodList

	wg.Add(4)
	go func() { defer wg.Done(); pvcList, _ = clientset.CoreV1().PersistentVolumeClaims("").List(c, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); pvList, _ = clientset.CoreV1().PersistentVolumes().List(c, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); scList, _ = clientset.StorageV1().StorageClasses().List(c, metav1.ListOptions{}) }()
	go func() { defer wg.Done(); podList, _ = clientset.CoreV1().Pods("").List(c, metav1.ListOptions{}) }()
	wg.Wait()

	pvcToWorkload := map[string]*pvcWorkload{}
	if podList != nil {
		for _, p := range podList.Items {
			if p.Status.Phase != corev1.PodRunning && p.Status.Phase != corev1.PodPending { continue }
			ownerKind, ownerName := "", ""
			for _, ref := range p.OwnerReferences {
				ownerKind = ref.Kind
				ownerName = ref.Name
				break
			}
			for _, vol := range p.Spec.Volumes {
				if vol.PersistentVolumeClaim != nil {
					key := p.Namespace + "/" + vol.PersistentVolumeClaim.ClaimName
					if _, exists := pvcToWorkload[key]; !exists {
						if ownerKind != "" {
							pvcToWorkload[key] = &pvcWorkload{Kind: ownerKind, Name: ownerName}
						} else {
							pvcToWorkload[key] = &pvcWorkload{Kind: "Pod", Name: p.Name}
						}
					}
				}
			}
		}
	}

	pvcs := []pvcEntry{}
	if pvcList != nil {
		for _, pvc := range pvcList.Items {
			if nsFilter != "" && pvc.Namespace != nsFilter { continue }
			sc := ""
			if pvc.Spec.StorageClassName != nil { sc = *pvc.Spec.StorageClassName }
			cap := ""
			if s, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok { cap = s.String() }
			if cap == "" {
				if s, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok { cap = s.String() }
			}
			modes := []string{}
			for _, m := range pvc.Spec.AccessModes { modes = append(modes, string(m)) }
			entry := pvcEntry{
				Name: pvc.Name, Namespace: pvc.Namespace,
				Status: string(pvc.Status.Phase), VolumeName: pvc.Spec.VolumeName,
				StorageClass: sc, Capacity: cap, AccessModes: modes,
				Age: shortDur(time.Since(pvc.CreationTimestamp.Time)),
			}
			if wl, ok := pvcToWorkload[pvc.Namespace+"/"+pvc.Name]; ok { entry.Workload = wl }
			pvcs = append(pvcs, entry)
		}
	}

	pvs := []pvEntry{}
	if pvList != nil {
		for _, pv := range pvList.Items {
			claim := ""
			if pv.Spec.ClaimRef != nil { claim = pv.Spec.ClaimRef.Namespace + "/" + pv.Spec.ClaimRef.Name }
			cap := ""
			if s, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok { cap = s.String() }
			sc := pv.Spec.StorageClassName
			source := "unknown"
			if pv.Spec.CSI != nil { source = pv.Spec.CSI.Driver }
			if pv.Spec.AWSElasticBlockStore != nil { source = "aws-ebs" }
			if pv.Spec.NFS != nil { source = "nfs" }
			if pv.Spec.HostPath != nil { source = "hostPath" }
			pvs = append(pvs, pvEntry{
				Name: pv.Name, Status: string(pv.Status.Phase), Capacity: cap,
				ReclaimPolicy: string(pv.Spec.PersistentVolumeReclaimPolicy),
				StorageClass: sc, ClaimRef: claim,
				Age: shortDur(time.Since(pv.CreationTimestamp.Time)), Source: source,
			})
		}
	}

	scs := []scEntry{}
	if scList != nil {
		for _, sc := range scList.Items {
			rp := "Delete"
			if sc.ReclaimPolicy != nil { rp = string(*sc.ReclaimPolicy) }
			bm := "Immediate"
			if sc.VolumeBindingMode != nil { bm = string(*sc.VolumeBindingMode) }
			isDef := false
			if sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" { isDef = true }
			scs = append(scs, scEntry{
				Name: sc.Name, Provisioner: sc.Provisioner,
				ReclaimPolicy: rp, BindingMode: bm, IsDefault: isDef,
			})
		}
	}

	j(w, map[string]interface{}{"pvcs": pvcs, "pvs": pvs, "storageClasses": scs})
}
