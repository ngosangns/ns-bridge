// ABOUTME: Tests the mapping from a Grok Responses failure onto Harness routing codes.

import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { GrokApiError, GrokAuthError } from "ns-grok-core";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

describe("toLlmError", () => {
  it("passes an LlmError through untouched", () => {
    const original = new LlmError("already classified", "AUTH");
    expect(toLlmError(original)).toBe(original);
  });

  it("classifies the proxy's oversized-prompt refusal as a context overflow", () => {
    const error = new GrokApiError(
      "Grok responses error (400): Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (687347 tokens > 500000 tokens)",
      400,
    );
    const mapped = toLlmError(error);
    // The Harness compacts and retries only on this code, so a mislabel here
    // is the turn failing instead of being shortened.
    expect(mapped.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE);
    expect(mapped.failure.status).toBe(400);
  });

  it.each([
    [new GrokAuthError(), "AUTH"],
    [new GrokApiError("Grok responses error (401): unauthorized", 401), "AUTH"],
    [new GrokApiError("Grok responses error (403): forbidden", 403), "AUTH"],
    [new GrokApiError("Grok responses error (429): slow down", 429), "RATE_LIMIT"],
    [new GrokApiError("Grok responses error (500): boom", 500), "PROVIDER_ERROR"],
  ])("classifies a typed core failure (%#)", (error, code) => {
    expect(toLlmError(error).code).toBe(code);
  });

  it("classifies an abort as ABORTED rather than a provider fault", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(toLlmError(aborted).code).toBe("ABORTED");
  });

  it("accepts a non-Error throw", () => {
    expect(toLlmError("plain string").code).toBe("PROVIDER_ERROR");
  });
});
