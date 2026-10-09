import { describe, expect, it } from "vitest";
import {
  DevinApiError,
  DevinStreamError,
  isDevinAuthError,
  isDevinCapacityError,
  isDevinContextOverflowError,
  isDevinRateLimitError,
  parseRetryAfterMs,
} from "../src/errors.js";

describe("error classification", () => {
  const httpError = (status: number) => new DevinApiError(`Devin API error ${status}`, "API", status);

  it("routes auth, rate limit, capacity, and overflow", () => {
    expect(isDevinAuthError(httpError(401))).toBe(true);
    expect(isDevinAuthError(httpError(403))).toBe(true);
    expect(isDevinAuthError(httpError(429))).toBe(false);
    expect(isDevinRateLimitError(httpError(429))).toBe(true);
    expect(isDevinCapacityError(httpError(503))).toBe(true);
    expect(isDevinCapacityError(httpError(529))).toBe(true);
    expect(isDevinAuthError(new DevinStreamError("x", "unauthenticated"))).toBe(true);
    expect(isDevinRateLimitError(new DevinStreamError("x", "resource_exhausted"))).toBe(true);
    expect(isDevinCapacityError(new DevinStreamError("x", "unavailable"))).toBe(true);
    expect(isDevinContextOverflowError(new DevinStreamError("x", "invalid_argument", true))).toBe(true);
    expect(isDevinContextOverflowError(new DevinStreamError("x", "invalid_argument", false))).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfterMs({ "retry-after": "5" })).toBe(5000);
    expect(parseRetryAfterMs({ "retry-after": "0" })).toBe(0);
    expect(parseRetryAfterMs({ "retry-after": "not-a-number" })).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
  });
});
