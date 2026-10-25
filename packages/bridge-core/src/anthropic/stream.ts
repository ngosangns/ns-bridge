// ABOUTME: Drives a vendor core's neutral event stream into Anthropic Messages SSE frames and messages.
// ABOUTME: Shared by the local HTTP server ZCode talks to; the server owns transport, ids, and error routing.

import { formatErrorMessage } from "../errors.js";
import type { BridgeStreamEvent, BridgeUsage } from "../types.js";

export interface AnthropicStreamOptions {
  model: string;
  /** The `message.id` both the streaming and non-streaming response carry. */
  messageId: string;
  /**
   * Input tokens the server counted for the request. Seeds `message_start` and
   * stands in when a core reports no usage of its own.
   */
  inputTokensHint?: number;
}

type AnthropicBlockStart =
  | { type: "text"; text: "" }
  | { type: "thinking"; thinking: "" }
  | { type: "tool_use"; id: string; name: string; input: Record<string, never> };

type AnthropicBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };

/**
 * The SSE-visible block lifecycle after neutral→Anthropic index mapping, shared
 * by the streaming and non-streaming shapes so both see the same block order,
 * synthesized starts, and delta bookkeeping. `stop` carries a tool block's
 * final parsed arguments; only the collected message reads them, because the
 * SSE client assembles `input` from the deltas it was sent.
 */
type WireEvent =
  | { kind: "start"; index: number; block: AnthropicBlockStart }
  | { kind: "delta"; index: number; delta: AnthropicBlockDelta }
  | { kind: "stop"; index: number; toolArguments?: Record<string, unknown> }
  | { kind: "usage"; usage: BridgeUsage }
  | { kind: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" }
  | { kind: "error"; message: string };

const STOP_REASONS: Record<"stop" | "toolUse" | "length", "end_turn" | "tool_use" | "max_tokens"> = {
  stop: "end_turn",
  toolUse: "tool_use",
  length: "max_tokens",
};

/** The model's raw argument JSON when the core kept it, re-serialized otherwise. */
function toolArgumentsJson(event: Extract<BridgeStreamEvent, { type: "tool_call_end" }>): string {
  return event.argumentsJson?.trim() ? event.argumentsJson : JSON.stringify(event.arguments);
}

/**
 * Render neutral core events as wire events. Never throws: a core failure
 * closes the open blocks and ends with an `error` event instead.
 */
async function* toWireEvents(events: AsyncIterable<BridgeStreamEvent>): AsyncGenerator<WireEvent> {
  // Neutral indexes are monotonic but not contiguous; Anthropic's count block
  // starts from 0, so every block is translated rather than passed through.
  const indexes = new Map<number, number>();
  const deltaSeen = new Set<number>();
  let next = 0;
  let finished = false;

  // A block can end without a clean start (the core's first event may be its
  // end); synthesize one so the client's stream stays valid.
  function* ensureStart(coreIndex: number, block: AnthropicBlockStart): Generator<WireEvent, number> {
    const started = indexes.get(coreIndex);
    if (started !== undefined) return started;
    const index = next++;
    indexes.set(coreIndex, index);
    yield { kind: "start", index, block };
    return index;
  }

  function* closeOpen(): Generator<WireEvent> {
    for (const index of indexes.values()) yield { kind: "stop", index };
    indexes.clear();
  }

  try {
    for await (const event of events) {
      switch (event.type) {
        case "text_start": {
          yield* ensureStart(event.index, { type: "text", text: "" });
          break;
        }
        case "text_delta": {
          const index = indexes.get(event.index);
          if (index === undefined) break;
          deltaSeen.add(event.index);
          yield { kind: "delta", index, delta: { type: "text_delta", text: event.delta } };
          break;
        }
        case "text_end": {
          const index = yield* ensureStart(event.index, { type: "text", text: "" });
          // The client only has what the deltas said; a block whose content
          // never streamed goes out whole in one delta.
          if (!deltaSeen.has(event.index)) {
            deltaSeen.add(event.index);
            yield { kind: "delta", index, delta: { type: "text_delta", text: event.text } };
          }
          indexes.delete(event.index);
          yield { kind: "stop", index };
          break;
        }
        case "thinking_start": {
          yield* ensureStart(event.index, { type: "thinking", thinking: "" });
          break;
        }
        case "thinking_delta": {
          const index = indexes.get(event.index);
          if (index === undefined) break;
          deltaSeen.add(event.index);
          yield { kind: "delta", index, delta: { type: "thinking_delta", thinking: event.delta } };
          break;
        }
        case "thinking_end": {
          const index = yield* ensureStart(event.index, { type: "thinking", thinking: "" });
          if (!deltaSeen.has(event.index)) {
            deltaSeen.add(event.index);
            yield { kind: "delta", index, delta: { type: "thinking_delta", thinking: event.thinking } };
          }
          // The signature only exists on the terminal event.
          if (event.signature) {
            yield { kind: "delta", index, delta: { type: "signature_delta", signature: event.signature } };
          }
          indexes.delete(event.index);
          yield { kind: "stop", index };
          break;
        }
        case "tool_call_start": {
          yield* ensureStart(event.index, { type: "tool_use", id: event.id, name: event.name, input: {} });
          break;
        }
        case "tool_call_delta": {
          const index = indexes.get(event.index);
          if (index === undefined) break;
          deltaSeen.add(event.index);
          yield { kind: "delta", index, delta: { type: "input_json_delta", partial_json: event.argumentsDelta } };
          break;
        }
        case "tool_call_end": {
          const index = yield* ensureStart(event.index, {
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: {},
          });
          if (!deltaSeen.has(event.index)) {
            deltaSeen.add(event.index);
            yield {
              kind: "delta",
              index,
              delta: { type: "input_json_delta", partial_json: toolArgumentsJson(event) },
            };
          }
          indexes.delete(event.index);
          yield { kind: "stop", index, toolArguments: event.arguments };
          break;
        }
        case "usage":
          yield { kind: "usage", usage: event.usage };
          break;
        case "done":
          finished = true;
          yield* closeOpen();
          yield { kind: "done", stopReason: STOP_REASONS[event.stopReason] };
          break;
        // `start` needs no frame: message_start went out before the first event.
        // `reset` is ignored: indexes are monotonic, so the blocks a retry emits
        // simply become new Anthropic blocks.
      }
    }
    if (!finished) {
      yield* closeOpen();
      yield { kind: "done", stopReason: "end_turn" };
    }
  } catch (error) {
    yield* closeOpen();
    yield { kind: "error", message: formatErrorMessage(error) };
  }
}

function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Anthropic counts only uncached input in `input_tokens`; BridgeUsage.input
 * already excludes cache reads and writes.
 */
function anthropicUsage(usage: BridgeUsage | undefined, inputHint: number | undefined): Record<string, number> {
  return {
    input_tokens: usage?.input ?? inputHint ?? 0,
    output_tokens: usage?.output ?? 0,
    ...(usage?.cacheRead !== undefined ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(usage?.cacheWrite !== undefined ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
  };
}

/** The full Anthropic Messages response as SSE frames. Never throws; a core failure becomes an `error` frame. */
export async function* toAnthropicSse(
  events: AsyncIterable<BridgeStreamEvent>,
  options: AnthropicStreamOptions,
): AsyncGenerator<string> {
  yield frame("message_start", {
    type: "message_start",
    message: {
      id: options.messageId,
      type: "message",
      role: "assistant",
      model: options.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: options.inputTokensHint ?? 0, output_tokens: 0 },
    },
  });
  let usage: BridgeUsage | undefined;
  for await (const wire of toWireEvents(events)) {
    switch (wire.kind) {
      case "start":
        yield frame("content_block_start", {
          type: "content_block_start",
          index: wire.index,
          content_block: wire.block,
        });
        break;
      case "delta":
        yield frame("content_block_delta", { type: "content_block_delta", index: wire.index, delta: wire.delta });
        break;
      case "stop":
        yield frame("content_block_stop", { type: "content_block_stop", index: wire.index });
        break;
      case "usage":
        usage = wire.usage;
        break;
      case "done":
        yield frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: wire.stopReason, stop_sequence: null },
          usage: anthropicUsage(usage, options.inputTokensHint),
        });
        yield frame("message_stop", { type: "message_stop" });
        break;
      case "error":
        yield frame("error", { type: "error", error: { type: "api_error", message: wire.message } });
        return;
    }
  }
}

type AnthropicResponseBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * The full Anthropic Messages response assembled from the same block stream the
 * SSE shape renders, for the non-streaming endpoint. Unlike
 * {@link toAnthropicSse} a core failure throws.
 */
export async function collectAnthropicMessage(
  events: AsyncIterable<BridgeStreamEvent>,
  options: AnthropicStreamOptions,
): Promise<object> {
  const content: AnthropicResponseBlock[] = [];
  const positions = new Map<number, number>();
  let usage: BridgeUsage | undefined;
  let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

  for await (const wire of toWireEvents(events)) {
    switch (wire.kind) {
      case "start": {
        const block: AnthropicResponseBlock =
          wire.block.type === "tool_use"
            ? { type: "tool_use", id: wire.block.id, name: wire.block.name, input: {} }
            : wire.block.type === "thinking"
              ? { type: "thinking", thinking: "" }
              : { type: "text", text: "" };
        positions.set(wire.index, content.length);
        content.push(block);
        break;
      }
      case "delta": {
        const at = positions.get(wire.index);
        if (at === undefined) break;
        const block = content[at];
        if (wire.delta.type === "text_delta" && block.type === "text") block.text += wire.delta.text;
        else if (wire.delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += wire.delta.thinking;
        } else if (wire.delta.type === "signature_delta" && block.type === "thinking") {
          block.signature = wire.delta.signature;
        }
        // input_json_delta is skipped: the stop event carries the parsed arguments.
        break;
      }
      case "stop": {
        const at = positions.get(wire.index);
        if (at === undefined) break;
        const block = content[at];
        if (wire.toolArguments && block.type === "tool_use") block.input = wire.toolArguments;
        positions.delete(wire.index);
        break;
      }
      case "usage":
        usage = wire.usage;
        break;
      case "done":
        stopReason = wire.stopReason;
        break;
      case "error":
        throw new Error(wire.message);
    }
  }

  return {
    id: options.messageId,
    type: "message",
    role: "assistant",
    model: options.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage(usage, options.inputTokensHint),
  };
}

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  404: "not_found_error",
  429: "rate_limit_error",
  529: "overloaded_error",
};

/** The JSON an error response carries, with the Anthropic error type for the status. */
export function anthropicError(
  status: number,
  message: string,
  type?: string,
): { status: number; body: { type: "error"; error: { type: string; message: string } } } {
  return {
    status,
    body: { type: "error", error: { type: type ?? ERROR_TYPES[status] ?? "api_error", message } },
  };
}
