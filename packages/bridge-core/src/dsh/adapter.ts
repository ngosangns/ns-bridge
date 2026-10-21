// ABOUTME: The one Harness LlmAdapter every vendor route is built from.
// ABOUTME: Vendor differences enter as a spec, so the adapter skeleton exists once.

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
import { compactionBudget } from "ns-core-utils";
import type { BridgeMessage, BridgeStreamEvent } from "../types.js";
import { toBridgeMessagesFromDsh } from "./messages.js";
import { streamToDsh } from "./stream.js";

/** One model as the Harness picker and resolver read it. */
export interface DshAdapterModel {
  id: string;
  name: string;
  /** Modalities this route accepts; filtered to what the Harness understands. */
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  /**
   * Output tokens the Harness should hold back when it decides whether the
   * context is full, when that differs from {@link maxTokens}.
   *
   * The Harness treats `defaultMaxTokens` as output reserved out of the window:
   * it compacts once the context passes `min(window × ratio, window − reserved −
   * headroom)`. Reporting the catalog's maximum completion there, on top of the
   * plugin's own headroom, compacts far too early. This field is what gets
   * reported instead. It never reaches a vendor request — the catalog maximum
   * stays the completion ceiling.
   *
   * Absent means the catalog maximum is a fair reservation on its own.
   */
  compactionReserveTokens?: number;
  /** Reasoning rungs this model exposes, lowest first. Absent means none. */
  efforts?: readonly string[];
}

/**
 * What the factory actually reads off a catalog entry.
 *
 * A vendor model carries more than this (Kiro's `kiroModelId`, `cost`, …), and
 * the spec's `stream` needs the whole thing. Typing the catalog as the vendor's
 * own model and reading it through this subset keeps both true without a cast.
 */
type AdapterModelFields = Pick<
  DshAdapterModel,
  "id" | "name" | "input" | "contextWindow" | "maxTokens" | "compactionReserveTokens" | "efforts"
>;

/**
 * Output tokens reported to the Harness as reserved out of the context window.
 *
 * The Harness compacts at `floor(min(window × ratio, window − reserved −
 * headroom))`, and it takes `reserved` from the adapter's `defaultMaxTokens`.
 * A catalog ceiling of 128k on a 256k window, plus the plugin's own 65,536
 * headroom, leaves a trigger near 62k — about a quarter of the window, against
 * the ~80% the native harnesses use and the `window − 16,384` Pi uses.
 *
 * The reported reservation is therefore the smaller of the catalog ceiling and
 * 16,384, which is what {@link compactionBudget} holds back. That is Pi's
 * `reserveTokens`, not a guess at how long one completion runs: it is the
 * output a host already treats as "held back" without clipping a normal turn.
 * A ceiling at or below that floor is already a fair reservation, so it is
 * left untouched.
 *
 * This number is only what the Harness holds back. It is not forwarded to a
 * vendor, so the catalog ceiling stays the completion cap on the wire.
 *
 * The budget itself is {@link compactionBudget}, shared with the catalog
 * refresh so the number written next to an entry and the number reported here
 * are the same one. A window no larger than the floor has no smaller
 * reservation to offer, and the caller falls back to the catalog ceiling.
 */
export function compactionReserveTokens(model: { contextWindow: number; maxTokens: number }): number | undefined {
  const budget = compactionBudget(model);
  if (!budget || budget.reserveTokens >= model.maxTokens) return undefined;
  return budget.reserveTokens;
}

/**
 * One request as a vendor spec receives it: the Harness options with the
 * conversation already projected onto the neutral vocabulary, so a spec never
 * touches Harness message types.
 */
export interface DshAdapterRequest extends Omit<GenerateOptions, "messages" | "system"> {
  messages: BridgeMessage[];
  system?: string;
  /**
   * Context window of the model this request names, when the spec's catalog
   * knows one. A spec uses it to keep the request inside the window; the
   * Harness still owns compaction, so a spec that cannot fit reports overflow
   * rather than dropping the current turn.
   */
  contextWindow?: number;
}

