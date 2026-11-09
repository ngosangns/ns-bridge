// ABOUTME: Tests the Qoder usage split against the neutral counters every host checks.
// ABOUTME: The case that mattered in production is 69,005 prompt with 68,577 cached reporting 0% cache hit.

import { describe, expect, it } from "vitest";
import { type QoderWireUsage, toQoderUsage } from "../src/usage.js";

function wire(overrides: QoderWireUsage): QoderWireUsage {
  return { prompt_tokens: 100, completion_tokens: 10, ...overrides };
}

describe("toQoderUsage", () => {
  it("splits cached tokens out of prompt_tokens", () => {
    const usage = toQoderUsage(wire({ prompt_cache_hit_tokens: 60 }));
    expect(usage.input).toBe(40);
    expect(usage.cacheRead).toBe(60);
    expect(usage.output).toBe(10);
    expect(usage.totalTokens).toBe(110);
  });

  it.each([
    ["prompt_cache_hit_tokens", wire({ prompt_cache_hit_tokens: 60 })],
    ["prompt_tokens_details.cached_tokens", wire({ prompt_tokens_details: { cached_tokens: 60 } })],
    ["both counters", wire({ prompt_cache_hit_tokens: 60, prompt_tokens_details: { cached_tokens: 60 } })],
  ])("keeps the host sum check when the cache arrives as %s", (_label, input) => {
    const usage = toQoderUsage(input);
    expect(usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + usage.output).toBe(usage.totalTokens);
  });

  it("reports a warm prefix as a full hit", () => {
    const usage = toQoderUsage(
      wire({ prompt_tokens: 69_005, completion_tokens: 300, prompt_cache_hit_tokens: 68_577 }),
    );
    expect(usage.input).toBe(428);
    expect(usage.cacheRead).toBe(68_577);
    expect(usage.totalTokens).toBe(69_305);
  });

  it("clamps a cache counter that exceeds prompt_tokens", () => {
    const usage = toQoderUsage(wire({ prompt_cache_hit_tokens: 250 }));
    expect(usage.cacheRead).toBe(100);
    expect(usage.input).toBe(0);
    expect(usage.totalTokens).toBe(110);
  });

  it("omits cacheRead for a cold prefix with no counters", () => {
    const usage = toQoderUsage(wire({}));
    expect(usage.cacheRead).toBeUndefined();
    expect(usage.input).toBe(100);
    expect(usage.totalTokens).toBe(110);
  });

  it("treats null and negative counters as zero", () => {
    const usage = toQoderUsage(
      wire({ prompt_cache_hit_tokens: null, prompt_tokens_details: { cached_tokens: -5 }, completion_tokens: -1 }),
    );
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(0);
    expect(usage.totalTokens).toBe(100);
  });

  it("does not read the total field because the wire does not send one", () => {
    const usage = toQoderUsage(wire({ prompt_cache_hit_tokens: 60, total_tokens: 999 } as QoderWireUsage));
    expect(usage.totalTokens).toBe(110);
  });
});
