// ABOUTME: Tests for deriving a Kiro cache-hit ratio from the credits Kiro bills.
// ABOUTME: Fixtures are real turns measured against live Kiro on 2026-10-21; each states the truth the experiment fixed.

import { describe, expect, it } from "vitest";
import { deriveKiroCacheFromCredits, KIRO_MIN_PROMPT_TOKENS } from "../src/cache-from-credits.js";

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