/**
 * Everything that differs between one vendor route and the next.
 *
 * The adapter skeleton — provider info, catalog projection, model resolution,
 * message projection, error conversion, and the stream wrapper — is identical
 * across vendors and lives in {@link createDshLlmAdapter}. A spec supplies only
 * the vendor half.
 */
export interface DshLlmAdapterSpec<Credentials, Model extends AdapterModelFields = DshAdapterModel> {
  /** The route this adapter is registered under. */
  provider: string;
  /** Human-readable provider name for selectors and diagnostics. */
  displayName: string;
  /** The models to list and resolve. Read from disk; never the network. */
  catalog: () => readonly Model[];
  /** Resolve the current session; called once per request. */
  credentials: () => Promise<Credentials>;
  /**
   * Build the vendor request and return its neutral event stream. The adapter
   * wraps the result in {@link streamToDsh}, so a spec never emits Harness
   * chunks itself.
   */
  stream: (request: DshAdapterRequest, credentials: Credentials) => AsyncIterable<BridgeStreamEvent>;
  /**
   * The context window of one catalog model, read at request time.
   *
   * A spec that trims its own request needs the number before the call. The
   * catalog is the source, so this is read per request rather than captured
   * when the adapter was built: a refresh between turns has to take effect.
   */
  contextWindow?: (model: string) => number | undefined;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

/** Display names for the shared reasoning ladder. */
const EFFORT_NAMES: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

function inputModalities(model: AdapterModelFields): LlmModelInfo["inputModalities"] {
  return model.input.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image");
}

function toModelInfo(provider: string, model: AdapterModelFields): LlmModelInfo {
  return { provider, id: model.id, name: model.name, inputModalities: inputModalities(model) };
}

function toResolvedModel(provider: string, model: AdapterModelFields): LlmResolvedModelInfo {
  return {
    ...toModelInfo(provider, model),
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.compactionReserveTokens ?? model.maxTokens,
    ...(model.efforts?.length
      ? {
          reasoning: {
            efforts: model.efforts.map((effort) => ({
              id: effort as ReasoningEffortId,
              name: EFFORT_NAMES[effort] ?? effort,
            })),
          },
        }
      : {}),
  };
}

/**
 * Build the Harness adapter for one vendor route.
 *
 * `toLlmError` is injected rather than imported so each vendor keeps its own
 * failure vocabulary: the loop branches on the resulting code, so a mislabelled
 * failure either retries forever or gives up on something transient.
 */
export function createDshLlmAdapter<Credentials, Model extends AdapterModelFields = DshAdapterModel>(
  spec: DshLlmAdapterSpec<Credentials, Model>,
  toLlmError: (error: unknown) => LlmError,
): LlmAdapter {
  return new (class extends LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo {
      return { id: provider, name: spec.displayName };
    }

    async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      // The Harness awaits this while it builds the model list, so it serves
      // the on-disk catalog (or the vendor's seed). `ns-bridge models refresh`
      // is what updates that file.
      return spec.catalog().map((model) => toModelInfo(provider, model));
    }

    async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      const known = spec.catalog().find((candidate) => candidate.id === model);
      if (!known) throw new LlmError(`Unknown ${spec.displayName} model: ${model}`, "UNKNOWN_MODEL");
      return toResolvedModel(provider, known);
    }

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      try {
        yield* this.streamInner(options);
      } catch (error) {
        // `LlmRuntime.stream()` normalizes a throw into a terminal finish, but
        // only after this generator has surfaced it. Converting here is what
        // gives the loop a routing code instead of the vendor's raw wording.
        throw toLlmError(error);
      }
    }

    private async *streamInner(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const credentials = await spec.credentials();
      const projected = await toBridgeMessagesFromDsh(options.messages, {
        attachments: spec.attachments?.(),
        signal: options.signal,
      });
      // The Harness passes the system prompt as a request field, but a history
      // it replays may also carry `system`-role messages. Both are real system
      // text, so they are joined rather than one silently winning.
      const system = [options.system, projected.system].filter((part) => !!part).join("\n\n") || undefined;
      const contextWindow = spec.contextWindow?.(options.model);

      yield* streamToDsh(
        spec.stream(
          {
            ...options,
            messages: projected.messages,
            ...(system !== undefined ? { system } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          },
          credentials,
        ),
      );
    }
  })();
}
