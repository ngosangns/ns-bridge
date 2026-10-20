// ABOUTME: Tests for the shared retry-header parser and backoff arithmetic.
// ABOUTME: Ported from kiro-core so the one parser keeps its full header coverage.

import { describe, expect, it } from "vitest";
import { exponentialBackoff, headerRecordSource, parseRetryAfterMs } from "../src/retry.js";

describe("exponentialBackoff", () => {
  it("returns baseMs for attempt 0", () => {
    expect(exponentialBackoff(0, 1000, 30000)).toBe(1000);
  });

  it("doubles delay for each attempt", () => {
    expect(exponentialBackoff(1, 1000, 30000)).toBe(2000);
    expect(exponentialBackoff(2, 1000, 30000)).toBe(4000);
    expect(exponentialBackoff(3, 1000, 30000)).toBe(8000);
  });

  it("caps delay at maxMs", () => {
    expect(exponentialBackoff(10, 1000, 30000)).toBe(30000);
  });

  it("works with custom base", () => {
    expect(exponentialBackoff(0, 500, 10000)).toBe(500);
    expect(exponentialBackoff(1, 500, 10000)).toBe(1000);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses each supported header with explicit units", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    expect(parseRetryAfterMs(new Headers({ "x-ratelimit-reset-after": "1.5" }))).toBe(1500);

    const now = Date.parse("2026-08-29T00:00:00Z");
    expect(parseRetryAfterMs(new Headers({ "retry-after": "Sat, 29 Aug 2026 00:00:02 GMT" }), now)).toBe(2000);
  });

  it("lets a later valid header win after malformed or negative candidates", () => {
    expect(
      parseRetryAfterMs(
        new Headers({
          "retry-after-ms": "not-a-number",
          "retry-after": "-5",
          "x-ratelimit-reset-after": "2",
        }),
      ),
    ).toBe(2000);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "Infinity" }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "-1" }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1e308", "x-ratelimit-reset-after": "2" }))).toBe(2000);
    expect(parseRetryAfterMs(new Headers({ "x-ratelimit-reset-after": "1e308" }))).toBeUndefined();
  });

  it("treats an elapsed HTTP date as retry-now", () => {
    const now = Date.parse("2026-08-29T00:00:00Z");
    expect(parseRetryAfterMs(new Headers({ "retry-after": "Fri, 28 Aug 2026 23:59:59 GMT" }), now)).toBe(0);
  });

  it("returns undefined without a header source", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  // The Connect trailer path hands over a plain record, not a Headers instance.
  // One parser must serve both, or the record path silently loses headers.
  it("reads a plain header record through headerRecordSource", () => {
    expect(parseRetryAfterMs(headerRecordSource({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(parseRetryAfterMs(headerRecordSource({ "retry-after": "2" }))).toBe(2000);
    expect(parseRetryAfterMs(headerRecordSource({ "x-ratelimit-reset-after": "3" }))).toBe(3000);
    expect(parseRetryAfterMs(headerRecordSource({}))).toBeUndefined();
  });

  it("matches a Headers instance and a record for the same values", () => {
    const values = { "retry-after-ms": "2500", "retry-after": "9", "x-ratelimit-reset-after": "4" };
    expect(parseRetryAfterMs(headerRecordSource(values))).toBe(parseRetryAfterMs(new Headers(values)));
  });
});
