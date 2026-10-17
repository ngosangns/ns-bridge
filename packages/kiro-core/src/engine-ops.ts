// ABOUTME: Runs Kiro's one-shot operations (catalog refresh, usage, token refresh)
// ABOUTME: in the Go sidecar and maps sidecar failures back to Kiro's error classes.

import { engineCall, type SidecarError } from "ns-bridge-core/sidecar";
import { KiroApiError, type KiroProviderAttempts } from "./errors.js";
import { KiroManagementHttpError } from "./management.js";

/**
 * The Kiro error a sidecar failure stands for, rebuilt from the class the Go
 * vendor names. Anything else (a missing or crashed binary, a network failure)
 * stays a SidecarError.
 */
export function kiroErrorFromSidecar(error: SidecarError): Error {
  switch (error.vendorError) {
    case "KiroApiError":
      return new KiroApiError(
        error.message,
        error.status ?? 0,
        error.reasonCode,
        error.retryAfterMs,
        error.providerAttempts as KiroProviderAttempts | undefined,
      );
    case "KiroManagementHttpError":
      return new KiroManagementHttpError(error.message, error.status ?? 0);
    case "Error":
      return new Error(error.message);
    default:
      return error;
  }
}

interface ProfileState {
  kiroProfileArns?: Record<string, string | null>;
  kiroProfileRegions?: Record<string, string>;
}

/**
 * Run `op` in the Go sidecar. Profile caches live in the binary's process-state
 * file, so the request does not carry them. Bookkeeping fields on the result
 * are dropped before the caller sees it.
 */
export async function runKiroOp<TResult>(op: string, request: () => Record<string, unknown>): Promise<TResult> {
  const result = await engineCall<TResult & ProfileState, Record<string, unknown>>({
    vendor: "kiro",
    op,
    request,
    mapError: kiroErrorFromSidecar,
  });
  if (!result || typeof result !== "object") return result;
  const { kiroProfileArns: _arns, kiroProfileRegions: _regions, ...rest } = result;
  return rest as TResult;
}
