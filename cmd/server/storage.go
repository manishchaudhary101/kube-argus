package main

import (
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// ─── Storage (PVs, PVCs, StorageClasses) ────────────────────────────

func apiStorage(w http.ResponseWriter, r *http.Request) {
	nsFilter := r.URL.Query().Get("namespace")

	cache.mu.RLock()
	defer cache.mu.RUnlock()

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

	pvcToWorkload := map[string]*pvcWorkload{}
	if cache.pods != nil {
		for _, p := range cache.pods.Items {
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
	if cache.pvcs != nil {
		for _, pvc := range cache.pvcs.Items {
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
	if cache.pvs != nil {
		for _, pv := range cache.pvs.Items {
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
	if cache.storageClasses != nil {
		for _, sc := range cache.storageClasses.Items {
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
