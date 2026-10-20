// ABOUTME: Maps a Grok Responses failure onto the Harness LlmError taxonomy.

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmError } from "@deepseek-ai/dsh-llm";
import { GrokApiError, GrokAuthError } from "ns-grok-core";

function statusOf(error: unknown): number | undefined {
  return error instanceof GrokApiError ? error.status : undefined;
}

/** Classify a core failure so the harness loop can branch on `code`. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);
  if (cause?.name === "AbortError") return new LlmError(message, "ABORTED", { cause });

  const status = statusOf(error);
  const options = { cause, ...(status !== undefined ? { status } : {}) };
  if (error instanceof GrokAuthError || message.includes("grok login")) return new LlmError(message, "AUTH", options);
  if (status === 401 || status === 403) return new LlmError(message, "AUTH", options);
  if (status === 429) return new LlmError(message, "RATE_LIMIT", options);
  // The Harness compacts and retries only on this code. Grok's proxy says
  // `[input_too_large] The prompt is too long for this model's context window`,
  // which the shared classifier already recognizes; leaving it as
  // PROVIDER_ERROR is what made an oversized turn fail instead of compacting.
  if (isContextWindowExceededError(message)) return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, options);
  return new LlmError(message, "PROVIDER_ERROR", options);
}
