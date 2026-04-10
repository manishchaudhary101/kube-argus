package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// ─── AI (LLM Gateway) ───────────────────────────────────────────────

var (
	llmGatewayURL   string
	llmGatewayKey   string
	llmGatewayModel string
	aiEnabled       bool
	aiRateMu        sync.Mutex
	aiCallTimes     []time.Time
	aiConcurrent    int32
)

const (
	aiMaxCallsPerMin = 10
	aiMaxConcurrent  = 2
)

func initLLM() {
	llmGatewayURL = os.Getenv("LLM_GATEWAY_URL")
	llmGatewayKey = os.Getenv("LLM_GATEWAY_KEY")
	llmGatewayModel = os.Getenv("LLM_GATEWAY_MODEL")
	if llmGatewayURL == "" {
		slog.Info("ai: LLM_GATEWAY_URL not set, AI features disabled")
		return
	}
	// Extract model from ?model= query param if not set via env
	if llmGatewayModel == "" {
		if parsed, err := url.Parse(llmGatewayURL); err == nil {
			llmGatewayModel = parsed.Query().Get("model")
		}
	}
	// Auto-append /v1/chat/completions if URL is just a base domain
	if parsed, err := url.Parse(llmGatewayURL); err == nil {
		if parsed.Path == "" || parsed.Path == "/" {
			parsed.Path = "/v1/chat/completions"
			llmGatewayURL = parsed.String()
		}
	}
	aiEnabled = true
	slog.Info("ai: LLM Gateway configured", "url", llmGatewayURL, "model", llmGatewayModel)
}

func aiRateOK() bool {
	aiRateMu.Lock()
	defer aiRateMu.Unlock()
	now := time.Now()
	cutoff := now.Add(-1 * time.Minute)
	filtered := aiCallTimes[:0]
	for _, t := range aiCallTimes {
		if t.After(cutoff) { filtered = append(filtered, t) }
	}
	aiCallTimes = filtered
	if len(aiCallTimes) >= aiMaxCallsPerMin { return false }
	if aiConcurrent >= int32(aiMaxConcurrent) { return false }
	aiCallTimes = append(aiCallTimes, now)
	aiConcurrent++
	return true
}

func aiRateDone() {
	aiRateMu.Lock()
	defer aiRateMu.Unlock()
	aiConcurrent--
	if aiConcurrent < 0 { aiConcurrent = 0 }
}

