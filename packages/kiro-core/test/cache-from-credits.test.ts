// ABOUTME: Tests for deriving a Kiro cache-hit ratio from the credits Kiro bills.
// ABOUTME: Fixtures are real turns measured against live Kiro on 2026-10-21; each states the truth the experiment fixed.

import { describe, expect, it } from "vitest";
import {
  applyCreditDerivedCache,
  deriveKiroCacheFromCredits,
  KIRO_MIN_PROMPT_TOKENS,
} from "../src/cache-from-credits.js";

const unit = "credit";
const HAIKU = { model: "claude-haiku-4-5", rateMultiplier: 0.4, creditUnit: unit };
const SONNET = { model: "claude-sonnet-5-5", rateMultiplier: 1.3, creditUnit: unit };
const OPUS = { model: "claude-opus-5", rateMultiplier: 2.2, creditUnit: unit };

/** [prompt, output, credits, tokensActuallyAppended]: a warm prefix plus a known number of new tokens. */
const appended = (model: typeof HAIKU, prompt: number, output: number, credits: number) =>
  deriveKiroCacheFromCredits({ ...model, promptTokens: prompt, outputTokens: output, credits });

describe("deriveKiroCacheFromCredits", () => {
  it("finds the cached share when a known number of tokens was appended to a warm prefix", () => {
    // [model, prompt, output, credits, tokens appended]. The appended count is what the experiment fixed.
    const cases: Array<[typeof HAIKU, number, number, number, number]> = [
      [HAIKU, 31088, 1, 0.03141, 1775],
      [HAIKU, 30540, 1, 0.02777, 1226],
      [HAIKU, 32142, 1, 0.03839, 2826],
      [OPUS, 37986, 1, 0.20624, 2029],
      [OPUS, 38989, 1, 0.24286, 3033],
      [SONNET, 36997, 1, 0.1625, 4231],
      [SONNET, 39301, 1, 0.27034, 9533],
    ];
    for (const [model, prompt, output, credits, added] of cases) {
      const out = appended(model, prompt, output, credits);
      expect(out?.exact, `${model.model} +${added}`).toBe(true);
      if (!out?.exact) continue;
      const truth = prompt - added;
      // Within 1% of the prompt: the fit is exact to a few hundred tokens.
      expect(Math.abs(out.cacheRead - truth) / prompt, `${model.model} +${added}`).toBeLessThan(0.01);
    }
  });

  it("reads a fully repeated prefix as fully cached, for every model", () => {
    for (const [model, prompt, output, credits] of [
      [HAIKU, 29332, 1, 0.01977],
      [OPUS, 32981, 1, 0.12217],
      [SONNET, 32794, 1, 0.07183],
    ] as const) {
      const out = appended(model, prompt, output, credits);
      expect(out?.exact).toBe(true);
      if (out?.exact) expect(out.cacheRead / prompt).toBeGreaterThan(0.99);
    }
  });

  it("says only 'at most' when the bill sits on the cold cap, because a cached prefix can reach it too", () => {
    // Appended 5k to a warm 34k prefix (86% cached) and 6k to 38k: both billed exactly as a cold prompt.
    for (const [model, prompt, credits] of [
      [HAIKU, 34341, 0.04345],
      [HAIKU, 38340, 0.04849],
      [OPUS, 39002, 0.27532],
      [HAIKU, 14298, 0.01819], // a genuinely cold first turn
    ] as const) {
      const out = appended(model, prompt, 1, credits);
      expect(out?.exact, `${prompt}`).toBe(false);
      if (out && !out.exact) {
        expect(out.maxRatio).toBeGreaterThan(0.85);
        expect(out.maxRatio).toBeLessThan(0.92);
      }
    }
  });

  it("uses sonnet's own, higher cold cap", () => {
    // A cold sonnet prompt bills at twice the haiku/opus cap, so against the standard cap it would look off the scale.
    const cold = appended(SONNET, 23748, 1, 0.18998);
    expect(cold?.exact).toBe(false);
    if (cold && !cold.exact) expect(cold.maxRatio).toBeGreaterThan(0.65);
    const warm = appended(SONNET, 23764, 1, 0.05219);
    expect(warm?.exact).toBe(true);
  });

  it("subtracts the output term before pricing the prompt", () => {
    // 299 output tokens on a warm 24k Sonnet prompt: 0.10148 credits, not 0.052.
    const out = appended(SONNET, 24377, 299, 0.10148);
    expect(out?.exact).toBe(true);
    if (out?.exact) expect(out.cacheRead / 24377).toBeGreaterThan(0.98);
  });

  it("answers nothing when it cannot answer", () => {
    const base = { ...HAIKU, promptTokens: 20000, outputTokens: 10, credits: 0.03 };
    expect(deriveKiroCacheFromCredits({ ...base, rateMultiplier: undefined })).toBeUndefined();
    expect(deriveKiroCacheFromCredits({ ...base, rateMultiplier: 0 })).toBeUndefined();
    expect(deriveKiroCacheFromCredits({ ...base, credits: undefined })).toBeUndefined();
    expect(deriveKiroCacheFromCredits({ ...base, credits: 0 })).toBeUndefined();
    expect(deriveKiroCacheFromCredits({ ...base, creditUnit: "acu" })).toBeUndefined();
    expect(deriveKiroCacheFromCredits({ ...base, promptTokens: KIRO_MIN_PROMPT_TOKENS - 1 })).toBeUndefined();
    expect(deriveKiroCacheFromCredits({ ...base, promptTokens: Number.NaN })).toBeUndefined();
  });

  it("refuses a model whose name looks like a measured one but whose cap was not measured", () => {
    // Real sonnet-4-6 turns from the verification batch. Against sonnet-5-5's cap (0.00614) they read 90% cached
    // when 74.6% was; sonnet-4-6 saturates at the standard cap, so the name must not select the cap.
    for (const [prompt, credits] of [
      [43340, 0.17809],
      [36540, 0.15023],
    ] as const) {
      expect(
        deriveKiroCacheFromCredits({
          ...SONNET,
          model: "claude-sonnet-4-6",
          promptTokens: prompt,
          outputTokens: 1,
          credits,
        }),
      ).toBeUndefined();
    }
  });

  it("reads auto at its own multiplier: warm up to 565k tokens is cached, a cold first turn is on the cap", () => {
    // Real OMP turns from the usage ledger, 2026-10-28. Auto has no long-context tier, so a 525k prompt floors at `cached`.
    const AUTO = { model: "auto", rateMultiplier: 1, creditUnit: unit };
    const warm = appended(AUTO, 524825, 32, 0.88466);
    expect(warm?.exact).toBe(true);
    if (warm?.exact) expect(warm.cacheRead / 524825).toBeGreaterThan(0.99);
    const cold = appended(AUTO, 34579, 5, 0.10992);
    expect(cold?.exact).toBe(false);
  });

  it("refuses a model it never measured instead of guessing its cap", () => {
    expect(
      deriveKiroCacheFromCredits({
        ...HAIKU,
        model: "gpt-5-6-terra",
        promptTokens: 20000,
        outputTokens: 1,
        credits: 0.03,
      }),
    ).toBeUndefined();
    expect(
      deriveKiroCacheFromCredits({
        ...HAIKU,
        model: "deepseek-3-2",
        promptTokens: 20000,
        outputTokens: 1,
        credits: 0.03,
      }),
    ).toBeUndefined();
  });

  it("refuses when the answer is mostly output and the estimate would decide the result", () => {
    expect(appended(SONNET, 3000, 4000, 0.4)).toBeUndefined();
  });

  it("refuses a bill far outside the model: well under the cached rate, or well over the cap", () => {
    expect(appended({ ...HAIKU, rateMultiplier: 1 }, 20000, 1, 0.001)).toBeUndefined();
    expect(appended(HAIKU, 20000, 1, 0.2)).toBeUndefined();
  });
});

