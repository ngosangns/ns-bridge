// ABOUTME: streamDevin — one Cascade turn in the ns-bridge Go binary, emitting
// ABOUTME: the neutral DevinStreamEvent sequence hosts render from.

import { engineStream } from "ns-bridge-core/sidecar";
import { DEVIN_SIDECAR_VENDOR, devinErrorFromSidecar, toDevinSidecarRequest } from "./engine.js";
import type { DevinEffort, DevinMessage, DevinModelSpec, DevinStreamEvent, DevinTool, DevinUsage } from "./types.js";

/**
 * Everything a single Cascade turn needs, in host-neutral terms. Adapters
 * project their conversation/model vocabulary onto this before calling in.
 */
export interface DevinStreamRequest {
  /** The catalog entry the user selected (router specs included). */
  model: DevinModelSpec;
  messages: DevinMessage[];
  systemPrompt?: string | readonly string[];
  tools?: DevinTool[];
  /** Selected reasoning effort; resolves through `model.effortMap`. */
  effort?: DevinEffort;
  /** Devin session token (`devin-session-token$…` or raw — normalized inside). */
  apiKey?: string;
  /** Cascade conversation id; reused so the server threads turns. */
  conversationId?: string;
  /** Falls back to `conversationId` when no `conversationId` is supplied. */
  sessionId?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Explicit wire uid; wins over effort routing and the model id. */
  chatModelUid?: string;
}

/**
 * Heuristic bound for the opaque `invalid_argument` trailer Devin raises on a
 * too-large request. Not asserted to be the backend's real limit — it marks
 * the history size at which compaction is worth attempting over a hard fail.
 * The Go vendor applies the same bound to its context-overflow recovery.
 */
export const LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

/** Dollar cost for one turn under the model's per-million-token rate card. */
export function calculateDevinCost(
  cost: DevinModelSpec["cost"],
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): DevinUsage["cost"] {
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const input = per(usage.input, cost.input);
  const output = per(usage.output, cost.output);
  const cacheRead = per(usage.cacheRead, cost.cacheRead);
  const cacheWrite = per(usage.cacheWrite, cost.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Stream one Cascade turn in the ns-bridge Go binary (`ns-bridge stream
 * --vendor devin`). Errors surface as throws with the same types the TypeScript
 * engine used to raise: `DevinApiError` on the HTTP envelope,
 * `DevinStreamError` on a Connect trailer rejection, `DevinProtocolError` on
 * malformed wire data.
 */
export function streamDevin(request: DevinStreamRequest): AsyncIterable<DevinStreamEvent> {
  return engineStream<DevinStreamEvent, Record<string, unknown>>({
    vendor: DEVIN_SIDECAR_VENDOR,
    request: () => toDevinSidecarRequest(request),
    mapError: devinErrorFromSidecar,
    ...(request.signal ? { signal: request.signal } : {}),
  });
}
