// ABOUTME: Retry-header parsing and backoff arithmetic shared by every vendor core.
// ABOUTME: One parser, so a vendor cannot silently miss a header another vendor honors.

/**
 * The subset of `Headers` this module reads.
 *
 * Structural on purpose: `fetch` hands us a real `Headers`, while a Connect
 * trailer arrives as a plain record. Both satisfy this shape, so one parser
 * serves both call sites instead of one per vendor.
 */
export interface RetryHeaderSource {
  get(name: string): string | null;
}

/** A plain header record, adapted to {@link RetryHeaderSource}. */
export function headerRecordSource(headers: Record<string, string | undefined>): RetryHeaderSource {
  return {
    get(name: string): string | null {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return value === undefined ? null : value;
    },
  };
}

/**
 * Read a server-advertised wait in milliseconds.
 *
 * `retry-after-ms` is milliseconds, numeric `retry-after` and
 * `x-ratelimit-reset-after` are seconds, and an HTTP-date `retry-after` is
 * relative to `nowMs`. Each header is an independent candidate, so an invalid
 * earlier value does not hide a valid later one. A past HTTP date means retry
 * now.
 */
export function parseRetryAfterMs(
  headers: RetryHeaderSource | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const get = headers?.get?.bind(headers);
  if (!get) return undefined;

  const milliseconds = nonNegativeNumber(get("retry-after-ms"));
  if (milliseconds !== undefined) return Math.round(milliseconds);

  const retryAfter = get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      // Numeric Retry-After is delay-seconds, never a date. In particular,
      // do not let Date.parse reinterpret a negative delay as a year.
      if (seconds >= 0) {
        const delayMs = seconds * 1000;
        if (Number.isFinite(delayMs)) return Math.round(delayMs);
      }
    } else {
      const dateMs = Date.parse(retryAfter);
      if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
    }
  }

  const resetAfterSeconds = nonNegativeNumber(get("x-ratelimit-reset-after"));
  if (resetAfterSeconds !== undefined) {
    const delayMs = resetAfterSeconds * 1000;
    if (Number.isFinite(delayMs)) return Math.round(delayMs);
  }

  return undefined;
}

/** Exponential backoff, clamped to `maxMs`. `attempt` is zero-based. */
export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function nonNegativeNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
