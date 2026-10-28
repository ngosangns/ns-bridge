// ABOUTME: Derives how much of a Kiro prompt was billed at the cached rate, from the credits Kiro reports.
// ABOUTME: Kiro sends no cache counters, so this is the only provider-side signal. It is derived, never a wire number.

/**
 * How Kiro prices a prompt, per 1,000 tokens, per unit of the model's `rateMultiplier`.
 *
 * Measured 2026-10-21 against live Kiro (haiku-4.5, sonnet-5.5, opus-5) by holding a
 * prefix constant and changing one thing at a time. A request bills as
 *
 *     min( cold * P ,  cached * (P - n) + fresh * n )
 *
 * where P is the prompt and n is the part of it that was not in Kiro's cache:
 *
 * - `cached`: the part of the prompt Kiro had cached. Same for all three models.
 * - `fresh`: new tokens appended after a cached prefix. About ten times `cached`,
 *   and dearer than `cold`, so appending 10% of the prompt already costs as much as
 *   sending the whole prompt cold. Seven points, all within 0.6% of each other.
 * - `cold`: a prompt with nothing cached. Opus-5 and haiku-4-5 agree. Sonnet-5-5 bills
 *   about twice that, so the cap is per model id (see `coldPer1k`).
 *
 * Consequences the code relies on, all measured:
 *
 * - Once n reaches about 10% of P (30% for sonnet) the bill sits exactly on the cold
 *   cap, whatever n is, and a cached 30k-token prefix is billed as if it were not.
 *   The bill then says only "at most 90% (70%) was cached", never a figure.
 * - The cache is keyed by prompt content, not by conversation id, and a prefix
 *   expired somewhere between 245 and 404 seconds of idle time.
 *
 * gpt-5-6-luna follows a different shape, fitted 2026-10-24 from 2,491 OMP turns in the
 * usage ledger (`~/.ns-bridge/usage`, 2026-10-21..24). There is no cold cap: a first turn
 * of 61k-145k tokens bills 0.01657-0.01667 per 1k per multiplier unit, which is `fresh`,
 * and warm turns floor at 0.00162-0.00167, which is `cached`. Past a long-context
 * boundary every rate doubles: prompts of 250k-270k tokens floor at 0.00167, prompts from
 * 275k up floor at 0.00334 and top out at 0.03325. Between 270k and 275k the two tiers mix
 * (token counts here are tiktoken estimates, not Kiro's), so that band is refused.
 *
 * auto (rateMultiplier 1) was fitted 2026-10-28 from 1,381 OMP turns of 20k+ prompt tokens in the
 * usage ledger (2026-10-27..28). Warm turns floor at 0.001679 per 1k, which is `cached`, from 20k
 * to 565k prompt tokens with no step at any size, so it has no long-context tier. Cold turns sit on
 * 0.00316, the haiku/opus cap. Checked the other way: for 957 consecutive turns under the cap, the
 * cached share the bill implies lands within 2% of the previous prompt's size (median -0.5%), which
 * is what a cached prefix must be. "auto" routes to whichever model Kiro picks, so the cap is the
 * one the traffic showed, not a vendor price.
 * See {@link KIRO_UNCAPPED_MODELS}.
 *
 * A model in neither table is refused, and the ledger records `cacheSource: "none"` for
 * it. To add one, read its turns from the ledger and normalise each bill as
 * `(credits - output * perOutputToken * rateMultiplier) / rateMultiplier / (promptTokens / 1000)`.
 * Warm turns should floor on `cached`. Large cold first turns (`step: 1`) sit either on a
 * cap (enter it in `coldPer1k`) or on `fresh` (enter it in `KIRO_UNCAPPED_MODELS`). Bucket
 * by prompt size to find a long-context tier. Never enter a number nobody measured.
 *
 * Kiro publishes no price list, so these are fitted constants. If Kiro reprices the
 * ledger keeps reporting from stale numbers: re-measure (one fixed prefix, three
 * identical turns, then append known token counts), then edit this block and the
 * fixtures in the test.
 */
