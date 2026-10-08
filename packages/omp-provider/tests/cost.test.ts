import { describe, expect, it } from "vitest";

import { calculateCost } from "../src/compat/cost.js";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("calculateCost", () => {
  it("prices per million tokens and mutates usage.cost", () => {
    const u = usage(1_000_000, 500_000, 2_000_000, 100_000);
    const cost = calculateCost({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, u);
    expect(cost).toBe(u.cost);
    expect(cost.input).toBeCloseTo(3);
    expect(cost.output).toBeCloseTo(7.5);
    expect(cost.cacheRead).toBeCloseTo(0.6);
    expect(cost.cacheWrite).toBeCloseTo(0.375);
    expect(cost.total).toBeCloseTo(11.475);
  });

  it("uses the highest matching tier", () => {
    const u = usage(300_000, 0);
    calculateCost(
      { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 200_000, input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }] } },
      u,
    );
    expect(u.cost.input).toBeCloseTo(0.6);
  });

  it("treats a model without cost as free", () => {
    const u = usage(10, 10);
    expect(calculateCost({}, u).total).toBe(0);
  });
});
