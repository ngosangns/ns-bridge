// ABOUTME: streamKiro — one Kiro turn in the ns-bridge Go binary, emitting the
// ABOUTME: neutral KiroStreamEvent sequence hosts render from. Request
// ABOUTME: building, retries, and event parsing live in go/internal/vendors/kiro.

import { streamKiroOnEngine } from "./engine.js";
import { resetKiroProfileArnCache } from "./management.js";
import type { KiroModel } from "./models.js";
import type { KiroEffort, KiroMessage, KiroStreamEvent, KiroTool } from "./types.js";
import type { KiroUsageTracking } from "./usage-tracking.js";

/** One model call, fully assembled by the host adapter. */
export interface KiroStreamRequest {
  model: KiroModel;
  messages: KiroMessage[];
  systemPrompt?: string;
  tools?: KiroTool[];
  /** Requested reasoning level; clamped against the model's own ladder. */
  effort?: KiroEffort;
  /** Bearer token for this call. */
  accessToken: string;
  /** Reused as Kiro's `conversationId`, so a session keeps one server-side thread. */
  sessionId?: string;
  profileArn?: string;
  signal?: AbortSignal;
  /**
   * Whether the host can drop blocks it has already been handed. Hosts that can
   * receive a {@link KiroStreamEvent} of type `reset` and discard everything
   * before it; hosts that cannot make the core settle for the terminal
   * behaviour instead of retrying mid-response.
   */
  canDiscardEmittedBlocks?: boolean;
  /**
   * Opt-in usage estimates (credit→USD value, cache-read estimation). Absent
   * means disabled; the core never reads a settings file on its own — the host
   * resolves the policy and passes it here.
   */
  usageTracking?: KiroUsageTracking;
}

let skipProfileResolutionForTests = false;
const TEST_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:000000000000:profile/test";

/** The profile ARN tests pin with `resetProfileArnCache(true)`, if any. */
export function testProfileArnOverride(): string | undefined {
  return skipProfileResolutionForTests ? TEST_PROFILE_ARN : undefined;
}

/** Reset profile resolution state — exported for stream tests. */
export function resetProfileArnCache(resolved = false): void {
  resetKiroProfileArnCache();
  skipProfileResolutionForTests = resolved;
}

/**
 * Stream one Kiro turn in the ns-bridge Go binary (`ns-bridge stream --vendor
 * kiro`). Errors surface as throws with the same classes the TypeScript engine
 * used to raise — see kiroErrorFromSidecar.
 */
export function streamKiro(request: KiroStreamRequest): AsyncIterable<KiroStreamEvent> {
  return streamKiroOnEngine(request);
}
