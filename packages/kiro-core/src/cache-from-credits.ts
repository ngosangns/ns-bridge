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
    "claude-haiku-4-5": 0.003165,
    "claude-opus-5": 0.003165,
    "claude-sonnet-5-5": 0.00614,
  } as Readonly<Record<string, number>>,
  /** Credits per output token, per multiplier unit. Output counts are tiktoken estimates, not Kiro's. */
  perOutputToken: 0.00011,
} as const;

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
  if (capPer1k === undefined) return undefined;

  const output = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);
  const outputCredits = output * KIRO_CREDIT_RATES.perOutputToken * rateMultiplier;
  if (outputCredits > credits * KIRO_MAX_OUTPUT_SHARE) return undefined;

  const { cachedPer1k: cached, freshPer1k: fresh } = KIRO_CREDIT_RATES;
  const prompt = promptTokens / 1000;
  const bill = (credits - outputCredits) / rateMultiplier;
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