// Real OMP turns from the usage ledger, 2026-10-21..24: [prompt, output, credits].
const LUNA = { model: "gpt-5-6-luna", rateMultiplier: 0.6, creditUnit: unit };

describe("deriveKiroCacheFromCredits — gpt-5-6-luna (no cold cap, long-context tier)", () => {
  it("reads a cold first turn as uncached instead of capping it", () => {
    for (const [prompt, output, credits] of [
      [61150, 20, 0.6127957382089552],
      [63593, 17, 0.6360337737313432],
    ] as const) {
      const out = appended(LUNA, prompt, output, credits);
      expect(out?.exact, `${prompt}`).toBe(true);
      if (out?.exact) expect(out.cacheRead / prompt).toBeLessThan(0.01);
    }
  });

  it("reads a warm turn under the long-context boundary as almost fully cached", () => {
    const out = appended(LUNA, 203137, 42, 0.2102973573134329);
    expect(out?.exact).toBe(true);
    if (out?.exact) expect(out.cacheRead / 203137).toBeGreaterThan(0.99);
  });

  it("doubles every rate past the boundary, so a doubled floor is still a cache hit and a doubled fresh bill is not", () => {
    const warm = appended(LUNA, 301140, 63, 0.613076810348259);
    expect(warm?.exact).toBe(true);
    if (warm?.exact) expect(warm.cacheRead / 301140).toBeGreaterThan(0.98);
    const cold = appended(LUNA, 285095, 70, 5.679954871442786);
    expect(cold?.exact).toBe(true);
    if (cold?.exact) expect(cold.cacheRead / 285095).toBeLessThan(0.01);
  });

  it("refuses the band where the two tiers mix", () => {
    expect(appended(LUNA, 270506, 183, 0.3384181169154229)).toBeUndefined();
    expect(appended(LUNA, 274999, 20, 0.28)).toBeUndefined();
  });
});

