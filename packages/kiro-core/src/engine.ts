// ABOUTME: Kiro ↔ sidecar glue: the request the Go vendor reads and the
// ABOUTME: per-process state (profile ARNs, cache estimates, catalog refresh)
// ABOUTME: a one-turn sidecar cannot hold, folded back over the event stream.

import { engineStream, SidecarError } from "ns-bridge-core/sidecar";
import { applyCacheEstimate } from "./cache-estimator.js";
import { debugLog, formatSafeError } from "./debug.js";
import { getKiroRegionFromProfileArn } from "./endpoints.js";
import { kiroErrorFromSidecar } from "./engine-ops.js";
import { applyKiroProfileArnCacheChanges, snapshotKiroProfileArnCache } from "./management.js";
import { isCacheStale, resolveKiroModel, updateKiroModelsCache } from "./models.js";
import { capacityRetryConfig, firstTokenTimeoutForModel, retryConfig } from "./retry.js";
import type { KiroStreamRequest } from "./stream.js";
import { testProfileArnOverride } from "./stream.js";
import type { KiroStreamEvent, KiroUsage } from "./types.js";
import { KIRO_USAGE_TRACKING_DISABLED } from "./usage-tracking.js";

/** The sidecar vendor id. */
export const KIRO_SIDECAR_VENDOR = "kiro";

/**
 * The JSON the Go vendor reads (go/internal/vendors/kiro StreamRequest): the
 * request with its model id pre-resolved, plus the state this process holds.
 * Throws whatever {@link resolveKiroModel} throws.
 */
export function toKiroSidecarRequest(request: KiroStreamRequest, conversationId: string): Record<string, unknown> {
  const { signal: _signal, ...wire } = request;
  const kiroModelId = resolveKiroModel(request.model.id, request.model.kiroModelId);
  const testProfileArn = testProfileArnOverride();
  return {
    ...wire,
    model: { ...request.model, kiroModelId },
    conversationId,
    profileArnCache: snapshotKiroProfileArnCache(),
    timeouts: {
      firstTokenMs: request.model.firstTokenTimeout ?? firstTokenTimeoutForModel(request.model.id),
      requestHeaderMs: retryConfig.requestHeaderTimeoutMs,
    },
    capacityRetry: { ...capacityRetryConfig },
    ...(testProfileArn ? { testProfileArn } : {}),
  };
}

type SidecarUsageEvent = { type: "usage"; usage: KiroUsage; kiroWireCache?: boolean };
type SidecarDoneEvent = Extract<KiroStreamEvent, { type: "done" }> & {
  kiroProfileArns?: Record<string, string | null>;
  kiroRuntimeRegion?: string;
  kiroProfileArn?: string;
};

/**
 * Apply to sidecar events what needs per-process state: fold profile ARNs back
 * into the cache, estimate cache reads across turns, and refresh a stale model
 * catalog in the background.
 */
async function* postProcess(
  events: AsyncIterable<KiroStreamEvent>,
  request: KiroStreamRequest,
  conversationId: string,
): AsyncGenerator<KiroStreamEvent> {
  let pendingUsage: SidecarUsageEvent | undefined;
  for await (const event of events) {
    if (event.type === "usage") {
      pendingUsage = event as SidecarUsageEvent;
      continue;
    }
    if (event.type !== "done") {
      yield event;
      continue;
    }
    const { kiroProfileArns, kiroRuntimeRegion, kiroProfileArn, ...done } = event as SidecarDoneEvent;
    applyKiroProfileArnCacheChanges(kiroProfileArns);
    const region = kiroRuntimeRegion ?? getKiroRegionFromProfileArn(kiroProfileArn) ?? request.model.region;
    if (!process.env.VITEST && region && kiroProfileArn && isCacheStale(region)) {
      updateKiroModelsCache(request.accessToken, region, kiroProfileArn).catch((error) => {
        console.warn(`[kiro-core] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
      });
    }
    if (pendingUsage) {
      const { kiroWireCache, ...usageEvent } = pendingUsage;
      if (!done.errorMessage) {
        const estimatedRead = applyCacheEstimate(
          conversationId,
          usageEvent.usage,
          kiroWireCache ? { cacheReadInputTokens: 0 } : null,
          request.usageTracking ?? KIRO_USAGE_TRACKING_DISABLED,
        );
        if (estimatedRead > 0) {
          debugLog("usage.estimate", {
            conversationId,
            estimatedRead,
            input: usageEvent.usage.input,
            cacheRead: usageEvent.usage.cacheRead,
          });
        }
      }
      pendingUsage = undefined;
      yield usageEvent as KiroStreamEvent;
    }
    yield done as KiroStreamEvent;
  }
  if (pendingUsage) {
    const { kiroWireCache: _wire, ...usageEvent } = pendingUsage;
    yield usageEvent as KiroStreamEvent;
  }
}

/** Run a turn in the Go sidecar. */
export function streamKiroOnEngine(request: KiroStreamRequest): AsyncIterable<KiroStreamEvent> {
  const conversationId = request.sessionId ?? crypto.randomUUID();
  return engineStream<KiroStreamEvent, Record<string, unknown>>({
    vendor: KIRO_SIDECAR_VENDOR,
    request: () => toKiroSidecarRequest(request, conversationId),
    mapError: kiroErrorFromSidecar,
    transform: (events) => postProcess(events, request, conversationId),
    ...(request.signal ? { signal: request.signal } : {}),
  });
}

export { kiroErrorFromSidecar, SidecarError };
