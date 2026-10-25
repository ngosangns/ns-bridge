// ABOUTME: Tests usage mapping and the pricing math from arnict.com/docs/pricing.
// ABOUTME: The example case is 1M prompt (40% cached) + 10k output on the flash model = 0.1 USD.

import { describe, expect, it } from "vitest";
import { ARNICT_KNOWN_MODELS } from "../src/catalog.js";
import { type ArnictWireUsage, toArnictUsage } from "../src/usage.js";

const FLASH_RATES = ARNICT_KNOWN_MODELS.find((model) => model.id === "zai/glm-5.3-flash-uncensored")?.rates;

function wire(overrides: ArnictWireUsage): ArnictWireUsage {
  return { prompt_tokens: 1_000, completion_tokens: 100, ...overrides };
}

describe("toArnictUsage", () => {
  it("splits prompt from cache and prices the flash example to 0.1 USD", () => {
    const usage = toArnictUsage(
      wire({ prompt_tokens: 1_000_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 400_000 } }),
      FLASH_RATES,
    );
    expect(usage.input).toBe(600_000);
    expect(usage.cacheRead).toBe(400_000);
    expect(usage.output).toBe(10_000);
    expect(usage.totalTokens).toBe(1_010_000);
    expect(usage.cost.input).toBeCloseTo(0.075, 12);
    expect(usage.cost.cacheRead).toBeCloseTo(0.02, 12);
    expect(usage.cost.output).toBeCloseTo(0.005, 12);
    expect(usage.cost.cacheWrite).toBe(0);
    expect(usage.cost.total).toBeCloseTo(0.1, 12);
    expect(usage.credits).toBeCloseTo(0.1, 12);
    expect(usage.creditUnit).toBe("USD");
  });

  it("prices a prompt with no cache details at the input rate", () => {
    const usage = toArnictUsage(wire({ prompt_tokens: 2_000_000, completion_tokens: 0 }), FLASH_RATES);
    expect(usage.cacheRead).toBe(0);
    expect(usage.cost.input).toBeCloseTo(0.25, 12);
    expect(usage.cost.total).toBeCloseTo(0.25, 12);
  });

  it.each([
    ["top-level cached_tokens", { cached_tokens: 100 } as ArnictWireUsage],
    ["prompt_cache_hit_tokens", { prompt_cache_hit_tokens: 100 } as ArnictWireUsage],
  ])("reads cache hits from %s when the details block is absent", (_label, extra) => {
    const usage = toArnictUsage(wire({ ...extra }), FLASH_RATES);
    expect(usage.cacheRead).toBe(100);
    expect(usage.input).toBe(900);
  });

  it("prefers the details block over the fallbacks", () => {
    const usage = toArnictUsage(
      wire({ prompt_tokens_details: { cached_tokens: 300 }, cached_tokens: 100, prompt_cache_hit_tokens: 50 }),
      FLASH_RATES,
    );
    expect(usage.cacheRead).toBe(300);
  });

  it("clamps cache hits to the prompt size", () => {
    const usage = toArnictUsage(
      wire({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } }),
      FLASH_RATES,
    );
    expect(usage.cacheRead).toBe(100);
    expect(usage.input).toBe(0);
    expect(usage.totalTokens).toBe(200);
  });

  it("keeps the reported total instead of recomputing it", () => {
    const usage = toArnictUsage(wire({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 1_000 }), FLASH_RATES);
    expect(usage.totalTokens).toBe(1_000);
  });

  it("treats garbage counters as zero", () => {
    const usage = toArnictUsage(
      wire({ prompt_tokens: -5, completion_tokens: Number.NaN, total_tokens: Number.POSITIVE_INFINITY }),
      FLASH_RATES,
    );
    expect(usage).toMatchObject({
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      credits: 0,
    });
  });

  it("stays at zero cost and no credits when the model has no published rates", () => {
    const usage = toArnictUsage(
      wire({ prompt_tokens: 1_000_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 400_000 } }),
    );
    expect(usage.input).toBe(600_000);
    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    expect(usage.credits).toBeUndefined();
    expect(usage.creditUnit).toBeUndefined();
  });
});
