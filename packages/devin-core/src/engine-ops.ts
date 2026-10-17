// ABOUTME: Runs Devin's one-shot operations (model discovery, usage) on the selected engine.
// ABOUTME: Both are advisory: any failure, in either engine, resolves to the caller's fallback.

import { engineCall } from "ns-bridge-core/sidecar";
import { DEVIN_SIDECAR_VENDOR, devinErrorFromSidecar } from "./engine.js";
import { logger } from "./util.js";

export interface DevinOpOptions<TResult, TWire> {
  op: string;
  /** The request as the Go vendor reads it. */
  request: () => Record<string, unknown>;
  /** The in-process TypeScript implementation (never throws). */
  inProcess: () => Promise<TResult>;
  /** Shape the sidecar's result into what {@link inProcess} returns. */
  fromWire: (wire: TWire) => TResult;
  /** Returned when the sidecar fails (a fail-soft operation never throws). */
  fallback: TResult;
  signal?: AbortSignal;
}

/**
 * Run `op` in the Go sidecar or in-process, per NS_BRIDGE_ENGINE(_DEVIN). A
 * sidecar failure is logged and resolves to `fallback`, the same outcome the
 * TypeScript implementation gives a failed request.
 */
export async function runDevinOp<TResult, TWire>(options: DevinOpOptions<TResult, TWire>): Promise<TResult> {
  let ranInProcess = false;
  try {
    const result = await engineCall<unknown, Record<string, unknown>>({
      vendor: DEVIN_SIDECAR_VENDOR,
      op: options.op,
      request: options.request,
      inProcess: async () => {
        ranInProcess = true;
        return options.inProcess();
      },
      mapError: devinErrorFromSidecar,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return ranInProcess ? (result as TResult) : options.fromWire(result as TWire);
  } catch (error) {
    if (ranInProcess) throw error;
    logger.warn(`Devin ${options.op} sidecar call failed`, {
      error: error instanceof Error ? error.name : "unknown",
    });
    return options.fallback;
  }
}
