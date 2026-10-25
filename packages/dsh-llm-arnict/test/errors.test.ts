// ABOUTME: Tests the mapping from an Arnict chat-completions failure onto Harness routing codes.

import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { ArnictApiError, ArnictAuthError } from "ns-arnict-core";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

describe("toLlmError", () => {
  it("passes an LlmError through untouched", () => {
    const original = new LlmError("already classified", "AUTH");
    expect(toLlmError(original)).toBe(original);
  });

  it("classifies a 413 as a context overflow", () => {
    const error = new ArnictApiError(
      "Arnict error (413): Request too large: the prompt exceeds this model's context window",
      413,
    );
    const mapped = toLlmError(error);
    // The Harness compacts and retries only on this code, so a mislabel here
    // is the turn failing instead of being shortened.
    expect(mapped.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE);
    expect(mapped.failure.status).toBe(413);
  });

  it("classifies the proxy's oversized-prompt refusal as a context overflow", () => {
    const error = new ArnictApiError(
      "Arnict error (400): This model's maximum context length is 1048576 tokens. However, you requested 1100000 tokens",
      400,
    );
    expect(toLlmError(error).code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE);
  });

  it.each([
    [new ArnictAuthError(), "AUTH"],
    [new ArnictApiError("Arnict error (401): unauthorized", 401), "AUTH"],
    [new ArnictApiError("Arnict error (403): forbidden", 403), "AUTH"],
    [new ArnictApiError("Arnict error (429): slow down", 429), "RATE_LIMIT"],
    [new ArnictApiError("Arnict error (500): boom", 500), "PROVIDER_ERROR"],
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