func streamLLM(w http.ResponseWriter, systemPrompt, userPrompt string) {
	if !aiEnabled || llmGatewayURL == "" {
		je(w, `{"error":"AI not available — LLM Gateway not configured"}`, 503)
		return
	}
	if !aiRateOK() {
		je(w, `{"error":"AI rate limit exceeded — try again in a minute"}`, 429)
		return
	}
	defer aiRateDone()

	payload := map[string]interface{}{
		"stream":     true,
		"max_tokens": 2048,
		"messages": []map[string]interface{}{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
	}
	if llmGatewayModel != "" {
		payload["model"] = llmGatewayModel
	}
	reqBody, _ := json.Marshal(payload)

	slog.Debug("ai: POST request", "url", llmGatewayURL, "model", llmGatewayModel, "body_len", len(reqBody))

	req, err := http.NewRequest("POST", llmGatewayURL, bytes.NewReader(reqBody))
	if err != nil {
		je(w, `{"error":"failed to build LLM request"}`, 500)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if llmGatewayKey != "" {
		req.Header.Set("Authorization", "Bearer "+llmGatewayKey)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		slog.Error("ai: llm gateway error", "error", err)
		je(w, fmt.Sprintf("LLM Gateway error: %s", err.Error()), 502)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		slog.Error("ai: llm gateway returned non-200", "status", resp.StatusCode, "body", string(bodyBytes), "url", llmGatewayURL)
		je(w, fmt.Sprintf("LLM Gateway returned %d", resp.StatusCode), 502)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		je(w, "streaming not supported", 500)
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") { continue }
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" { break }

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil { continue }
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			data, _ := json.Marshal(map[string]string{"text": chunk.Choices[0].Delta.Content})
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
	fmt.Fprintf(w, "data: {\"done\":true}\n\n")
	flusher.Flush()
}

// ─── AI: API Handlers ────────────────────────────────────────────────


func apiAIDiagnose(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" { je(w, "POST only", 405); return }
	var body struct {
		Namespace string `json:"namespace"`
		Pod       string `json:"pod"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Pod == "" {
		je(w, `{"error":"namespace and pod are required"}`, 400); return
	}

	podCtx := buildPodDiagnosticContext(body.Namespace, body.Pod)
	if podCtx == "" {
		je(w, `{"error":"pod not found"}`, 404); return
	}

	systemPrompt := `You are a terse Kubernetes troubleshooter embedded in an ops dashboard. Space is precious.

Rules:
- Maximum 8-12 lines total. No filler, no greetings, no summaries.
- Use this exact format (skip sections that don't apply):

**Cause:** one sentence with the specific root cause
**Evidence:** bullet each signal (name, value, error text) — max 3 bullets
**Fix:** numbered kubectl commands or config changes — max 3 steps
**Prevent:** one sentence if applicable

- Reference exact container names, exit codes, error strings, timestamps.
- If the pod is healthy, reply with one line: "Pod is healthy — no issues detected."
- Never repeat the pod name/namespace or restate the question.
- Never use verbose headings, horizontal rules, or multi-paragraph explanations.`

	userPrompt := fmt.Sprintf("Diagnose this Kubernetes pod:\n\n%s", podCtx)

	streamLLM(w, systemPrompt, userPrompt)
}

func apiAISpotAnalysis(w http.ResponseWriter, r *http.Request) {
	spotCtx := buildSpotAdvisorContext()
	if spotCtx == "" {
		je(w, `{"error":"no spot data available"}`, 404); return
	}

	systemPrompt := `You are a terse AWS Spot-instance advisor in an ops dashboard. Space is precious.

Rules:
- Start with a ONE-line fleet summary (node count, monthly spend, avg interruption risk).
- Then a compact markdown table: columns Current Type | Nodes | Replace With | New Nodes | Monthly Δ | Interrupt Risk
- Below the table, max 3 bullet warnings (risky patterns, consolidation tips, family concentration).
- Use exact dollar amounts and instance names. No intros, no filler.`

	userPrompt := fmt.Sprintf("Analyze this Kubernetes spot instance fleet and provide optimization recommendations:\n\n%s", spotCtx)

	streamLLM(w, systemPrompt, userPrompt)
}

// ─── AI: Context builders ────────────────────────────────────────────


func buildPodDiagnosticContext(ns, podName string) string {
	cache.mu.RLock()

	if cache.pods == nil { cache.mu.RUnlock(); return "" }

	var targetPod *corev1.Pod
	for i := range cache.pods.Items {
		p := &cache.pods.Items[i]
		if p.Namespace == ns && p.Name == podName { targetPod = p; break }
	}
	if targetPod == nil { cache.mu.RUnlock(); return "" }

	var sb strings.Builder
	p := targetPod

	sb.WriteString(fmt.Sprintf("## Pod: %s/%s\n", p.Namespace, p.Name))
	sb.WriteString(fmt.Sprintf("Status: %s\n", podDisplayStatus(*p)))
	sb.WriteString(fmt.Sprintf("Phase: %s\n", p.Status.Phase))
	if p.Status.Reason != "" { sb.WriteString(fmt.Sprintf("Reason: %s\n", p.Status.Reason)) }
	if p.Status.Message != "" { sb.WriteString(fmt.Sprintf("Message: %s\n", p.Status.Message)) }
	sb.WriteString(fmt.Sprintf("Node: %s\n", p.Spec.NodeName))
	sb.WriteString(fmt.Sprintf("Age: %s\n", shortDur(time.Since(p.CreationTimestamp.Time))))
	if p.DeletionTimestamp != nil { sb.WriteString("⚠ Pod is being DELETED\n") }

	// Container statuses
	sb.WriteString("\n### Container Statuses:\n")
	for _, cs := range p.Status.ContainerStatuses {
		sb.WriteString(fmt.Sprintf("- Container: %s ready=%v restarts=%d\n", cs.Name, cs.Ready, cs.RestartCount))
		if cs.State.Running != nil {
			sb.WriteString(fmt.Sprintf("  State: Running since %s\n", shortDur(time.Since(cs.State.Running.StartedAt.Time))))
		}
		if cs.State.Waiting != nil {
			sb.WriteString(fmt.Sprintf("  State: Waiting reason=%s message=%s\n", cs.State.Waiting.Reason, cs.State.Waiting.Message))
		}
		if cs.State.Terminated != nil {
			t := cs.State.Terminated
			sb.WriteString(fmt.Sprintf("  State: Terminated reason=%s exitCode=%d signal=%d message=%s\n", t.Reason, t.ExitCode, t.Signal, t.Message))
		}
		if cs.LastTerminationState.Terminated != nil {
			t := cs.LastTerminationState.Terminated
			sb.WriteString(fmt.Sprintf("  LastTermination: reason=%s exitCode=%d finishedAt=%s\n", t.Reason, t.ExitCode, t.FinishedAt.Time.Format(time.RFC3339)))
		}
	}

	// Init container statuses
	for _, cs := range p.Status.InitContainerStatuses {
		sb.WriteString(fmt.Sprintf("- InitContainer: %s ready=%v restarts=%d\n", cs.Name, cs.Ready, cs.RestartCount))
		if cs.State.Waiting != nil {
			sb.WriteString(fmt.Sprintf("  State: Waiting reason=%s message=%s\n", cs.State.Waiting.Reason, cs.State.Waiting.Message))
		}
		if cs.State.Terminated != nil {
			t := cs.State.Terminated
			sb.WriteString(fmt.Sprintf("  State: Terminated reason=%s exitCode=%d\n", t.Reason, t.ExitCode))
		}
	}

	// Container names for log fetching
	containerNames := []string{}
	for _, c := range p.Spec.Containers {
		containerNames = append(containerNames, c.Name)
	}

	// Resource requests/limits
	sb.WriteString("\n### Container Specs:\n")
	for _, c := range p.Spec.Containers {
		sb.WriteString(fmt.Sprintf("- %s image=%s\n", c.Name, c.Image))
		if c.Resources.Requests != nil {
			sb.WriteString(fmt.Sprintf("  Requests: cpu=%s mem=%s\n", c.Resources.Requests.Cpu().String(), c.Resources.Requests.Memory().String()))
		}
		if c.Resources.Limits != nil {
			sb.WriteString(fmt.Sprintf("  Limits: cpu=%s mem=%s\n", c.Resources.Limits.Cpu().String(), c.Resources.Limits.Memory().String()))
		}
	}

	// Actual usage from metrics
	if cache.podMetrics != nil {
		for _, m := range cache.podMetrics.Items {
			if m.Namespace == ns && m.Name == podName {
				sb.WriteString("\n### Current Resource Usage:\n")
				for _, c := range m.Containers {
					sb.WriteString(fmt.Sprintf("- %s: cpu=%dm mem=%dMi\n", c.Name, c.Usage.Cpu().MilliValue(), c.Usage.Memory().Value()/(1024*1024)))
				}
			}
		}
	}

	// Conditions
	if len(p.Status.Conditions) > 0 {
		sb.WriteString("\n### Pod Conditions:\n")
		for _, c := range p.Status.Conditions {
			sb.WriteString(fmt.Sprintf("- %s=%s reason=%s message=%s\n", c.Type, c.Status, c.Reason, c.Message))
		}
	}

	// Node conditions (if the pod is on a troubled node)
	if cache.nodes != nil && p.Spec.NodeName != "" {
		for _, n := range cache.nodes.Items {
			if n.Name == p.Spec.NodeName {
				for _, c := range n.Status.Conditions {
					if c.Type != corev1.NodeReady && c.Status == corev1.ConditionTrue {
						sb.WriteString(fmt.Sprintf("\n⚠ Node %s has condition: %s=%s (%s)\n", n.Name, c.Type, c.Status, c.Message))
					}
					if c.Type == corev1.NodeReady && c.Status != corev1.ConditionTrue {
						sb.WriteString(fmt.Sprintf("\n⚠ Node %s is NOT READY: %s\n", n.Name, c.Message))
					}
				}
			}
		}
	}

	// Related events
	if cache.events != nil {
		sb.WriteString("\n### Related Events:\n")
		count := 0
		for _, e := range cache.events.Items {
			if e.InvolvedObject.Name == podName && e.InvolvedObject.Namespace == ns {
				sb.WriteString(fmt.Sprintf("- [%s] %s %s: %s\n", shortDur(time.Since(e.LastTimestamp.Time)), e.Type, e.Reason, e.Message))
				count++
				if count >= 30 { break }
			}
		}
		if count == 0 { sb.WriteString("No recent events\n") }
	}

	cache.mu.RUnlock()

	// Fetch live logs from each container (tail 100 lines, plus previous terminated logs)
	sb.WriteString("\n### Container Logs (tail 100):\n")
	tailLines := int64(100)
	for _, cName := range containerNames {
		// Current container logs
		opts := &corev1.PodLogOptions{Container: cName, TailLines: &tailLines}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		stream, err := clientset.CoreV1().Pods(ns).GetLogs(podName, opts).Stream(ctx)
		if err != nil {
			sb.WriteString(fmt.Sprintf("\n#### Container: %s\n(failed to fetch logs: %s)\n", cName, err.Error()))
			cancel()
			continue
		}
		logBytes, err := io.ReadAll(io.LimitReader(stream, 64*1024))
		stream.Close()
		cancel()
		if err != nil {
			sb.WriteString(fmt.Sprintf("\n#### Container: %s\n(error reading logs: %s)\n", cName, err.Error()))
			continue
		}
		logStr := string(logBytes)
		if logStr == "" { logStr = "(empty)" }
		sb.WriteString(fmt.Sprintf("\n#### Container: %s (current)\n```\n%s\n```\n", cName, logStr))

		// Previous terminated container logs (useful for CrashLoopBackOff)
		prevOpts := &corev1.PodLogOptions{Container: cName, TailLines: &tailLines, Previous: true}
		ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
		prevStream, err := clientset.CoreV1().Pods(ns).GetLogs(podName, prevOpts).Stream(ctx2)
		if err == nil {
			prevBytes, _ := io.ReadAll(io.LimitReader(prevStream, 64*1024))
			prevStream.Close()
			if len(prevBytes) > 0 {
				sb.WriteString(fmt.Sprintf("\n#### Container: %s (previous/crashed)\n```\n%s\n```\n", cName, string(prevBytes)))
			}
		}
		cancel2()
	}

	return sb.String()
}

func buildSpotAdvisorContext() string {
	spotCache.mu.RLock()
	defer spotCache.mu.RUnlock()
	cache.mu.RLock()
	defer cache.mu.RUnlock()

	if spotCache.entries == nil || cache.nodes == nil { return "" }

	var sb strings.Builder
	sb.WriteString("## Spot Instance Fleet Analysis\n\n")
	sb.WriteString(fmt.Sprintf("Region: %s\n", spotCache.region))

	// Build per-node usage map
	nodeUsage := map[string][2]int64{}
	if cache.nodeMetrics != nil {
		for _, m := range cache.nodeMetrics.Items {
			nodeUsage[m.Name] = [2]int64{m.Usage.Cpu().MilliValue(), m.Usage.Memory().Value() / (1024 * 1024)}
		}
	}

	// Collect spot nodes grouped by instance type
	type nodeInfo struct {
		Name     string
		CPU, Mem int64 // allocatable
		UsedCPU, UsedMem int64
		Nodepool string
	}
	typeNodes := map[string][]nodeInfo{}
	totalSpot := 0

	for _, n := range cache.nodes.Items {
		capType := n.Labels["karpenter.sh/capacity-type"]
		if capType == "" {
			if v, ok := n.Labels["eks.amazonaws.com/capacityType"]; ok { capType = strings.ToLower(v) }
		}
		if capType != "spot" { continue }
		totalSpot++

		itype := n.Labels["node.kubernetes.io/instance-type"]
		if itype == "" { itype = n.Labels["beta.kubernetes.io/instance-type"] }
		if itype == "" { continue }

		usage := nodeUsage[n.Name]
		typeNodes[itype] = append(typeNodes[itype], nodeInfo{
			Name: n.Name,
			CPU: n.Status.Allocatable.Cpu().MilliValue(),
			Mem: n.Status.Allocatable.Memory().Value() / (1024 * 1024),
			UsedCPU: usage[0], UsedMem: usage[1],
			Nodepool: n.Labels["karpenter.sh/nodepool"],
		})
	}

	sb.WriteString(fmt.Sprintf("Total spot nodes: %d across %d instance types\n\n", totalSpot, len(typeNodes)))

	sb.WriteString("### Current Spot Fleet:\n")
	sb.WriteString("InstanceType | Count | AllocCPU(m) | AllocMem(Mi) | AvgUsedCPU(m) | AvgUsedMem(Mi) | UtilCPU% | UtilMem% | SpotPrice | MonthlyPerNode | Interruption | Nodepools\n")

	for itype, nodes := range typeNodes {
		var totalAllocCPU, totalAllocMem, totalUsedCPU, totalUsedMem int64
		npSet := map[string]bool{}
		for _, n := range nodes {
			totalAllocCPU += n.CPU; totalAllocMem += n.Mem
			totalUsedCPU += n.UsedCPU; totalUsedMem += n.UsedMem
			if n.Nodepool != "" { npSet[n.Nodepool] = true }
		}
		cnt := len(nodes)
		avgCPU := totalUsedCPU / int64(cnt)
		avgMem := totalUsedMem / int64(cnt)
		utilCPU, utilMem := 0, 0
		if totalAllocCPU > 0 { utilCPU = int(totalUsedCPU * 100 / totalAllocCPU) }
		if totalAllocMem > 0 { utilMem = int(totalUsedMem * 100 / totalAllocMem) }
		price := spotCache.spotPrices[itype]
		entry := spotCache.entries[itype]
		nps := []string{}
		for np := range npSet { nps = append(nps, np) }

		sb.WriteString(fmt.Sprintf("%s | %d | %d | %d | %d | %d | %d%% | %d%% | $%.4f/hr | $%.0f/mo | %s | %s\n",
			itype, cnt, totalAllocCPU/int64(cnt), totalAllocMem/int64(cnt),
			avgCPU, avgMem, utilCPU, utilMem,
			price, price*730, interruptLabel(entry.R), strings.Join(nps, ",")))
	}

	// Available alternatives
	sb.WriteString("\n### Available Spot Alternatives (same architecture):\n")
	sb.WriteString("CurrentType | Alternative | AltCPU | AltMemGB | AltPrice | AltInterrupt | Savings%\n")
	for itype := range typeNodes {
		alts := generateAlternatives(itype)
		shown := 0
		for _, alt := range alts {
			if shown >= 5 { break }
			entry, ok := spotCache.entries[alt]
			if !ok { continue }
			spec, ok := spotCache.typeSpecs[alt]
			if !ok { continue }
			price := spotCache.spotPrices[alt]
			sb.WriteString(fmt.Sprintf("%s | %s | %d | %.1f | $%.4f/hr | %s | %d%%\n",
				itype, alt, spec.Cores, spec.RamGB, price, interruptLabel(entry.R), entry.S))
			shown++
		}
	}

	return sb.String()
}
