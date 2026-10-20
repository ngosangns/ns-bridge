// ABOUTME: Maps Kiro's failure vocabulary onto the Harness LlmError taxonomy.

import { LlmError } from "@deepseek-ai/dsh-llm";
import { isCapacityError, isNonRetryableBodyError, KIRO_REASON_CODES, KiroApiError } from "ns-kiro-core";

/**
 * Classify a core failure for the Harness.
 *
 * The core throws `KiroApiError` with its classification already computed, so
 * the routing decisions below read `status` and `reasonCode` rather than
 * re-parsing the message. The message text is host-facing wording, not a
 * contract: matching on it meant a reworded core silently misrouted every
 * failure to PROVIDER_ERROR, and the loop branches on `code` — a mislabelled
 * failure either retries forever or gives up on something transient.
 *
 * A few paths still throw a plain `Error` (a missing response body, an absent
 * credential store), so the string checks stay as a fallback for exactly those.
 */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);

  if (cause?.name === "AbortError") return new LlmError(message, "ABORTED", { cause });

  const status = error instanceof KiroApiError ? error.status : undefined;
  const reasonCode = error instanceof KiroApiError ? error.reasonCode : undefined;
  const options = { cause, ...(status !== undefined ? { status } : {}) };

  if (reasonCode === "MODEL_CONTEXT_WINDOW_EXCEEDED" || message.includes("context_length_exceeded")) {
    return new LlmError(message, "CONTEXT_OVERFLOW", options);
  }
  if (reasonCode === KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT || isNonRetryableBodyError(message)) {
    return new LlmError(message, "QUOTA_EXCEEDED", options);
  }
  if (reasonCode === KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY || isCapacityError(message)) {
    return new LlmError(message, "OVERLOADED", options);
  }
  if (
    reasonCode === KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED ||
    message.includes(KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED) ||
    status === 429
  ) {
    return new LlmError(message, "RATE_LIMIT", options);
  }
  if (message.includes("credentials not set") || status === 401 || status === 403) {
    return new LlmError(message, "AUTH", options);
  }
  if (status === 504 || message.includes("timeout")) return new LlmError(message, "TIMEOUT", options);
  return new LlmError(message, "PROVIDER_ERROR", options);
}
