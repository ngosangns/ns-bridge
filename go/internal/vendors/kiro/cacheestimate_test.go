package kiro

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
)

func estUsage(input, output int) bridge.Usage {
	return bridge.Usage{Input: input, Output: output, TotalTokens: input + output}
}

func estOn(timeout float64) *UsageTracking {
	return &UsageTracking{EstimateCacheUsage: true, EstimatedCacheTimeout: timeout, USDPerCredit: 0.04}
}

func TestCacheEstimateSplitsRepeatedContext(t *testing.T) {
	st := &processState{}
	cfg := estOn(300_000)
	first := estUsage(10_000, 500)
	if got := applyCacheEstimate(st, "s", &first, false, cfg, 1_000); got != 0 {
		t.Fatalf("first turn = %d", got)
	}
	if first.CacheEstimated != nil {
		t.Fatal("first turn marked estimated")
	}
	second := estUsage(12_000, 200)
	if got := applyCacheEstimate(st, "s", &second, false, cfg, 2_000); got != 10_500 {
		t.Fatalf("second turn = %d", got)
	}
	if second.Input != 1_500 || second.CacheRead == nil || *second.CacheRead != 10_500 || second.CacheEstimated == nil || !*second.CacheEstimated {
		t.Fatalf("second usage = %+v cache=%v", second, second.CacheRead)
	}
	if second.TotalTokens != 12_200 {
		t.Fatalf("totalTokens = %d", second.TotalTokens)
	}
}

func TestCacheEstimateDisabled(t *testing.T) {
	st := &processState{}
	off := &UsageTracking{EstimatedCacheTimeout: 300_000}
	first := estUsage(10_000, 100)
	if applyCacheEstimate(st, "s", &first, false, off, 1_000) != 0 {
		t.Fatal("disabled first")
	}
	next := estUsage(12_000, 100)
	if applyCacheEstimate(st, "s", &next, false, off, 2_000) != 0 || next.CacheRead != nil {
		t.Fatalf("disabled next = %+v", next)
	}
}

func TestCacheEstimateWireCountersWin(t *testing.T) {
	st := &processState{}
	cfg := estOn(300_000)
	var buf bytes.Buffer
	logx.SetOutput(&buf)
	t.Cleanup(func() { logx.SetOutput(os.Stderr) })
	first := estUsage(10_000, 100)
	applyCacheEstimate(st, "s", &first, true, cfg, 1_000)
	next := estUsage(12_000, 100)
	applyCacheEstimate(st, "s", &next, true, cfg, 2_000)
	if next.CacheRead != nil || next.CacheEstimated != nil {
		t.Fatalf("wire turn was estimated: %+v", next)
	}
	if !st.WarnedWireCache {
		t.Fatal("warning flag not stored")
	}
	if bytes.Count(buf.Bytes(), []byte("cache token counters")) != 1 {
		t.Fatalf("warn count:\n%s", buf.String())
	}
}

func TestCacheEstimateIgnoresZeroInput(t *testing.T) {
	st := &processState{}
	cfg := estOn(300_000)
	first := estUsage(10_000, 100)
	applyCacheEstimate(st, "s", &first, false, cfg, 1_000)
	zero := estUsage(0, 0)
	applyCacheEstimate(st, "s", &zero, false, cfg, 2_000)
	next := estUsage(12_000, 100)
	if got := applyCacheEstimate(st, "s", &next, false, cfg, 3_000); got != 10_100 {
		t.Fatalf("got %d", got)
	}
}

func TestCacheEstimateResetsOnShrink(t *testing.T) {
	st := &processState{}
	cfg := estOn(300_000)
	applyCacheEstimate(st, "s", usagePtr(estUsage(10_000, 100)), false, cfg, 1_000)
	compacted := estUsage(5_000, 100)
	if applyCacheEstimate(st, "s", &compacted, false, cfg, 2_000) != 0 {
		t.Fatal("shrink should reset")
	}
	next := estUsage(6_000, 100)
	if got := applyCacheEstimate(st, "s", &next, false, cfg, 3_000); got != 5_100 {
		t.Fatalf("got %d", got)
	}
}

