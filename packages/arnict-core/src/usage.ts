// ABOUTME: Maps OpenAI chat usage onto the neutral counters and Arnict's published rates.
// ABOUTME: A model without published rates costs 0 rather than a guessed price.

import type { ArnictRates } from "./catalog.js";
import type { ArnictUsage } from "./types.js";

/** The usage block an OpenAI-compatible chat-completions response reports. */
export interface ArnictWireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Where OpenAI reports cache hits. */
  prompt_tokens_details?: { cached_tokens?: number };
  /** Fallbacks other OpenAI-compatible servers use for the same number. */
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Split `prompt_tokens` into fresh and cached so a host that checks
 * `input + cacheRead + output === total` can keep the cache sample, then price
 * the three slices against arnict.com/docs/pricing (USD per 1M tokens).
 */
export function toArnictUsage(usage: ArnictWireUsage, rates?: ArnictRates): ArnictUsage {
  const prompt = nonNegative(usage.prompt_tokens);
  const cached = nonNegative(
    usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.prompt_cache_hit_tokens,
  );
  const cacheRead = Math.min(cached, prompt);
  const input = prompt - cacheRead;
  const output = nonNegative(usage.completion_tokens);
  const totalTokens = usage.total_tokens === undefined ? input + cacheRead + output : nonNegative(usage.total_tokens);
  if (!rates) {
    return {
      input,
      output,
      totalTokens,
      cacheRead,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  const costInput = (input * rates.input) / 1_000_000;
  const costCacheRead = (cacheRead * rates.cachedInput) / 1_000_000;
  const costOutput = (output * rates.output) / 1_000_000;
  const total = costInput + costCacheRead + costOutput;
  return {
    input,
    output,
    totalTokens,
    cacheRead,
    credits: total,
    creditUnit: "USD",
    cost: { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: 0, total },
  };
}
