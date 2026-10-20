// ABOUTME: Maps Responses usage onto the neutral counters the host bridges already understand.
// ABOUTME: Dollar ticks from the proxy are not a credit unit this bridge knows, so cost stays zero.

import type { GrokUsage } from "./types.js";

export interface GrokWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * `input_tokens` includes cached tokens. The bridge wants them split so a host
 * that checks `input + cacheRead + output === total` can keep the cache sample.
 */
export function toGrokUsage(usage: GrokWireUsage): GrokUsage {
  const inputTokens = nonNegative(usage.input_tokens);
  const cached = nonNegative(usage.input_tokens_details?.cached_tokens);
  const cacheRead = Math.min(cached, inputTokens);
  const input = inputTokens - cacheRead;
  const output = nonNegative(usage.output_tokens);
  const totalTokens = usage.total_tokens === undefined ? input + cacheRead + output : nonNegative(usage.total_tokens);
  return {
    input,
    output,
    cacheRead,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
