// ABOUTME: Devin's failure vocabulary — HTTP envelope errors, Connect trailer
// ABOUTME: rejections — plus the classification helpers adapters route on.
// ABOUTME: The classes are rebuilt from the sidecar's error fields by
// ABOUTME: devinErrorFromSidecar; the wire parsing that raised them lives in Go.

/** An HTTP-level rejection from a Cascade endpoint (`<status> <detail>`). */
export class DevinApiError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly headers: Record<string, string>;

  constructor(message: string, operation: string, status: number, headers?: Record<string, string>) {
    super(message);
    this.name = "DevinApiError";
    this.operation = operation;
    this.status = status;
    this.headers = headers ?? {};
  }
}

/** A wire-level failure: malformed frame, empty body, missing router fields. */
export class DevinProtocolError extends Error {
  readonly kind: "empty-body" | "envelope" | "runtime";
  constructor(message: string, kind: "empty-body" | "envelope" | "runtime" = "runtime") {
    super(message);
    this.name = "DevinProtocolError";
    this.kind = kind;
  }
}

/**
 * A rejection the Connect end-of-stream trailer carried. `contextOverflow`
 * marks the large-history `invalid_argument` recovery case — a host that can
 * compact history should retry with a shorter conversation rather than fail.
 */
export class DevinStreamError extends Error {
  readonly code: string;
  readonly contextOverflow: boolean;
  constructor(message: string, code = "", contextOverflow = false) {
    super(message);
    this.name = "DevinStreamError";
    this.code = code;
    this.contextOverflow = contextOverflow;
  }
}

/** Retry-After header (seconds or HTTP-date) → milliseconds, when parseable. */
export function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Statuses that mean the token is wrong, revoked, or missing — never retry. */
export function isDevinAuthError(error: unknown): boolean {
  if (error instanceof DevinApiError) return error.status === 401 || error.status === 403;
  if (error instanceof DevinStreamError) return error.code === "unauthenticated" || error.code === "permission_denied";
  return false;
}

/** 429 or Connect `resource_exhausted` / `quota` rejections. */
export function isDevinRateLimitError(error: unknown): boolean {
  if (error instanceof DevinApiError) return error.status === 429;
  if (error instanceof DevinStreamError) {
    return error.code === "resource_exhausted" || /rate.?limit|quota/i.test(error.message);
  }
  return false;
}

/** Connect codes that mark a transient overloaded backend worth retrying. */
export function isDevinCapacityError(error: unknown): boolean {
  if (error instanceof DevinApiError) return error.status === 502 || error.status === 503 || error.status === 529;
  if (error instanceof DevinStreamError) {
    return (
      error.code === "unavailable" || error.code === "deadline_exceeded" || /capacity|overload/i.test(error.message)
    );
  }
  return false;
}

/** Errors a host may recover from by compacting conversation history. */
export function isDevinContextOverflowError(error: unknown): boolean {
  return error instanceof DevinStreamError && error.contextOverflow;
}
