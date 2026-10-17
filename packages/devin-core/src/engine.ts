// ABOUTME: Routes a Devin turn to the ns-bridge Go sidecar or the in-process TypeScript core,
// ABOUTME: and turns sidecar failures back into Devin's own error classes so adapters route them unchanged.

import { type BridgeEngine, engineStream, SidecarError, selectBridgeEngine } from "ns-bridge-core/sidecar";
import type { DevinCapacityRetryPolicy } from "./capacity-retry.js";
import { DevinApiError, DevinProtocolError, DevinStreamError } from "./errors.js";
import type { DevinStreamRequest } from "./stream.js";
import type { DevinStreamEvent } from "./types.js";

/** The sidecar vendor id. */
export const DEVIN_SIDECAR_VENDOR = "devin";

/** The engine a request runs on: injected `fetch` pins it to TypeScript. */
export function selectDevinEngine(request: Pick<DevinStreamRequest, "fetch">): BridgeEngine {
  return request.fetch ? "ts" : selectBridgeEngine(DEVIN_SIDECAR_VENDOR);
}

/** The JSON the Go vendor reads (go/internal/vendors/devin StreamRequest). */
export function toDevinSidecarRequest(
  request: DevinStreamRequest,
  capacityRetry?: DevinCapacityRetryPolicy,
): Record<string, unknown> {
  const { signal: _signal, fetch: _fetch, ...wire } = request;
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

/** Run a turn on the selected engine; `inProcess` is the TypeScript fallback. */
export function streamDevinOnEngine(
  request: DevinStreamRequest,
  capacityRetry: DevinCapacityRetryPolicy | undefined,
  inProcess: (request: DevinStreamRequest) => AsyncIterable<DevinStreamEvent>,
): AsyncIterable<DevinStreamEvent> {
  if (request.fetch) return inProcess(request);
  return engineStream<DevinStreamEvent, Record<string, unknown>>({
    vendor: DEVIN_SIDECAR_VENDOR,
    request: () => toDevinSidecarRequest(request, capacityRetry),
    inProcess: () => inProcess(request),
    mapError: devinErrorFromSidecar,
    ...(request.signal ? { signal: request.signal } : {}),
  });
}

export { SidecarError };
