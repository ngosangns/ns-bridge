// ABOUTME: Maps an Arnict chat-completions failure onto the Harness LlmError taxonomy.

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmError } from "@deepseek-ai/dsh-llm";
import { ArnictApiError, ArnictAuthError } from "ns-arnict-core";

function statusOf(error: unknown): number | undefined {
  return error instanceof ArnictApiError ? error.status : undefined;
}

/** Classify a core failure so the harness loop can branch on `code`. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);
  if (cause?.name === "AbortError") return new LlmError(message, "ABORTED", { cause });

  const status = statusOf(error);
  const options = { cause, ...(status !== undefined ? { status } : {}) };
  if (error instanceof ArnictAuthError) return new LlmError(message, "AUTH", options);
  if (status === 401 || status === 403) return new LlmError(message, "AUTH", options);
  if (status === 429) return new LlmError(message, "RATE_LIMIT", options);
  // The Harness compacts and retries only on this code. Arnict's proxy refuses
  // an oversized prompt with 413, and the shared classifier recognizes the same
  // refusal reworded in the body of another status; leaving either as
  // PROVIDER_ERROR is what makes an oversized turn fail instead of compacting.
  if (status === 413 || isContextWindowExceededError(message))
    return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, options);
  return new LlmError(message, "PROVIDER_ERROR", options);
}
