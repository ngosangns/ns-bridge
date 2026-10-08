// ABOUTME: The Harness LLM seam over devin-core.

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
  type DevinCredentials,
  type DevinEffort,
  type DevinTool,
  fetchDevinModels,
  getCachedModels,
  isCacheStale,
  logger,
  streamDevin,
  updateDevinModelsCache,
} from "ns-devin-core";
import { toLlmError } from "./errors.js";
import { toDevinMessages } from "./messages.js";

/** What the plugin resolves per request and freezes for the duration of one call. */
export interface DevinAdapterOptions {
  /** The route this adapter is registered under. */
  provider: string;
  /** Human-readable provider name for selectors and diagnostics. */
  displayName: string;
  /** Resolve the current session; called once per request. */
  credentials: () => Promise<DevinCredentials>;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

const EFFORT_NAMES: Record<DevinEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export class DevinAdapter extends LlmAdapter {
  constructor(private readonly options: DevinAdapterOptions) {
    super();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName };
  }

  private refreshPromise: Promise<void> | undefined;

  /**
   * `GetCliModelConfigs` refreshes the catalog when the disk cache is stale.
   * A failed refresh leaves the stale (or seed) catalog in place — listing
   * must never fail just because discovery could not reach the server.
   */
  private refreshCatalog(): Promise<void> {
    this.refreshPromise ??= (async () => {
      try {
        if (!isCacheStale()) return;
        const credentials = await this.options.credentials();
        const fetched = await fetchDevinModels({ apiKey: credentials.access });
        if (fetched) updateDevinModelsCache(fetched);
      } catch (error) {
        logger.warn("model discovery refresh failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.refreshPromise = undefined;
      }
    })();
    return this.refreshPromise;
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.refreshCatalog();
    return getCachedModels().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.input.filter((modality) => modality === "text" || modality === "image"),
    }));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.refreshCatalog();
    const known = getCachedModels().find((candidate) => candidate.id === model);
    if (!known) throw new LlmError(`Unknown Devin model: ${model}`, "UNKNOWN_MODEL");
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
      // loop a routing code instead of Devin's raw wording.
      throw toLlmError(error);
    }
  }

  private async *streamInner(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credentials = await this.options.credentials();
    const model = getCachedModels().find((candidate) => candidate.id === options.model);
    if (!model) throw new LlmError(`Unknown Devin model: ${options.model}`, "UNKNOWN_MODEL");

    const projected = await toDevinMessages(options.messages, {
      attachments: this.options.attachments?.(),
      signal: options.signal,
    });
    // The Harness passes the system prompt as a request field, but a history it
    // replays may also carry `system`-role messages. Both are real system text,
    // so they are joined rather than one silently winning.
    const system = [options.system, projected.system].filter((part) => !!part).join("\n\n") || undefined;

    const tools: DevinTool[] | undefined = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    // Event translation (blocks, usage, finish, unclosed-block safety) is
    // shared with every dsh adapter in ns-bridge-core/dsh.
    yield* streamToDsh(
      streamDevin({
        model,
        messages: projected.messages,
        systemPrompt: system,
        tools,
        effort: options.reasoningEffort as DevinEffort | undefined,
        apiKey: credentials.access,
        sessionId: options.sessionId,
        signal: options.signal,
      }),
    );
  }
}
