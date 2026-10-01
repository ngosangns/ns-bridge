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
  type TokenUsage,
  type ToolCallId,
} from "@deepseek-ai/dsh-llm";
import {
  getCachedModels,
  type KiroCredentials,
  type KiroEffort,
  type KiroModel,
  type KiroTool,
  type KiroUsage,
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

/**
 * Project one core usage record onto the harness token buckets.
 *
 * Kiro reports no cache counters. The session pill treats a missing
 * `cacheReadTokens` as zero, which is the "Cache hit 0%" reading, and a
 * turn drops its cache sum unless every step reported both cache fields.
 * Those fields also have to add up to `totalTokens` or the harness discards
 * the sample. Zeros cover a cold prefix; a later step in the same session
 * carries the core's repeated-prefix estimate.
 */
function toHarnessUsage(usage: KiroUsage): TokenUsage {
  const cacheReadTokens = usage.cacheRead ?? 0;
  const cacheWriteTokens = usage.cacheWrite ?? 0;
  const summed = usage.input + cacheReadTokens + cacheWriteTokens + usage.output;
  if (usage.totalTokens !== summed) {
    return {
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
    };
  }
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: summed,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

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

    const openBlocks = new Set<number>();
    for await (const event of streamKiro({
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
    })) {
      switch (event.type) {
        case "text_start":
          openBlocks.add(event.index);
          yield { type: "block-start", index: event.index, blockType: "text" };
          break;
        case "text_delta":
          yield { type: "text-delta", index: event.index, text: event.delta };
          break;
        case "text_end":
          openBlocks.delete(event.index);
          yield { type: "block-end", index: event.index, block: { type: "text", text: event.text } };
          break;
        case "thinking_start":
          openBlocks.add(event.index);
          yield { type: "block-start", index: event.index, blockType: "reasoning" };
          break;
        case "thinking_delta":
          yield { type: "reasoning-delta", index: event.index, text: event.delta };
          break;
        case "thinking_end":
          openBlocks.delete(event.index);
          yield { type: "block-end", index: event.index, block: { type: "reasoning", text: event.thinking } };
          break;
        case "tool_call_start":
          openBlocks.add(event.index);
          yield { type: "block-start", index: event.index, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index: event.index,
            id: event.id as ToolCallId,
            name: event.name,
            argumentsDelta: "",
          };
          break;
        case "tool_call_delta":
          yield {
            type: "tool-call-delta",
            index: event.index,
            id: event.id as ToolCallId,
            argumentsDelta: event.argumentsDelta,
          };
          break;
        case "tool_call_end":
          openBlocks.delete(event.index);
          yield {
            type: "block-end",
            index: event.index,
            block: {
              type: "tool-call",
              id: event.id as ToolCallId,
              name: event.name,
              arguments: JSON.stringify(event.arguments),
            },
          };
          break;
        case "usage":
          yield { type: "usage", usage: toHarnessUsage(event.usage) };
          break;
        case "done":
          yield {
            type: "finish",
            reason:
              event.stopReason === "toolUse"
                ? { kind: "tool-calls" }
                : event.stopReason === "length"
                  ? { kind: "max-tokens" }
                  : { kind: "stop" },
            // The finish union carries no message field for a successful
            // reason, so a terminal diagnostic rides the replay envelope —
            // the harness stores it on the assembled message's model source.
            ...(event.errorMessage ? { replayState: { response: { errorMessage: event.errorMessage } } } : {}),
          };
          break;
        // `start` needs no chunk. `reset` can arrive on a mid-stream-error
        // retry; this adapter cannot un-deliver a block, so it ignores the
        // marker and lets the retried attempt continue on fresh indexes.
      }
    }

    // A block the core opened but never closed would leave the assembler waiting
    // for content that is not coming. That is only reachable if the core adds an
    // exit path before its terminal events, so close them rather than trust it.
    for (const index of openBlocks) {
      yield { type: "block-end", index, block: { type: "text", text: "" } };
    }
  }

  private catalog(region?: string): KiroModel[] {
    return getCachedModels(region ?? this.options.region ?? "us-east-1");
  }
}
