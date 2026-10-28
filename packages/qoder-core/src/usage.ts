// ABOUTME: Maps Qoder wire usage onto neutral counters and credits.

import type { QoderUsage } from "./types.js";

export interface QoderWireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  credits?: number | null;
}

function nonNegative(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function toQoderUsage(wire: QoderWireUsage, sessionCredits?: number): QoderUsage {
  const input = nonNegative(wire.input_tokens);
  const output = nonNegative(wire.output_tokens);
  const cacheRead = nonNegative(wire.cache_read_input_tokens);
  const cacheWrite = nonNegative(wire.cache_creation_input_tokens);
  const credits = nonNegative(wire.credits) || nonNegative(sessionCredits);
  return {
    input,
    output,
    totalTokens: input + output + cacheRead,
    cacheRead: cacheRead > 0 ? cacheRead : undefined,
    cacheWrite: cacheWrite > 0 ? cacheWrite : undefined,
    ...(credits > 0 ? { credits, creditUnit: "credits" } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
