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

export function toQoderUsage(wire: QoderWireUsage): QoderUsage {
  const input = nonNegative(wire.prompt_tokens);
  const output = nonNegative(wire.completion_tokens);
  const hit = nonNegative(wire.prompt_cache_hit_tokens);
  const cached = nonNegative(wire.prompt_tokens_details?.cached_tokens);
  const cacheRead = hit > 0 ? hit : cached;
  return {
    input,
    output,
    totalTokens: input + output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
