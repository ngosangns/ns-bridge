// ABOUTME: Devin ↔ sidecar glue: the request the Go vendor reads and the
// ABOUTME: error-field → typed-error reconstruction that keeps API parity.

import type { SidecarError } from "ns-bridge-core/sidecar";
import type { DevinCapacityRetryPolicy } from "./capacity-retry.js";
import { DevinApiError, DevinProtocolError, DevinStreamError } from "./errors.js";
import type { DevinStreamRequest } from "./stream.js";

/** Vendor id the sidecar's `devin` implementation answers to. */
export const DEVIN_SIDECAR_VENDOR = "devin";

/** The JSON the Go vendor reads (go/internal/vendors/devin StreamRequest). */
export function toDevinSidecarRequest(
  request: DevinStreamRequest,
  capacityRetry?: DevinCapacityRetryPolicy,
): Record<string, unknown> {
  const { signal: _signal, ...wire } = request;
  return capacityRetry ? { ...wire, capacityRetry } : wire;
}

const PROTOCOL_KINDS = new Set(["empty-body", "envelope", "runtime"]);

/**
 * The Devin error a sidecar failure stands for: an HTTP status becomes a
 * {@link DevinApiError}, a Connect trailer rejection a {@link DevinStreamError}
 * (so isDevinCapacityError & co. classify it as before), malformed wire data a
 * {@link DevinProtocolError}. Anything else (network, timeout, a missing or
 * crashed binary) stays a SidecarError.
 */
export function devinErrorFromSidecar(error: SidecarError): Error {
  if (error.status !== undefined) {
    const headers: Record<string, string> =
      error.retryAfterMs !== undefined ? { "retry-after": String(error.retryAfterMs / 1000) } : {};
    return new DevinApiError(error.message, "API", error.status, headers);
  }
  if (error.kind === "protocol" && error.reasonCode && PROTOCOL_KINDS.has(error.reasonCode)) {
    return new DevinProtocolError(error.message, error.reasonCode as "empty-body" | "envelope" | "runtime");
  }
  if (
    error.kind === "context_overflow" ||
    error.kind === "capacity" ||
    error.kind === "rate_limit" ||
    error.kind === "auth" ||
    error.kind === "vendor"
  ) {
    return new DevinStreamError(error.message, error.reasonCode ?? "", error.kind === "context_overflow");
  }
  return error;
}
