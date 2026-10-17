// ABOUTME: Optional capacity backoff around streamDevin, for hosts with no retry loop of their own.
// ABOUTME: Retries only while nothing but `start` has been produced, so no content is ever replayed.

import { selectDevinEngine, streamDevinOnEngine } from "./engine.js";
import { isDevinCapacityError } from "./errors.js";
import { type DevinStreamRequest, streamDevin } from "./stream.js";
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
 * {@link isDevinCapacityError} recognizes.
 */
export const DEFAULT_DEVIN_CAPACITY_RETRY: DevinCapacityRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 30_000,
};

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * {@link streamDevin} with exponential backoff on capacity errors. The core's
 * `start` event is held until real content arrives, so a capacity failure
 * after `start` but before any block is still retryable; once a block has been
 * emitted, a failure propagates unchanged — a mid-stream failure must not be
 * replayed over content the host already showed.
 *
 * Hosts that already retry OVERLOADED errors (the DeepSeek Harness) should
 * call {@link streamDevin} directly instead.
 */
export async function* streamDevinWithCapacityRetry(
  request: DevinStreamRequest,
  policy: DevinCapacityRetryPolicy = DEFAULT_DEVIN_CAPACITY_RETRY,
  stream: (request: DevinStreamRequest) => AsyncIterable<DevinStreamEvent> = streamDevin,
): AsyncIterable<DevinStreamEvent> {
  // On the Go engine the sidecar runs the same backoff itself.
  if (stream === streamDevin && selectDevinEngine(request) === "go") {
    yield* streamDevinOnEngine(request, policy, streamDevin);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    let heldStart: DevinStreamEvent | undefined;
    let committed = false;
    try {
      for await (const event of stream(request)) {
        if (!committed && event.type === "start") {
          heldStart = event;
          continue;
        }
        if (!committed) {
          committed = true;
          if (heldStart) yield heldStart;
        }
        yield event;
      }
      if (!committed && heldStart) yield heldStart;
      return;
    } catch (error) {
      if (committed || attempt >= policy.maxRetries || !isDevinCapacityError(error)) throw error;
      await abortableDelay(Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs), request.signal);
    }
  }
}
