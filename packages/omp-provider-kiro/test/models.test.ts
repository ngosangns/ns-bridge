// ABOUTME: Tests projecting Kiro catalog rows onto OMP model configs, including the window tiers OMP compacts in.
// ABOUTME: OMP runs `contextWindow` by default and widens to `maxContextWindow` only on opt-in.

import type { KiroModel } from "ns-kiro-core";
import { describe, expect, it } from "vitest";
import { ompWindowForThreshold, toOmpModelConfig } from "../src/models.js";

const row = (id: string, contextWindow: number): KiroModel => ({
  id,
  kiroModelId: id,
  name: id,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 128_000,
});

describe("toOmpModelConfig windows", () => {
  it("registers luna at its standard-price window with Kiro's window as the extended tier", () => {
    const config = toOmpModelConfig(row("gpt-5-6-luna", 922_000));
    expect(config.contextWindow).toBe(272_000);
    expect(config.maxContextWindow).toBe(922_000);
  });

  it("registers a flat-priced Claude 1M model at the window that compacts at 150K", () => {
    const config = toOmpModelConfig(row("claude-sonnet-5-5", 1_000_000));
    expect(config.contextWindow).toBe(176_470);
    expect(config.maxContextWindow).toBe(1_000_000);
  });

  it("lands OMP's default threshold exactly on the target at the returned window", () => {
    const window = ompWindowForThreshold(150_000);
    expect(window).toBe(176_470);
    expect(window - Math.max(Math.floor(window * 0.15), 16_384)).toBe(150_000);
    expect(window - 1 - Math.max(Math.floor((window - 1) * 0.15), 16_384)).toBeLessThan(150_000);
  });

  it("keeps a 200K Claude window whole with no extended tier", () => {
    const config = toOmpModelConfig(row("claude-haiku-4-5", 200_000));
    expect(config.contextWindow).toBe(200_000);
    expect(config).not.toHaveProperty("maxContextWindow");
  });
});
