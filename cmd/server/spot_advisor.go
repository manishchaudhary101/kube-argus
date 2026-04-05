package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/ec2"
	corev1 "k8s.io/api/core/v1"
)

// ─── Spot Advisor Cache ─────────────────────────────────────────────

type spotAdvisorEntry struct {
	R int     `json:"r"` // interruption range: 0=<5%, 1=5-10%, 2=10-15%, 3=15-20%, 4=>20%
	S int     `json:"s"` // savings % vs on-demand
}

type spotInstanceTypeInfo struct {
	Cores  int     `json:"cores"`
	RamGB  float64 `json:"ram_gb"`
	EMR    bool    `json:"emr"`
}

type spotAdvisorData struct {
	mu           sync.RWMutex
	entries      map[string]spotAdvisorEntry   // instanceType -> advisor entry (for detected region)
	typeSpecs    map[string]spotInstanceTypeInfo // instanceType -> specs
	spotPrices   map[string]float64             // instanceType -> current spot price/hr
	region       string
	lastRefresh  time.Time
}

var spotCache = &spotAdvisorData{}

func detectRegion() string {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if cache.nodes == nil { return "" }
	for _, n := range cache.nodes.Items {
		if z, ok := n.Labels["topology.kubernetes.io/zone"]; ok && len(z) > 1 {
			return z[:len(z)-1]
		}
		if z, ok := n.Labels["failure-domain.beta.kubernetes.io/zone"]; ok && len(z) > 1 {
			return z[:len(z)-1]
		}
	}
	return ""
}

