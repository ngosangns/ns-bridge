import { describe, expect, it } from "vitest";
import { COMPACTION_RESERVE_FLOOR, compactionBudget } from "../src/compaction.js";

/**
 * What the Harness compacts at with its built-in defaults: 80% of the window,
 * or the window minus the reservation and its 65,536 headroom, whichever is
 * smaller. Mirrored here so a change to the reservation shows up as a change
 * to the trigger, not just as a different integer.
 */
const HARNESS_HEADROOM = 65_536;
const HARNESS_RATIO = 0.8;

function harnessThreshold(contextWindow: number, reserved: number): number {
  return Math.floor(Math.min(contextWindow * HARNESS_RATIO, contextWindow - reserved - HARNESS_HEADROOM));
}

describe("compactionBudget", () => {
  it("holds back Pi's 16,384 instead of a 128k completion ceiling", () => {
    // grok-4.7. Reserving the whole ceiling triggers near 62k of a 256k window.
    const budget = compactionBudget({ contextWindow: 256_000, maxTokens: 128_000 });
    expect(budget).toEqual({ reserveTokens: COMPACTION_RESERVE_FLOOR, thresholdTokens: 239_616 });
    expect(harnessThreshold(256_000, 128_000)).toBe(62_464);
    expect(harnessThreshold(256_000, budget?.reserveTokens ?? 0)).toBe(174_080);
  });

  it("does the same for a 200k window whose ceiling is most of the window", () => {
    // Devin's swe-1-6. The 80% ratio still loses to the headroom, but the
    // trigger moves from ~6k to ~118k.
    const budget = compactionBudget({ contextWindow: 200_000, maxTokens: 128_000 });
    expect(budget).toEqual({ reserveTokens: 16_384, thresholdTokens: 183_616 });
    expect(harnessThreshold(200_000, 128_000)).toBe(6_464);
    expect(harnessThreshold(200_000, budget?.reserveTokens ?? 0)).toBe(118_080);
  });

  it("keeps a ceiling that is already at or below the floor", () => {
    // Kiro's small models. Their ceiling is a fair reservation already.
    expect(compactionBudget({ contextWindow: 200_000, maxTokens: 8_192 })).toEqual({
      reserveTokens: 8_192,
      thresholdTokens: 191_808,
    });
    expect(compactionBudget({ contextWindow: 200_000, maxTokens: 16_384 })).toEqual({
      reserveTokens: 16_384,
      thresholdTokens: 183_616,
    });
    expect(compactionBudget({ contextWindow: 1_000_000, maxTokens: 32_768 })).toEqual({
      reserveTokens: 16_384,
      thresholdTokens: 983_616,
    });
  });

  it("returns undefined when the input cannot be a budget", () => {
    expect(compactionBudget({ contextWindow: 0, maxTokens: 128_000 })).toBeUndefined();
    expect(compactionBudget({ contextWindow: -1, maxTokens: 128_000 })).toBeUndefined();
    expect(compactionBudget({ contextWindow: Number.NaN, maxTokens: 128_000 })).toBeUndefined();
    expect(compactionBudget({ contextWindow: 256_000, maxTokens: 0 })).toBeUndefined();
    expect(compactionBudget({ contextWindow: 256_000, maxTokens: -5 })).toBeUndefined();
    expect(compactionBudget({ contextWindow: 256_000, maxTokens: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("does not shrink a window that cannot hold the floor", () => {
    expect(compactionBudget({ contextWindow: 16_384, maxTokens: 8_192 })).toEqual({
      reserveTokens: 8_192,
      thresholdTokens: 8_192,
    });
    expect(compactionBudget({ contextWindow: 8_000, maxTokens: 8_000 })).toEqual({
      reserveTokens: 8_000,
      thresholdTokens: 0,
    });
  });

  it("floors a fractional ceiling instead of reporting a float", () => {
    expect(compactionBudget({ contextWindow: 256_000, maxTokens: 100.9 })).toEqual({
      reserveTokens: 100,
      thresholdTokens: 255_900,
    });
  });
});
