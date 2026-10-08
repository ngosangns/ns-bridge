// ABOUTME: Runs Kiro's one-shot operations (catalog refresh, usage, token refresh) on the selected engine,
// ABOUTME: carrying the profile caches across and mapping sidecar failures back to Kiro's error classes.

import { engineCall, type SidecarError } from "ns-bridge-core/sidecar";
import { KiroApiError, type KiroProviderAttempts } from "./errors.js";
import {
  applyKiroProfileArnCacheChanges,
  applyKiroProfileRegionChanges,
  KiroManagementHttpError,
  snapshotKiroProfileArnCache,
  snapshotKiroProfileRegionCache,
} from "./management.js";

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
 * Run `op` in the Go sidecar (with this process's profile caches) or
 * in-process, per NS_BRIDGE_ENGINE(_KIRO). The sidecar's cache changes are
 * folded back before the result is returned.
 */
export async function runKiroOp<TResult>(
  op: string,
  request: () => Record<string, unknown>,
  inProcess: () => Promise<TResult>,
): Promise<TResult> {
  let ranInProcess = false;
  const result = await engineCall<TResult & ProfileState, Record<string, unknown>>({
    vendor: "kiro",
    op,
    request: () => ({
      ...request(),
      profileArnCache: snapshotKiroProfileArnCache(),
      profileRegions: snapshotKiroProfileRegionCache(),
    }),
    inProcess: async () => {
      ranInProcess = true;
      return (await inProcess()) as TResult & ProfileState;
    },
    mapError: kiroErrorFromSidecar,
  });
  if (ranInProcess || !result || typeof result !== "object") return result;
  const { kiroProfileArns, kiroProfileRegions, ...rest } = result;
  applyKiroProfileArnCacheChanges(kiroProfileArns);
  applyKiroProfileRegionChanges(kiroProfileRegions);
  return rest as TResult;
}