func TestCacheEstimateResetsOnTimeout(t *testing.T) {
	st := &processState{}
	cfg := estOn(300_000)
	applyCacheEstimate(st, "s", usagePtr(estUsage(10_000, 100)), false, cfg, 1_000)
	expired := estUsage(12_000, 100)
	if applyCacheEstimate(st, "s", &expired, false, cfg, 400_001) != 0 {
		t.Fatal("timeout should reset")
	}
	next := estUsage(13_000, 100)
	if got := applyCacheEstimate(st, "s", &next, false, cfg, 401_000); got != 12_100 {
		t.Fatalf("got %d", got)
	}
}

func TestCacheEstimateTimeoutZero(t *testing.T) {
	st := &processState{}
	cfg := estOn(0)
	applyCacheEstimate(st, "s", usagePtr(estUsage(10_000, 100)), false, cfg, 1_000)
	next := estUsage(12_000, 100)
	if got := applyCacheEstimate(st, "s", &next, false, cfg, 10_000_000); got != 10_100 {
		t.Fatalf("got %d", got)
	}
}

func TestCacheEstimateConversationsAreIndependent(t *testing.T) {
	st := &processState{}
	cfg := estOn(300_000)
	applyCacheEstimate(st, "a", usagePtr(estUsage(10_000, 100)), false, cfg, 1_000)
	applyCacheEstimate(st, "b", usagePtr(estUsage(4_000, 100)), false, cfg, 1_000)
	a := estUsage(12_000, 100)
	b := estUsage(5_000, 100)
	if got := applyCacheEstimate(st, "a", &a, false, cfg, 2_000); got != 10_100 {
		t.Fatalf("a = %d", got)
	}
	if got := applyCacheEstimate(st, "b", &b, false, cfg, 2_000); got != 4_100 {
		t.Fatalf("b = %d", got)
	}
}

func TestProcessStatePersistsEstimateAndProfile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KIRO_PROCESS_STATE_PATH", filepath.Join(dir, "state.json"))
	cfg := estOn(300_000)
	auth := managementAuth{accessToken: "token", region: "us-east-1"}
	key := profileCacheKey(auth)

	updateProcessState(func(st *processState) {
		usage := estUsage(10_000, 100)
		applyCacheEstimate(st, "s", &usage, false, cfg, 1_000)
		cache := newProfileCache(nil)
		cache.set(auth, "arn:1")
		cache.setRegion(key, "eu-central-1")
		cache.writeTo(st)
	})
	var second bridge.Usage
	updateProcessState(func(st *processState) {
		second = estUsage(12_000, 100)
		if got := applyCacheEstimate(st, "s", &second, false, cfg, 2_000); got != 10_100 {
			t.Fatalf("persisted estimate = %d", got)
		}
	})
	if second.CacheRead == nil || *second.CacheRead != 10_100 {
		t.Fatalf("second = %+v", second)
	}
	st := peekProcessState()
	if st.ProfileArns[key] != "arn:1" || st.ProfileRegions[key] != "eu-central-1" {
		t.Fatalf("profiles = %#v %#v", st.ProfileArns, st.ProfileRegions)
	}

	cache := newProfileCache(nil)
	cache.invalidate(auth)
	updateProcessState(func(st *processState) { cache.writeTo(st) })
	st = peekProcessState()
	if _, ok := st.ProfileArns[key]; ok {
		t.Fatalf("arn survived invalidate: %#v", st.ProfileArns)
	}
	if _, ok := st.ProfileRegions[key]; ok {
		t.Fatalf("region survived invalidate: %#v", st.ProfileRegions)
	}
}

func usagePtr(u bridge.Usage) *bridge.Usage { return &u }