export const KIRO_CREDIT_RATES = {
  cachedPer1k: 0.001675,
  freshPer1k: 0.0165,
  /**
   * Cold cap by exact model id. A model not listed was not measured and is refused: the
   * cap is a property of the model, not the family. sonnet-5-5 bills double what haiku-4-5
   * and opus-5 do, while sonnet-4-6 (checked in a later batch) saturates at the standard
   * cap, so matching on "sonnet" was wrong.
   */
  coldPer1k: {
    auto: 0.003165,
    "claude-haiku-4-5": 0.003165,
    "claude-opus-5": 0.003165,
    "claude-sonnet-5-5": 0.00614,
  } as Readonly<Record<string, number>>,
  /** Credits per output token, per multiplier unit. Output counts are tiktoken estimates, not Kiro's. */
  perOutputToken: 0.00011,
} as const;

/**
 * Models that bill an uncached prompt at `fresh` with no cold cap, by exact model id.
 * From `longContextFrom` tokens every rate is multiplied by `longContextFactor`. Prompts
 * in `[ambiguousFrom, longContextFrom)` could be billed in either tier and are refused.
 */
export const KIRO_UNCAPPED_MODELS: Readonly<
  Record<string, { ambiguousFrom: number; longContextFrom: number; longContextFactor: number }>
> = {
  "gpt-5-6-luna": { ambiguousFrom: 270_000, longContextFrom: 275_000, longContextFactor: 2 },
};

/** Below this the fixed per-request cost swamps the prompt term and the split is noise. */
export const KIRO_MIN_PROMPT_TOKENS = 2000;

/**
 * Past this share of the bill the output estimate decides the answer, and an
 * error of 20% in the token count moves the result by more than the gap between a
 * cached prompt and a cold one.
 */
export const KIRO_MAX_OUTPUT_SHARE = 0.5;

/** A bill this far under the cached rate means the constants do not fit this model. */
const UNDER_CACHED_TOLERANCE = 0.1;
/** A bill within this of the cap counts as on the cap. */
const CAP_TOLERANCE = 0.02;
/** A bill this far over the cap is a price this model does not follow. */
const OVER_CAP_TOLERANCE = 0.15;

export interface KiroCreditInput {
  /** Wire model id, e.g. `claude-sonnet-5-5`. Selects the cold cap. */
  model: string;
  promptTokens: number;
  outputTokens: number;
  credits?: number;
  creditUnit?: string;
  rateMultiplier?: number;
}

export type KiroDerivedCache =
  /** The bill is under the cap, so it fixes how many prompt tokens were cached. */
  | { exact: true; cacheRead: number }
  /** The bill is on the cap. The cached share is anywhere from none up to `maxRatio`. */
  | { exact: false; maxRatio: number };

function coldCap(model: string): number | undefined {
  return Object.hasOwn(KIRO_CREDIT_RATES.coldPer1k, model) ? KIRO_CREDIT_RATES.coldPer1k[model] : undefined;
}

/**
 * What the credits Kiro billed say about the cache, or `undefined` when they say
 * nothing trustworthy (unmeasured model, tiny prompt, long answer, odd price).
 */