func (s *spotAdvisorData) refresh() {
	region := detectRegion()
	if region == "" {
		slog.Warn("spot-advisor: could not detect region, skipping")
		return
	}

	resp, err := http.Get("https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json")
	if err != nil {
		slog.Error("spot-advisor: fetch failed", "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		slog.Error("spot-advisor: unexpected HTTP status", "status", resp.StatusCode)
		return
	}

	var raw struct {
		InstanceTypes map[string]spotInstanceTypeInfo            `json:"instance_types"`
		SpotAdvisor   map[string]map[string]map[string]spotAdvisorEntry `json:"spot_advisor"` // region -> OS -> type -> entry
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		slog.Error("spot-advisor: decode failed", "error", err)
		return
	}

	entries := make(map[string]spotAdvisorEntry)
	if regionData, ok := raw.SpotAdvisor[region]; ok {
		if linuxData, ok := regionData["Linux"]; ok {
			entries = linuxData
		}
	}

	// Fetch current spot prices for instance types we're actually using
	spotPrices := map[string]float64{}
	cache.mu.RLock()
	usedTypes := map[string]bool{}
	if cache.nodes != nil {
		for _, n := range cache.nodes.Items {
			if t, ok := n.Labels["node.kubernetes.io/instance-type"]; ok {
				usedTypes[t] = true
			}
		}
	}
	cache.mu.RUnlock()

	// Also include alternatives and consolidation options for pricing
	baseTypes := make([]string, 0, len(usedTypes))
	for t := range usedTypes { baseTypes = append(baseTypes, t) }
	for _, t := range baseTypes {
		for _, alt := range generateAlternatives(t) {
			usedTypes[alt] = true
		}
		for _, alt := range generateConsolidationAlternatives(t) {
			usedTypes[alt] = true
		}
	}

	if len(usedTypes) > 0 {
		func() {
			defer func() { recover() }() // graceful if no EC2 permissions
			sess, err := session.NewSession(&aws.Config{Region: aws.String(region)})
			if err != nil { return }
			ec2Client := ec2.New(sess)
			typeNames := make([]*string, 0, len(usedTypes))
			for t := range usedTypes { typeNames = append(typeNames, aws.String(t)) }

			// Batch in groups of 50 to avoid API limits
			for i := 0; i < len(typeNames); i += 50 {
				end := i + 50
				if end > len(typeNames) { end = len(typeNames) }
				batch := typeNames[i:end]
				input := &ec2.DescribeSpotPriceHistoryInput{
					InstanceTypes:       batch,
					ProductDescriptions: []*string{aws.String("Linux/UNIX")},
					StartTime:           aws.Time(time.Now()),
				}
				out, err := ec2Client.DescribeSpotPriceHistory(input)
				if err != nil {
					slog.Warn("spot-advisor: price fetch failed", "error", err)
					return
				}
				for _, sp := range out.SpotPriceHistory {
					if sp.InstanceType != nil && sp.SpotPrice != nil {
						if price, err := strconv.ParseFloat(*sp.SpotPrice, 64); err == nil {
							key := *sp.InstanceType
							if existing, ok := spotPrices[key]; !ok || price < existing {
								spotPrices[key] = price
							}
						}
					}
				}
			}
		}()
	}

	s.mu.Lock()
	s.entries = entries
	s.typeSpecs = raw.InstanceTypes
	s.spotPrices = spotPrices
	s.region = region
	s.lastRefresh = time.Now()
	s.mu.Unlock()
	slog.Info("spot-advisor: loaded data", "entries", len(entries), "region", region, "prices", len(spotPrices))
}

func parseInstanceType(instanceType string) (baseChar string, gen int, suffix string, size string) {
	parts := strings.SplitN(instanceType, ".", 2)
	if len(parts) != 2 { return }
	family := parts[0]
	size = parts[1]
	baseChar = string(family[0])
	genStr := ""
	for i := 1; i < len(family); i++ {
		c := family[i]
		if c >= '0' && c <= '9' {
			genStr += string(c)
		} else {
			suffix += string(c)
		}
	}
	fmt.Sscanf(genStr, "%d", &gen)
	return
}

func isGraviton(suffix string) bool {
	return strings.Contains(suffix, "g")
}

func generateAlternatives(instanceType string) []string {
	baseChar, gen, suffix, size := parseInstanceType(instanceType)
	if size == "" { return nil }

	graviton := isGraviton(suffix)

	// Only suggest variants matching the same CPU architecture
	var variants []string
	if graviton {
		variants = []string{"g", "gd"}
	} else {
		variants = []string{"", "i", "a", "ad", "id", "n"}
	}

	alternatives := []string{}
	for g := gen; g <= gen+3 && g <= 8; g++ {
		for _, v := range variants {
			candidate := fmt.Sprintf("%s%d%s.%s", baseChar, g, v, size)
			if candidate != instanceType {
				alternatives = append(alternatives, candidate)
			}
		}
	}

	crossFamilies := map[string][]string{
		"m": {"c", "r"},
		"c": {"m"},
		"r": {"m"},
	}
	if related, ok := crossFamilies[baseChar]; ok {
		for _, rf := range related {
			for g := gen - 1; g <= gen+2 && g <= 8; g++ {
				if g < 5 { continue }
				for _, v := range variants {
					candidate := fmt.Sprintf("%s%d%s.%s", rf, g, v, size)
					alternatives = append(alternatives, candidate)
				}
			}
		}
	}

	return alternatives
}

var sizeOrder = []string{"large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge", "metal"}

func sizeIndex(s string) int {
	for i, v := range sizeOrder {
		if v == s { return i }
	}
	return -1
}

func generateConsolidationAlternatives(instanceType string) []string {
	baseChar, gen, suffix, size := parseInstanceType(instanceType)
	if size == "" { return nil }

	idx := sizeIndex(size)
	if idx < 0 { return nil }

	graviton := isGraviton(suffix)
	var variants []string
	if graviton {
		variants = []string{"g", "gd"}
	} else {
		variants = []string{"", "i", "a", "ad", "n"}
	}

	alternatives := []string{}
	for si := idx + 1; si < len(sizeOrder); si++ {
		upSize := sizeOrder[si]
		for g := gen - 1; g <= gen+2 && g <= 8; g++ {
			if g < 5 { continue }
			for _, v := range variants {
				candidate := fmt.Sprintf("%s%d%s.%s", baseChar, g, v, upSize)
				if candidate != instanceType {
					alternatives = append(alternatives, candidate)
				}
			}
		}
		crossFamilies := map[string][]string{
			"m": {"c", "r"},
			"c": {"m"},
			"r": {"m"},
		}
		if related, ok := crossFamilies[baseChar]; ok {
			for _, rf := range related {
				for g := gen - 1; g <= gen+2 && g <= 8; g++ {
					if g < 5 { continue }
					for _, v := range variants {
						candidate := fmt.Sprintf("%s%d%s.%s", rf, g, v, upSize)
						alternatives = append(alternatives, candidate)
					}
				}
			}
		}
	}
	return alternatives
}

func interruptLabel(r int) string {
	switch r {
	case 0: return "<5%"
	case 1: return "5-10%"
	case 2: return "10-15%"
	case 3: return "15-20%"
	default: return ">20%"
	}
}

func startSpotAdvisorLoop() {
	go func() {
		time.Sleep(15 * time.Second) // let main cache warm up first
		spotCache.refresh()
		ticker := time.NewTicker(10 * time.Minute)
		for range ticker.C {
			spotCache.refresh()
		}
	}()
}

func apiSpotAdvisor(w http.ResponseWriter, r *http.Request) {
	spotCache.mu.RLock()
	defer spotCache.mu.RUnlock()

	if spotCache.entries == nil || len(spotCache.entries) == 0 {
		jGz(w, r, map[string]interface{}{"ready": false, "message": "Spot advisor data loading..."})
		return
	}

	cache.mu.RLock()
	defer cache.mu.RUnlock()

	if cache.nodes == nil {
		jGz(w, r, map[string]interface{}{"ready": false, "message": "Cluster cache not ready"})
		return
	}

	// Build per-node metrics lookup
	nodeUsage := map[string][2]int64{} // name -> {cpuMilli, memMiB}
	if cache.nodeMetrics != nil {
		for _, m := range cache.nodeMetrics.Items {
			nodeUsage[m.Name] = [2]int64{m.Usage.Cpu().MilliValue(), m.Usage.Memory().Value() / (1024 * 1024)}
		}
	}

	// Build per-node pod request sums
	nodeRequests := map[string][2]int64{} // name -> {cpuMilli, memMiB}
	if cache.pods != nil {
		for _, p := range cache.pods.Items {
			if p.Status.Phase != corev1.PodRunning { continue }
			nn := p.Spec.NodeName
			if nn == "" { continue }
			cur := nodeRequests[nn]
			for _, c := range p.Spec.Containers {
				if r, ok := c.Resources.Requests[corev1.ResourceCPU]; ok { cur[0] += r.MilliValue() }
				if r, ok := c.Resources.Requests[corev1.ResourceMemory]; ok { cur[1] += r.Value() / (1024 * 1024) }
			}
			nodeRequests[nn] = cur
		}
	}

	type instanceSummary struct {
		InstanceType      string   `json:"instanceType"`
		Count             int      `json:"count"`
		VCPUs             int64    `json:"vcpus"`
		MemoryGiB         float64  `json:"memoryGiB"`
		InterruptRange    int      `json:"interruptRange"`
		InterruptLabel    string   `json:"interruptLabel"`
		SavingsPct        int      `json:"savingsPct"`
		SpotPrice         float64  `json:"spotPrice,omitempty"`
		MonthlyCost       float64  `json:"monthlyCost,omitempty"`
		TotalMonthlyCost  float64  `json:"totalMonthlyCost,omitempty"`
		Nodepools         []string `json:"nodepools"`
		TotalUsedCpuM     int64    `json:"totalUsedCpuM"`
		TotalUsedMemMi    int64    `json:"totalUsedMemMi"`
		TotalReqCpuM      int64    `json:"totalReqCpuM"`
		TotalReqMemMi     int64    `json:"totalReqMemMi"`
		TotalAllocCpuM    int64    `json:"totalAllocCpuM"`
		TotalAllocMemMi   int64    `json:"totalAllocMemMi"`
		AvgCpuPct         int      `json:"avgCpuPct"`
		AvgMemPct         int      `json:"avgMemPct"`
		EffectiveCpuM     int64    `json:"effectiveCpuM"`
		EffectiveMemMi    int64    `json:"effectiveMemMi"`
	}

	type alternative struct {
		InstanceType    string  `json:"instanceType"`
		VCPUs           int     `json:"vcpus"`
		MemoryGB        float64 `json:"memoryGB"`
		InterruptRange  int     `json:"interruptRange"`
		InterruptLabel  string  `json:"interruptLabel"`
		SavingsPct      int     `json:"savingsPct"`
		SpotPrice       float64 `json:"spotPrice,omitempty"`
		NodesNeeded     int     `json:"nodesNeeded"`
		TotalMonthlyCost float64 `json:"totalMonthlyCost,omitempty"`
		MonthlySaving   float64 `json:"monthlySaving"`
		FitNote         string  `json:"fitNote"`
		Score           float64 `json:"score"`
	}

	type recommendation struct {
		Current      instanceSummary `json:"current"`
		Alternatives []alternative   `json:"alternatives"`
	}

	// Collect current spot nodes with workload data
	typeMap := map[string]*instanceSummary{}
	totalSpotNodes := 0

	for _, n := range cache.nodes.Items {
		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" {
			if _, ok := n.Labels["eks.amazonaws.com/capacityType"]; ok {
				capType = strings.ToLower(n.Labels["eks.amazonaws.com/capacityType"])
			}
		}
		if capType != "spot" { continue }
		totalSpotNodes++

		itype := n.Labels["node.kubernetes.io/instance-type"]
		if itype == "" { itype = n.Labels["beta.kubernetes.io/instance-type"] }
		if itype == "" { continue }

		allocCpuM := n.Status.Allocatable.Cpu().MilliValue()
		allocMemMi := n.Status.Allocatable.Memory().Value() / (1024 * 1024)
		vcpus := allocCpuM / 1000
		memGiB := float64(allocMemMi) / 1024
		nodepool := n.Labels["karpenter.sh/nodepool"]

		usage := nodeUsage[n.Name]
		reqs := nodeRequests[n.Name]

		// Effective load = max(usage, requests) per resource
		effCpu := usage[0]
		if reqs[0] > effCpu { effCpu = reqs[0] }
		effMem := usage[1]
		if reqs[1] > effMem { effMem = reqs[1] }

		if _, ok := typeMap[itype]; !ok {
			entry := spotCache.entries[itype]
			price := spotCache.spotPrices[itype]
			typeMap[itype] = &instanceSummary{
				InstanceType:   itype,
				VCPUs:          vcpus,
				MemoryGiB:      math.Round(memGiB*10) / 10,
				InterruptRange: entry.R,
				InterruptLabel: interruptLabel(entry.R),
				SavingsPct:     entry.S,
				SpotPrice:      price,
				Nodepools:      []string{},
			}
		}
		s := typeMap[itype]
		s.Count++
		s.TotalUsedCpuM += usage[0]
		s.TotalUsedMemMi += usage[1]
		s.TotalReqCpuM += reqs[0]
		s.TotalReqMemMi += reqs[1]
		s.TotalAllocCpuM += allocCpuM
		s.TotalAllocMemMi += allocMemMi
		s.EffectiveCpuM += effCpu
		s.EffectiveMemMi += effMem

		found := false
		for _, np := range s.Nodepools {
			if np == nodepool { found = true; break }
		}
		if !found && nodepool != "" { s.Nodepools = append(s.Nodepools, nodepool) }
	}

	// Finalize per-type aggregates
	for _, s := range typeMap {
		s.MonthlyCost = s.SpotPrice * 730
		s.TotalMonthlyCost = s.SpotPrice * 730 * float64(s.Count)
		if s.TotalAllocCpuM > 0 { s.AvgCpuPct = int(s.TotalUsedCpuM * 100 / s.TotalAllocCpuM) }
		if s.TotalAllocMemMi > 0 { s.AvgMemPct = int(s.TotalUsedMemMi * 100 / s.TotalAllocMemMi) }
	}

	const packingFactor = 0.85

	// Build workload-aware recommendations
	recs := make([]recommendation, 0)
	for _, summary := range typeMap {
		alts := generateAlternatives(summary.InstanceType)
		altList := make([]alternative, 0)
		currentTotalCost := summary.TotalMonthlyCost

		for _, altType := range alts {
			entry, ok := spotCache.entries[altType]
			if !ok { continue }
			spec, hasSpec := spotCache.typeSpecs[altType]
			if !hasSpec { continue }

			price := spotCache.spotPrices[altType]

			// Calculate usable capacity per node of this alternative type
			altCpuCapM := float64(spec.Cores) * 1000 * packingFactor
			altMemCapMi := spec.RamGB * 1024 * packingFactor

			// How many alternative nodes needed to fit the effective workload?
			nodesByCpu := 1
			if altCpuCapM > 0 && summary.EffectiveCpuM > 0 {
				nodesByCpu = int(math.Ceil(float64(summary.EffectiveCpuM) / altCpuCapM))
			}
			nodesByMem := 1
			if altMemCapMi > 0 && summary.EffectiveMemMi > 0 {
				nodesByMem = int(math.Ceil(float64(summary.EffectiveMemMi) / altMemCapMi))
			}
			nodesNeeded := nodesByCpu
			if nodesByMem > nodesNeeded { nodesNeeded = nodesByMem }
			if nodesNeeded < 1 { nodesNeeded = 1 }

			totalCost := float64(0)
			if price > 0 { totalCost = price * 730 * float64(nodesNeeded) }

			// Only include if: cheaper total cost, OR same/fewer nodes with lower interruption
			isCheaper := totalCost > 0 && currentTotalCost > 0 && totalCost < currentTotalCost
			isBetterAvailability := entry.R < summary.InterruptRange && nodesNeeded <= summary.Count
			if !isCheaper && !isBetterAvailability { continue }

			saving := currentTotalCost - totalCost

			fitNote := ""
			if nodesNeeded < summary.Count {
				fitNote = fmt.Sprintf("%d nodes replace %d", nodesNeeded, summary.Count)
			} else if nodesNeeded == summary.Count {
				fitNote = "same node count"
			} else {
				fitNote = fmt.Sprintf("needs %d nodes (vs %d)", nodesNeeded, summary.Count)
			}
			if isBetterAvailability && !isCheaper {
				fitNote += ", lower interruptions"
			}

			// Score: lower is better; balance total cost and availability
			score := float64(0)
			if totalCost > 0 { score = totalCost / 100 }
			score += float64(entry.R) * 20
			score -= saving / 50

			altList = append(altList, alternative{
				InstanceType:     altType,
				VCPUs:            spec.Cores,
				MemoryGB:         spec.RamGB,
				InterruptRange:   entry.R,
				InterruptLabel:   interruptLabel(entry.R),
				SavingsPct:       entry.S,
				SpotPrice:        price,
				NodesNeeded:      nodesNeeded,
				TotalMonthlyCost: math.Round(totalCost*100) / 100,
				MonthlySaving:    math.Round(saving*100) / 100,
				FitNote:          fitNote,
				Score:            math.Round(score*100) / 100,
			})
		}
		sort.Slice(altList, func(i, j int) bool { return altList[i].Score < altList[j].Score })
		if len(altList) > 8 { altList = altList[:8] }
		recs = append(recs, recommendation{Current: *summary, Alternatives: altList})
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Current.TotalMonthlyCost > recs[j].Current.TotalMonthlyCost })

	// Consolidation: suggest fewer, larger nodes across all instance types
	type consolidation struct {
		InstanceType     string  `json:"instanceType"`
		VCPUs            int     `json:"vcpus"`
		MemoryGB         float64 `json:"memoryGB"`
		InterruptRange   int     `json:"interruptRange"`
		InterruptLabel   string  `json:"interruptLabel"`
		SpotPrice        float64 `json:"spotPrice,omitempty"`
		NodesNeeded      int     `json:"nodesNeeded"`
		ReplacesNodes    int     `json:"replacesNodes"`
		ReplacesTypes    []string `json:"replacesTypes"`
		TotalMonthlyCost float64 `json:"totalMonthlyCost,omitempty"`
		MonthlySaving    float64 `json:"monthlySaving"`
		Reason           string  `json:"reason"`
		Score            float64 `json:"score"`
	}

	totalEffCpu := int64(0)
	totalEffMem := int64(0)
	totalCurrentCost := float64(0)
	allTypes := []string{}
	for _, s := range typeMap {
		totalEffCpu += s.EffectiveCpuM
		totalEffMem += s.EffectiveMemMi
		totalCurrentCost += s.TotalMonthlyCost
		allTypes = append(allTypes, s.InstanceType)
	}

	consols := make([]consolidation, 0)
	if totalSpotNodes >= 3 && totalEffCpu > 0 {
		seen := map[string]bool{}
		for _, itype := range allTypes {
			for _, altType := range generateConsolidationAlternatives(itype) {
				if seen[altType] { continue }
				seen[altType] = true

				entry, ok := spotCache.entries[altType]
				if !ok { continue }
				spec, hasSpec := spotCache.typeSpecs[altType]
				if !hasSpec { continue }
				price := spotCache.spotPrices[altType]

				altCpuCapM := float64(spec.Cores) * 1000 * packingFactor
				altMemCapMi := spec.RamGB * 1024 * packingFactor
				if altCpuCapM == 0 || altMemCapMi == 0 { continue }

				nodesByCpu := int(math.Ceil(float64(totalEffCpu) / altCpuCapM))
				nodesByMem := int(math.Ceil(float64(totalEffMem) / altMemCapMi))
				nodesNeeded := nodesByCpu
				if nodesByMem > nodesNeeded { nodesNeeded = nodesByMem }
				if nodesNeeded < 1 { nodesNeeded = 1 }

				if nodesNeeded >= totalSpotNodes { continue }

				totalCost := float64(0)
				if price > 0 { totalCost = price * 730 * float64(nodesNeeded) }
				saving := totalCurrentCost - totalCost

				reason := fmt.Sprintf("Consolidate %d nodes (%s) → %d x %s", totalSpotNodes, strings.Join(allTypes, ", "), nodesNeeded, altType)

				score := float64(nodesNeeded) * 10
				score += float64(entry.R) * 25
				if saving > 0 { score -= saving / 30 }

				consols = append(consols, consolidation{
					InstanceType:     altType,
					VCPUs:            spec.Cores,
					MemoryGB:         spec.RamGB,
					InterruptRange:   entry.R,
					InterruptLabel:   interruptLabel(entry.R),
					SpotPrice:        price,
					NodesNeeded:      nodesNeeded,
					ReplacesNodes:    totalSpotNodes,
					ReplacesTypes:    allTypes,
					TotalMonthlyCost: math.Round(totalCost*100) / 100,
					MonthlySaving:    math.Round(saving*100) / 100,
					Reason:           reason,
					Score:            math.Round(score*100) / 100,
				})
			}
		}
		sort.Slice(consols, func(i, j int) bool { return consols[i].Score < consols[j].Score })
		if len(consols) > 10 { consols = consols[:10] }
	}

	// Compute total cluster cost: spot + on-demand
	totalClusterNodes := 0
	totalOnDemandNodes := 0
	totalSpotMonthlyCost := totalCurrentCost
	totalOnDemandMonthlyCost := float64(0)
	onDemandByType := map[string]int{} // instanceType -> count

	for _, n := range cache.nodes.Items {
		totalClusterNodes++
		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" {
			if v, ok := n.Labels["eks.amazonaws.com/capacityType"]; ok {
				capType = strings.ToLower(v)
			}
		}
		if capType == "spot" { continue }
		totalOnDemandNodes++

		itype := n.Labels["node.kubernetes.io/instance-type"]
		if itype == "" { itype = n.Labels["beta.kubernetes.io/instance-type"] }
		if itype == "" { continue }
		onDemandByType[itype]++

		// Derive on-demand price from spot price + savings %
		if spotPrice, ok := spotCache.spotPrices[itype]; ok && spotPrice > 0 {
			if entry, ok2 := spotCache.entries[itype]; ok2 && entry.S > 0 && entry.S < 100 {
				odPrice := spotPrice / (1 - float64(entry.S)/100)
				totalOnDemandMonthlyCost += odPrice * 730
				continue
			}
		}
		// Fallback: estimate based on vCPU count (~$0.04/hr per vCPU for on-demand as rough average)
		allocCpuM := n.Status.Allocatable.Cpu().MilliValue()
		if allocCpuM > 0 {
			totalOnDemandMonthlyCost += (float64(allocCpuM) / 1000) * 0.04 * 730
		}
	}

	type onDemandSummary struct {
		InstanceType string `json:"instanceType"`
		Count        int    `json:"count"`
	}
	odList := make([]onDemandSummary, 0, len(onDemandByType))
	for itype, count := range onDemandByType {
		odList = append(odList, onDemandSummary{InstanceType: itype, Count: count})
	}
	sort.Slice(odList, func(i, j int) bool { return odList[i].Count > odList[j].Count })

	jGz(w, r, map[string]interface{}{
		"ready":           true,
		"region":          spotCache.region,
		"totalSpotNodes":  totalSpotNodes,
		"recommendations": recs,
		"consolidations":  consols,
		"totalEffectiveCpuM":  totalEffCpu,
		"totalEffectiveMemMi": totalEffMem,
		"lastRefresh":     spotCache.lastRefresh.Format(time.RFC3339),
		"clusterCost": map[string]interface{}{
			"totalNodes":            totalClusterNodes,
			"spotNodes":             totalSpotNodes,
			"onDemandNodes":         totalOnDemandNodes,
			"spotMonthlyCost":       math.Round(totalSpotMonthlyCost*100) / 100,
			"onDemandMonthlyCost":   math.Round(totalOnDemandMonthlyCost*100) / 100,
			"totalMonthlyCost":      math.Round((totalSpotMonthlyCost+totalOnDemandMonthlyCost)*100) / 100,
			"onDemandByType":        odList,
		},
	})
}
