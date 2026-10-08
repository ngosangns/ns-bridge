// ABOUTME: The typed failure a Go sidecar call ends with, mirroring go/internal/bridge/errors.go.
// ABOUTME: Host adapters route on `kind` (re-login, back off, compact) instead of parsing vendor wording.

/**
 * Why a sidecar call failed. The first group comes from the binary's terminal
 * error line; `unavailable`, `crashed` and the client-side `protocol` cases are
 * raised by this client when the binary cannot say so itself.
 */
export type SidecarErrorKind =
  | "invalid_request"
  | "unsupported"
  | "auth"
  | "rate_limit"
  | "capacity"
  | "context_overflow"
  | "network"
  | "timeout"
  | "aborted"
  | "protocol"
  | "vendor"
  | "internal"
  /** The binary could not be started (not installed, not executable). */
  | "unavailable"
  /** The binary exited without a terminal line (crash, killed, exit != 0). */
  | "crashed";

/** The terminal `{"type":"error","error":{…}}` payload, as written by the binary. */
export interface SidecarErrorPayload {
  kind: SidecarErrorKind;
  message: string;
  vendor?: string;
  status?: number;
  retryAfterMs?: number;
  reasonCode?: string;
  /**
   * The vendor core's own error class this failure stands for (e.g.
   * `KiroApiError`), so a facade can rebuild it exactly.
   */
  vendorError?: string;
  /** Per-provider retry counts the vendor spent before giving up. */
  providerAttempts?: Record<string, number>;
}

export interface SidecarErrorDetails extends Partial<Omit<SidecarErrorPayload, "kind" | "message">> {
  /** Process exit code, when the process had exited. */
  exitCode?: number | null;
  /** Signal that ended the process, when one did. */
  exitSignal?: NodeJS.Signals | null;
  /** The last few KiB the binary wrote to stderr. */
  stderr?: string;
  cause?: unknown;
}

export class SidecarError extends Error {
  override readonly name = "SidecarError";
  readonly kind: SidecarErrorKind;
  readonly vendor?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly reasonCode?: string;
  readonly vendorError?: string;
  readonly providerAttempts?: Record<string, number>;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
  readonly stderr?: string;

  constructor(kind: SidecarErrorKind, message: string, details: SidecarErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = kind;
    this.vendor = details.vendor;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.reasonCode = details.reasonCode;
    this.vendorError = details.vendorError;
    this.providerAttempts = details.providerAttempts;
    this.exitCode = details.exitCode;
    this.exitSignal = details.exitSignal;
    this.stderr = details.stderr;
  }

  /** Rebuild the error a binary reported on its terminal line. */
  static fromPayload(payload: SidecarErrorPayload, details: SidecarErrorDetails = {}): SidecarError {
    const kind = typeof payload.kind === "string" ? payload.kind : "internal";
    const message = typeof payload.message === "string" && payload.message ? payload.message : `sidecar ${kind} error`;
    return new SidecarError(kind, message, {
      ...details,
      vendor: payload.vendor ?? details.vendor,
      status: payload.status,
      retryAfterMs: payload.retryAfterMs,
      reasonCode: payload.reasonCode,
      vendorError: payload.vendorError,
      providerAttempts: payload.providerAttempts,
    });
  }
}

export function isSidecarError(error: unknown): error is SidecarError {
  return error instanceof SidecarError;
}
