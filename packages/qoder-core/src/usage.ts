// ABOUTME: Maps Qoder model-server usage onto neutral counters.

import type { QoderUsage } from "./types.js";

/** `usage` / `raw_usage.data` fields on the model-server wire (DeepSeek naming). */
export interface QoderWireUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}

function nonNegative(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * `prompt_tokens` includes cached tokens. The bridge wants them split so a host
 * that checks `input + cacheRead + cacheWrite + output === totalTokens` keeps
 * the cache sample. Without the split the sum check fails and every host reads
 * the turn as a cold prefix.
 */
export function toQoderUsage(wire: QoderWireUsage): QoderUsage {
  const prompt = nonNegative(wire.prompt_tokens);
  const output = nonNegative(wire.completion_tokens);
  const hit = nonNegative(wire.prompt_cache_hit_tokens);
  const cached = nonNegative(wire.prompt_tokens_details?.cached_tokens);
  const cacheRead = Math.min(hit > 0 ? hit : cached, prompt);
  const input = prompt - cacheRead;
  return {
    input,
    output,
    totalTokens: input + cacheRead + output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
