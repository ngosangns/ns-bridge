// ABOUTME: The Harness LLM seam over kiro-core, built from the shared dsh adapter factory.

import { withDeclaredToolNames } from "ns-bridge-core";
import {
  compactionReserveTokens,
  createDshLlmAdapter,
  type DshAdapterRequest,
  type DshLlmAdapterSpec,
} from "ns-bridge-core/dsh";
import {
  getCachedModels,
  type KiroCredentials,
  type KiroEffort,
  type KiroModel,
  type KiroTool,
  resolveApiRegion,
  resolveKiroUsageTracking,
  streamKiro,
} from "ns-kiro-core";
import { toLlmError } from "./errors.js";

/**
 * Report a smaller output reservation than the catalog ceiling, so the Harness
 * does not compact at `window − ceiling − headroom`. The catalog `maxTokens`
 * stays the completion ceiling; Kiro's request builder never reads it anyway.
 */
function withCompactionReserve<
  T extends { contextWindow: number; maxTokens: number; compaction?: { reserveTokens: number } },
>(model: T): T {
  // The catalog's own figure wins; a cache written before the field existed
  // falls back to the formula the refresh now writes.
  const reserve = model.compaction?.reserveTokens ?? compactionReserveTokens(model);
  return reserve !== undefined && reserve < model.maxTokens ? { ...model, compactionReserveTokens: reserve } : model;
}

/** What the plugin resolves per request and freezes for the duration of one call. */
export interface KiroAdapterOptions {
  /** The route this adapter is registered under. */
  provider: string;
  /** Human-readable provider name for selectors and diagnostics. */
  displayName: string;
  /** Resolve the current session; called once per request. */
  credentials: () => Promise<KiroCredentials>;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => import("@deepseek-ai/dsh-attachment").AttachmentStore | undefined;
  /** Region override; absent derives it from the credential. */
  region?: string;
}

/** Build the Harness adapter for the Kiro route. */
export function createKiroAdapter(options: KiroAdapterOptions) {
  const catalog = (region?: string): readonly KiroModel[] => getCachedModels(region ?? options.region ?? "us-east-1");

  const spec: DshLlmAdapterSpec<KiroCredentials, KiroModel> = {
    provider: options.provider,
    displayName: options.displayName,
    catalog: () => catalog().map(withCompactionReserve),
    credentials: options.credentials,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    stream: (request: DshAdapterRequest, credentials) => {
      const region = options.region ?? resolveApiRegion(credentials.region);
      const model = catalog(region).find((candidate) => candidate.id === request.model);
      if (!model) throw new Error(`Unknown Kiro model: ${request.model}`);

      const tools: KiroTool[] | undefined = request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

      const events = streamKiro({
        model: { ...model, region, ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}) },
        messages: request.messages,
        systemPrompt: request.system,
        tools,
        effort: request.reasoningEffort as KiroEffort | undefined,
        accessToken: credentials.access,
        sessionId: request.sessionId,
        signal: request.signal,
        profileArn: credentials.profileArn,
        // Kiro bills a repeated prefix for about half the credits and reports
        // no cache counters. Without this opt-in the harness has nothing to
        // draw except 0%. Dollar estimation stays off: Kiro publishes no
        // per-token price.
        usageTracking: resolveKiroUsageTracking({ estimateCacheUsage: true }),
        // The Harness assembler has no way to un-deliver a block, so the core must
        // settle a degenerate response rather than replay over one already sent.
        canDiscardEmittedBlocks: false,
      });
      return withDeclaredToolNames(events, request.tools);
    },
  };

  return createDshLlmAdapter(spec, toLlmError);
}
