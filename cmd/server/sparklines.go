package main

import (
	"net/http"
	"strings"
	"sync"
)

const sparklineMaxPoints = 30

type sparklineBuffer struct {
	mu     sync.Mutex
	points map[string][][2]int64 // key=ns/name -> ring of [cpu_m, mem_mi]
	idx    int
	count  int
}

var podSparklines = &sparklineBuffer{points: map[string][][2]int64{}}

func (sb *sparklineBuffer) record(podMetricsMap map[string][2]int64) {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	seen := map[string]bool{}
	for key, usage := range podMetricsMap {
		seen[key] = true
		ring, ok := sb.points[key]
		if !ok {
			ring = make([][2]int64, sparklineMaxPoints)
			sb.points[key] = ring
		}
		ring[sb.idx] = usage
	}
	for key := range sb.points {
		if !seen[key] { delete(sb.points, key) }
	}
	sb.idx = (sb.idx + 1) % sparklineMaxPoints
	if sb.count < sparklineMaxPoints { sb.count++ }
}

func (sb *sparklineBuffer) snapshot() map[string][][2]int64 {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	out := make(map[string][][2]int64, len(sb.points))
	for key, ring := range sb.points {
		n := sb.count
		ordered := make([][2]int64, 0, n)
		start := (sb.idx - n + sparklineMaxPoints) % sparklineMaxPoints
		for i := 0; i < n; i++ {
			ordered = append(ordered, ring[(start+i)%sparklineMaxPoints])
		}
		out[key] = ordered
	}
	return out
}

func apiPodSparklines(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	snap := podSparklines.snapshot()
	type sparkEntry struct {
		CPU [][2]int64 `json:"cpu"`
		MEM [][2]int64 `json:"mem"`
	}
	out := map[string]sparkEntry{}
	for key, pts := range snap {
		if ns != "" {
			slashIdx := strings.Index(key, "/")
			if slashIdx < 0 || key[:slashIdx] != ns { continue }
		}
		cpuArr := make([][2]int64, len(pts))
		memArr := make([][2]int64, len(pts))
		for i, p := range pts {
			cpuArr[i] = [2]int64{int64(i), p[0]}
			memArr[i] = [2]int64{int64(i), p[1]}
		}
		out[key] = sparkEntry{CPU: cpuArr, MEM: memArr}
	}
	jGz(w, r, out)
}