describe("applyCreditDerivedCache", () => {
  const sonnet = { id: "claude-sonnet-5-5", rateMultiplier: 1.3 };
  type TurnUsage = {
    input: number;
    output: number;
    credits?: number;
    creditUnit?: string;
    cacheRead?: number;
    cacheEstimated?: boolean;
    cacheDerived?: "credits";
  };
  const fullyCached = (): TurnUsage => ({ input: 32794, output: 1, credits: 0.07183, creditUnit: unit });

  it("moves the derived share from input to cacheRead and labels it, leaving the total alone", () => {
    const usage = fullyCached();
    const moved = applyCreditDerivedCache(usage, sonnet);
    expect(moved).toBeGreaterThan(32794 * 0.99);
    expect(usage.cacheRead).toBe(moved);
    expect(usage.input + (usage.cacheRead ?? 0)).toBe(32794);
    expect(usage.cacheDerived).toBe("credits");
  });

  it("never touches counters the wire sent", () => {
    const usage = { ...fullyCached(), input: 794, cacheRead: 32000 };
    expect(applyCreditDerivedCache(usage, sonnet)).toBe(0);
    expect(usage).toMatchObject({ input: 794, cacheRead: 32000 });
    expect(usage).not.toHaveProperty("cacheDerived");
  });

  it("replaces the repeated-prefix guess with what the bill says", () => {
    const usage: TurnUsage = {
      ...fullyCached(),
      input: 2794,
      cacheRead: 30000,
      cacheEstimated: true,
    };
    applyCreditDerivedCache(usage, sonnet);
    expect(usage.cacheEstimated).toBeUndefined();
    expect(usage.cacheDerived).toBe("credits");
    expect(usage.input + (usage.cacheRead ?? 0)).toBe(32794);
    expect(usage.cacheRead).toBeGreaterThan(32794 * 0.99);
  });

  it("reports nothing for a capped bill, an unmeasured model, or a missing multiplier", () => {
    const capped: TurnUsage = { input: 34341, output: 1, credits: 0.04345, creditUnit: unit };
    expect(applyCreditDerivedCache(capped, { id: "claude-haiku-4-5", rateMultiplier: 0.4 })).toBe(0);
    expect(capped).not.toHaveProperty("cacheRead");
    const unknown = fullyCached();
    expect(applyCreditDerivedCache(unknown, { id: "gpt-5-6-terra", rateMultiplier: 1 })).toBe(0);
    expect(applyCreditDerivedCache(fullyCached(), { id: "claude-sonnet-5-5" })).toBe(0);
  });
});
