// ABOUTME: Runs Devin's one-shot operations (model discovery, usage) in the
// ABOUTME: ns-bridge Go binary. Both are advisory: any failure resolves to the
// ABOUTME: caller's fallback.

import { engineCall } from "ns-bridge-core/sidecar";
import { DEVIN_SIDECAR_VENDOR, devinErrorFromSidecar } from "./engine.js";
import { logger } from "./util.js";

export interface DevinOpOptions<TResult, TWire> {
  op: string;
  /** The request as the Go vendor reads it. */
  request: () => Record<string, unknown>;
  /** Shape the sidecar's result into the facade's return type. */
  fromWire: (wire: TWire) => TResult;
  /** Returned when the sidecar fails (a fail-soft operation never throws). */
  fallback: TResult;
  signal?: AbortSignal;
}

/**
 * Run `op` in the Go sidecar. A sidecar failure is logged and resolves to
 * `fallback`, the same outcome a failed request always gave callers.
 */
export async function runDevinOp<TResult, TWire>(options: DevinOpOptions<TResult, TWire>): Promise<TResult> {
  try {
    const result = await engineCall<unknown, Record<string, unknown>>({
      vendor: DEVIN_SIDECAR_VENDOR,
      op: options.op,
      request: options.request,
      mapError: devinErrorFromSidecar,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return options.fromWire(result as TWire);
  } catch (error) {
    logger.warn(`Devin ${options.op} sidecar call failed`, {
      error: error instanceof Error ? error.name : "unknown",
    });
    return options.fallback;
  }
}
