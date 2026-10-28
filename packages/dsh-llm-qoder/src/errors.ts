// ABOUTME: Maps a Qoder SDK failure onto the Harness LlmError taxonomy.

import { LlmError } from "@deepseek-ai/dsh-llm";
import { QODER_LOGIN_MESSAGE, QoderApiError, QoderAuthError } from "ns-qoder-core";

/** Classify a core failure so the harness loop can branch on `code`. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);
  if (cause?.name === "AbortError") return new LlmError(message, "ABORTED", { cause });

  const options = { cause };
  if (error instanceof QoderAuthError) return new LlmError(message, "AUTH", options);
  if (error instanceof QoderApiError) return new LlmError(message, "PROVIDER_ERROR", options);
  return new LlmError(message || QODER_LOGIN_MESSAGE, "PROVIDER_ERROR", options);
}