export function deriveKiroCacheFromCredits(input: KiroCreditInput): KiroDerivedCache | undefined {
  const { promptTokens, outputTokens, credits, rateMultiplier } = input;
  if (!Number.isFinite(promptTokens) || promptTokens < KIRO_MIN_PROMPT_TOKENS) return undefined;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits <= 0) return undefined;
  if (typeof rateMultiplier !== "number" || !Number.isFinite(rateMultiplier) || rateMultiplier <= 0) return undefined;
  if (input.creditUnit !== undefined && !/^credits?$/i.test(input.creditUnit)) return undefined;
  const capPer1k = coldCap(input.model);
  const uncapped = Object.hasOwn(KIRO_UNCAPPED_MODELS, input.model) ? KIRO_UNCAPPED_MODELS[input.model] : undefined;
  if (capPer1k === undefined && uncapped === undefined) return undefined;

  const output = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);
  const outputCredits = output * KIRO_CREDIT_RATES.perOutputToken * rateMultiplier;
  if (outputCredits > credits * KIRO_MAX_OUTPUT_SHARE) return undefined;

  const prompt = promptTokens / 1000;
  const bill = (credits - outputCredits) / rateMultiplier;

  if (uncapped) {
    if (promptTokens >= uncapped.ambiguousFrom && promptTokens < uncapped.longContextFrom) return undefined;
    const factor = promptTokens >= uncapped.longContextFrom ? uncapped.longContextFactor : 1;
    const cachedRate = KIRO_CREDIT_RATES.cachedPer1k * factor;
    const freshRate = KIRO_CREDIT_RATES.freshPer1k * factor;
    if (bill > freshRate * prompt * (1 + OVER_CAP_TOLERANCE)) return undefined;
    if (bill < cachedRate * prompt * (1 - UNDER_CACHED_TOLERANCE)) return undefined;
    const uncachedShare = Math.min(prompt, Math.max(0, (bill - cachedRate * prompt) / (freshRate - cachedRate)));
    return { exact: true, cacheRead: Math.round((1 - uncachedShare / prompt) * promptTokens) };
  }
  if (capPer1k === undefined) return undefined;

  const { cachedPer1k: cached, freshPer1k: fresh } = KIRO_CREDIT_RATES;
  const cap = capPer1k * prompt;

  if (bill > cap * (1 + OVER_CAP_TOLERANCE)) return undefined;
  if (bill >= cap * (1 - CAP_TOLERANCE)) {
    // Largest cached share that still bills exactly the cap: cached*(P-n) + fresh*n = cap.
    const smallestUncached = (capPer1k - cached) / (fresh - cached);
    return { exact: false, maxRatio: Math.min(1, Math.max(0, 1 - smallestUncached)) };
  }
  if (bill < cached * prompt * (1 - UNDER_CACHED_TOLERANCE)) return undefined;

  const uncached = Math.min(prompt, Math.max(0, (bill - cached * prompt) / (fresh - cached)));
  const ratio = 1 - uncached / prompt;
  return { exact: true, cacheRead: Math.round(ratio * promptTokens) };
}

/** What a turn's usage needs for {@link applyCreditDerivedCache}. */
interface CreditDerivableUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheEstimated?: boolean;
  cacheDerived?: "credits";
  credits?: number;
  creditUnit?: string;
}

/**
 * Put the credits-derived cached share of a turn on the usage event the host sees.
 *
 * Kiro sends no cache counters, so without this every host shows `cacheRead: 0`.
 * Real wire counters always win and are left alone. A repeated-prefix guess from the
 * opt-in estimator is replaced, because the bill is evidence and the guess is not. Only
 * an exact derivation is applied: a bill on the cold cap says only "at most", and that
 * stays unreported. Total tokens do not change. Returns the tokens moved to `cacheRead`.
 */
export function applyCreditDerivedCache(
  usage: CreditDerivableUsage,
  model: { id: string; rateMultiplier?: number },
): number {
  if (usage.cacheWrite !== undefined) return 0;
  if (usage.cacheRead !== undefined && !usage.cacheEstimated) return 0;
  const guessed = usage.cacheEstimated ? (usage.cacheRead ?? 0) : 0;
  const promptTokens = usage.input + guessed;
  const derived = deriveKiroCacheFromCredits({
    model: model.id,
    promptTokens,
    outputTokens: usage.output,
    credits: usage.credits,
    creditUnit: usage.creditUnit,
    rateMultiplier: model.rateMultiplier,
  });
  if (!derived?.exact) return 0;
  usage.input = promptTokens - derived.cacheRead;
  usage.cacheRead = derived.cacheRead;
  delete usage.cacheEstimated;
  usage.cacheDerived = "credits";
  return derived.cacheRead;
}
