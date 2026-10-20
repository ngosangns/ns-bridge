// ABOUTME: Tests the mapping from Kiro's failure vocabulary onto Harness routing codes.

import { LlmError } from "@deepseek-ai/dsh-llm";
import { KiroApiError } from "ns-kiro-core";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

describe("toLlmError", () => {
  it("passes an LlmError through untouched", () => {
    const original = new LlmError("already classified", "AUTH");
    expect(toLlmError(original)).toBe(original);
  });

  // The core classifies before it throws, so routing reads the typed fields.
  it.each([
    [
      new KiroApiError("Kiro API error: context_length_exceeded", 400, "MODEL_CONTEXT_WINDOW_EXCEEDED"),
      "CONTEXT_OVERFLOW",
    ],
    [new KiroApiError("Kiro API error: quota", 429, "MONTHLY_REQUEST_COUNT"), "QUOTA_EXCEEDED"],
    [new KiroApiError("Kiro API error: capacity", 429, "INSUFFICIENT_MODEL_CAPACITY"), "OVERLOADED"],
    [new KiroApiError("Kiro API error: slow down", 429, "USER_REQUEST_RATE_EXCEEDED"), "RATE_LIMIT"],
    [new KiroApiError("Kiro credentials not set.", 401), "AUTH"],
    [new KiroApiError("Kiro API error: first token timeout after max retries", 504), "TIMEOUT"],
    [new KiroApiError("Kiro API error: 500 Internal Server Error", 500), "PROVIDER_ERROR"],
  ])("classifies a typed core failure (%#)", (error, code) => {
    expect(toLlmError(error).code).toBe(code);
  });

  it("carries the core's status onto the Harness failure", () => {
    expect(toLlmError(new KiroApiError("Kiro API error: 503 Service Unavailable", 503)).failure.status).toBe(503);
  });

  it("classifies a 403 as an auth failure", () => {
    expect(toLlmError(new KiroApiError("Kiro API error: 403 Forbidden", 403)).code).toBe("AUTH");
  });

  // A few core paths still throw a plain Error, so the wording fallback stays.
  it.each([
    ["Kiro API error: context_length_exceeded (400 too long)", "CONTEXT_OVERFLOW"],
    ["Kiro API error: MONTHLY_REQUEST_COUNT exhausted", "QUOTA_EXCEEDED"],
    ["Kiro API error: INSUFFICIENT_MODEL_CAPACITY", "OVERLOADED"],
    ["Kiro API error: request window retry budget exhausted (USER_REQUEST_RATE_EXCEEDED)", "RATE_LIMIT"],
    ["Kiro credentials not set. Run `kiro-cli login`.", "AUTH"],
    ["Kiro API error: first token timeout after max retries", "TIMEOUT"],
    ["Kiro API error: 500 Internal Server Error", "PROVIDER_ERROR"],
  ])("falls back to the wording for an untyped %s", (message, code) => {
    expect(toLlmError(new Error(message)).code).toBe(code);
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
