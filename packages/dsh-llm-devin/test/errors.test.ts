// ABOUTME: Tests the Devin → Harness LlmError routing codes.

import { DevinApiError, DevinStreamError } from "ns-devin-core";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

const apiError = (status: number) => new DevinApiError(`Devin API error ${status}`, "API", status);

describe("toLlmError", () => {
  it("maps HTTP statuses to routing codes", () => {
    expect(toLlmError(apiError(401)).code).toBe("AUTH");
    expect(toLlmError(apiError(429)).code).toBe("RATE_LIMIT");
    expect(toLlmError(apiError(503)).code).toBe("OVERLOADED");
    expect(toLlmError(apiError(500)).code).toBe("PROVIDER_ERROR");
  });

  it("maps trailer-coded failures", () => {
    expect(toLlmError(new DevinStreamError("x", "unauthenticated")).code).toBe("AUTH");
    expect(toLlmError(new DevinStreamError("x", "resource_exhausted")).code).toBe("RATE_LIMIT");
    expect(toLlmError(new DevinStreamError("x", "invalid_argument", true)).code).toBe("CONTEXT_OVERFLOW");
  });

  it("marks aborts and missing sessions", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toLlmError(abort).code).toBe("ABORTED");
    expect(toLlmError(new Error("No Devin session found")).code).toBe("AUTH");
  });

  it("reports how long a rate limit says to wait, so the Harness does not retry inside it", () => {
    const limited = new DevinStreamError(
      "Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 33 minutes (at 15:41 UTC).",
      "resource_exhausted",
    );
    const error = toLlmError(limited);
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.failure.providerRetryAfterMs).toBe(33 * 60_000);
    expect(
      toLlmError(new DevinStreamError("x: limit will reset in 5 seconds", "resource_exhausted")).failure
        .providerRetryAfterMs,
    ).toBe(5_000);
    expect(toLlmError(new DevinStreamError("x", "resource_exhausted")).failure.providerRetryAfterMs).toBeUndefined();
  });
});
