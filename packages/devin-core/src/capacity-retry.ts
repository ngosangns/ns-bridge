// ABOUTME: Optional capacity backoff around streamDevin, for hosts with no
// ABOUTME: retry loop of their own. The retry loop runs inside the sidecar so
// ABOUTME: no content is ever replayed — see go/internal/vendors/devin.

import { engineStream } from "ns-bridge-core/sidecar";
import { DEVIN_SIDECAR_VENDOR, devinErrorFromSidecar, toDevinSidecarRequest } from "./engine.js";
import type { DevinStreamRequest } from "./stream.js";
import type { DevinStreamEvent } from "./types.js";

export interface DevinCapacityRetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Capacity pressure on a serving model comes back either as a non-OK HTTP
 * status or as a trailer-only stream ("We are currently experiencing capacity
 * issues with this serving model."). Both surface as errors
 * `isDevinCapacityError` recognizes.
 */
export const DEFAULT_DEVIN_CAPACITY_RETRY: DevinCapacityRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 30_000,
};

/**
 * {@link streamDevin} with exponential backoff on capacity errors, executed by
 * the sidecar: the `start` event is held until real content arrives, so a
 * capacity failure after `start` but before any block is still retried; once a
 * block has been emitted, a failure propagates unchanged.
 *
 * Hosts that already retry OVERLOADED errors (the DeepSeek Harness) should
 * call {@link streamDevin} directly instead.
 */
export function streamDevinWithCapacityRetry(
  request: DevinStreamRequest,
  policy: DevinCapacityRetryPolicy = DEFAULT_DEVIN_CAPACITY_RETRY,
): AsyncIterable<DevinStreamEvent> {
  return engineStream<DevinStreamEvent, Record<string, unknown>>({
    vendor: DEVIN_SIDECAR_VENDOR,
    request: () => toDevinSidecarRequest(request, policy),
    mapError: devinErrorFromSidecar,
    ...(request.signal ? { signal: request.signal } : {}),
  });
}
