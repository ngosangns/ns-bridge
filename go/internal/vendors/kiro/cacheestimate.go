package kiro

// Cross-turn cache-read estimation. The TypeScript facade used to hold this
// in a process-local map; the one-call binary keeps the same map in the
// process-state file. The rules match cache-estimator.ts.

import (
	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
)

const maxTrackedConversations = 128

type cacheEstimate struct {
	ConversationID string `json:"conversationId"`
	PromptTokens   int    `json:"promptTokens"`
	TurnTimestamp  int64  `json:"turnTimestamp"`
}

// applyCacheEstimate reclassifies repeated prompt input as a cache read.
// It mutates usage only when every conservative guard passes. Real wire
// cache counters always win. The returned count is the tokens moved.
func applyCacheEstimate(st *processState, conversationID string, usage *bridge.Usage, wireReported bool, cfg *UsageTracking, now int64) int {
	previous, hasPrevious := findEstimate(st, conversationID)
	cacheRead, cacheWrite := 0, 0
	if usage.CacheRead != nil {
		cacheRead = *usage.CacheRead
	}
	if usage.CacheWrite != nil {
		cacheWrite = *usage.CacheWrite
	}
	promptTokens := usage.Input + cacheRead + cacheWrite + usage.Output

	if wireReported {
		if cfg != nil && cfg.EstimateCacheUsage && !st.WarnedWireCache {
			st.WarnedWireCache = true
			logx.Warn("[kiro-core] Kiro now reports cache token counters; cache estimation was skipped and may be disabled.")
		}
		noteSuccessfulTurn(st, conversationID, promptTokens, usage.Input, now)
		return 0
	}
	if cfg == nil || !cfg.EstimateCacheUsage || usage.Input <= 0 {
		return 0
	}
	if !hasPrevious {
		noteSuccessfulTurn(st, conversationID, promptTokens, usage.Input, now)
		return 0
	}
	expired := cfg.EstimatedCacheTimeout > 0 && float64(now-previous.TurnTimestamp) > cfg.EstimatedCacheTimeout
	contextShrank := float64(usage.Input) < float64(previous.PromptTokens)*0.6
	if expired || contextShrank {
		noteSuccessfulTurn(st, conversationID, promptTokens, usage.Input, now)
		return 0
	}
	estimatedRead := previous.PromptTokens
	if usage.Input < estimatedRead {
		estimatedRead = usage.Input
	}
	if estimatedRead > 0 {
		usage.Input -= estimatedRead
		next := cacheRead + estimatedRead
		usage.CacheRead = &next
		estimated := true
		usage.CacheEstimated = &estimated
	}
	noteSuccessfulTurn(st, conversationID, promptTokens, promptTokens, now)
	if estimatedRead > 0 {
		debugLog("usage.estimate", map[string]any{
			"conversationId": conversationID,
			"estimatedRead":  estimatedRead,
			"input":          usage.Input,
			"cacheRead":      cacheRead + estimatedRead,
		})
	}
	return estimatedRead
}

func findEstimate(st *processState, conversationID string) (cacheEstimate, bool) {
	for i := len(st.Estimates) - 1; i >= 0; i-- {
		if st.Estimates[i].ConversationID == conversationID {
			return st.Estimates[i], true
		}
	}
	return cacheEstimate{}, false
}

func noteSuccessfulTurn(st *processState, conversationID string, promptTokens, input int, now int64) {
	if input <= 0 || promptTokens <= 0 || conversationID == "" {
		return
	}
	next := make([]cacheEstimate, 0, len(st.Estimates)+1)
	for _, entry := range st.Estimates {
		if entry.ConversationID != conversationID {
			next = append(next, entry)
		}
	}
	next = append(next, cacheEstimate{ConversationID: conversationID, PromptTokens: promptTokens, TurnTimestamp: now})
	if len(next) > maxTrackedConversations {
		next = next[len(next)-maxTrackedConversations:]
	}
	st.Estimates = next
}
