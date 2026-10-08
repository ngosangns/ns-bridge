// ABOUTME: The Harness LLM seam over kiro-core.

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import {
  type GenerateOptions,
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { streamToDsh } from "ns-bridge-core/dsh";
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
import { toKiroMessages } from "./messages.js";

/** What the plugin resolves per request and freezes for the duration of one call. */
export interface KiroAdapterOptions {
  /** The route this adapter is registered under. */
  provider: string;
  /** Human-readable provider name for selectors and diagnostics. */
  displayName: string;
  /** Resolve the current session; called once per request. */
  credentials: () => Promise<KiroCredentials>;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
  /** Region override; absent derives it from the credential. */
  region?: string;
}

const EFFORT_NAMES: Record<KiroEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export class KiroAdapter extends LlmAdapter {
  constructor(private readonly options: KiroAdapterOptions) {
    super();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.input.filter((modality) => modality === "text" || modality === "image"),
    }));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = this.catalog().find((candidate) => candidate.id === model);
    if (!known) throw new LlmError(`Unknown Kiro model: ${model}`, "UNKNOWN_MODEL");
    return {
      provider,
      id: known.id,
      name: known.name,
      inputModalities: known.input.filter((modality) => modality === "text" || modality === "image"),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      ...(known.efforts?.length
        ? {
            reasoning: {
              efforts: known.efforts.map((effort) => ({
                id: effort as ReasoningEffortId,
                name: EFFORT_NAMES[effort],
              })),
            },
          }
        : {}),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      yield* this.streamInner(options);
    } catch (error) {
      // `LlmRuntime.stream()` normalizes a throw into a terminal finish, but only
      // after this generator has surfaced it. Converting here is what gives the
      // loop a routing code instead of Kiro's raw wording.
      throw toLlmError(error);
    }
  }

  private async *streamInner(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credentials = await this.options.credentials();
    const region = this.options.region ?? resolveApiRegion(credentials.region);
    const model = this.catalog(region).find((candidate) => candidate.id === options.model);
    if (!model) throw new LlmError(`Unknown Kiro model: ${options.model}`, "UNKNOWN_MODEL");

    const projected = await toKiroMessages(options.messages, {
      attachments: this.options.attachments?.(),
      signal: options.signal,
    });
    // The Harness passes the system prompt as a request field, but a history it
    // replays may also carry `system`-role messages. Both are real system text,
    // so they are joined rather than one silently winning.
    const system = [options.system, projected.system].filter((part) => !!part).join("\n\n") || undefined;

    const tools: KiroTool[] | undefined = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    // Event translation (blocks, usage, finish, unclosed-block safety) is
    // shared with every dsh adapter in ns-bridge-core/dsh.
    yield* streamToDsh(
      streamKiro({
        model: { ...model, region, ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}) },
        messages: projected.messages,
        systemPrompt: system,
        tools,
        effort: options.reasoningEffort as KiroEffort | undefined,
        accessToken: credentials.access,
        sessionId: options.sessionId,
        signal: options.signal,
        profileArn: credentials.profileArn,
        // Kiro bills a repeated prefix for about half the credits and reports
        // no cache counters. Without this opt-in the harness has nothing to
        // draw except 0%. Dollar estimation stays off: Kiro publishes no
        // per-token price.
        usageTracking: resolveKiroUsageTracking({ estimateCacheUsage: true }),
        // The Harness assembler has no way to un-deliver a block, so the core must
        // settle a degenerate response rather than replay over one already sent.
        canDiscardEmittedBlocks: false,
      }),
    );
  }

  private catalog(region?: string): KiroModel[] {
    return getCachedModels(region ?? this.options.region ?? "us-east-1");
  }
}
