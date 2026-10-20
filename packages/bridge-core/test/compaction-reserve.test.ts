import { describe, expect, it } from "vitest";
import { compactionReserveTokens } from "../src/dsh/adapter.js";

/**
 * What the Harness actually compacts at, with its built-in defaults: 80% of the
 * window, or the window minus the reservation and its 65,536 headroom,
 * whichever is smaller. Mirrored here so a change to the reservation shows up
 * as a change to the trigger, not just as a different integer.
 */
const HARNESS_HEADROOM = 65_536;
const HARNESS_RATIO = 0.8;

function harnessThreshold(contextWindow: number, reserved: number): number {
  return Math.floor(Math.min(contextWindow * HARNESS_RATIO, contextWindow - reserved - HARNESS_HEADROOM));
}

describe("compactionReserveTokens", () => {
  it("holds back Pi's 16,384 instead of a 128k completion ceiling", () => {
    // grok-4.7: reserving the whole ceiling triggers near 62k of a 256k window.
    expect(compactionReserveTokens({ contextWindow: 256_000, maxTokens: 128_000 })).toBe(16_384);
    expect(harnessThreshold(256_000, 128_000)).toBe(62_464);
    expect(harnessThreshold(256_000, 16_384)).toBe(174_080);
  });

  it("does the same for a 200k window whose ceiling is most of the window", () => {
    // Devin's swe-1-6. The 80% ratio still loses to the headroom, but the
    // trigger moves from ~6k to ~118k.
    expect(compactionReserveTokens({ contextWindow: 200_000, maxTokens: 128_000 })).toBe(16_384);
    expect(harnessThreshold(200_000, 128_000)).toBe(6_464);
    expect(harnessThreshold(200_000, 16_384)).toBe(118_080);
  });

  it("leaves a ceiling that is already at or below the floor on the ceiling", () => {
    // Kiro's small models. Their ceiling is a fair reservation already, so the
    // caller reports nothing and the Harness keeps using the ceiling.
    expect(compactionReserveTokens({ contextWindow: 200_000, maxTokens: 8_192 })).toBe(8_192);
    expect(compactionReserveTokens({ contextWindow: 200_000, maxTokens: 16_384 })).toBe(16_384);
    expect(compactionReserveTokens({ contextWindow: 1_000_000, maxTokens: 32_768 })).toBe(16_384);
  });

  it("returns undefined when the input cannot be a reservation", () => {
    expect(compactionReserveTokens({ contextWindow: 0, maxTokens: 128_000 })).toBeUndefined();
    expect(compactionReserveTokens({ contextWindow: -1, maxTokens: 128_000 })).toBeUndefined();
    expect(compactionReserveTokens({ contextWindow: Number.NaN, maxTokens: 128_000 })).toBeUndefined();
    expect(compactionReserveTokens({ contextWindow: 256_000, maxTokens: 0 })).toBeUndefined();
    expect(compactionReserveTokens({ contextWindow: 256_000, maxTokens: -5 })).toBeUndefined();
    expect(compactionReserveTokens({ contextWindow: 256_000, maxTokens: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("does not shrink a window that cannot hold the floor", () => {
    expect(compactionReserveTokens({ contextWindow: 16_384, maxTokens: 8_192 })).toBeUndefined();
    expect(compactionReserveTokens({ contextWindow: 8_000, maxTokens: 8_000 })).toBeUndefined();
  });

  it("floors a fractional ceiling instead of reporting a float", () => {
    expect(compactionReserveTokens({ contextWindow: 256_000, maxTokens: 100.9 })).toBe(100);
  });
});
