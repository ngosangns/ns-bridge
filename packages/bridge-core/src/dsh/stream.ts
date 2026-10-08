// ABOUTME: Drives a vendor core's neutral event stream into DeepSeek Harness stream chunks.
// ABOUTME: Shared by every dsh-llm-* adapter; vendor-specific error routing stays in the adapter.

import type { StreamChunk, TokenUsage, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { BridgeStreamEvent, BridgeUsage } from "../types.js";

/**
 * Project one core usage record onto the harness token buckets.
 *
 * The session pill treats a missing `cacheReadTokens` as zero, and a turn
 * drops its cache sum unless every step reported both cache fields — and the
 * fields have to add up to `totalTokens` or the harness discards the sample.
 * A vendor that reports no cache counters therefore gets zeros (a cold
 * prefix), and a later step may carry the core's repeated-prefix estimate.
 */
export function toDshUsage(usage: BridgeUsage): TokenUsage {
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

/**
 * Tool-call arguments as the Harness should store them. The Harness keeps the
 * model's raw JSON and reports invalid arguments back to the model, so a core
 * that kept the raw text (Devin) passes it through; re-serializing a parsed
 * preview would run a truncated call with auto-closed arguments. A core that
 * only exposes parsed arguments (Kiro) is serialized.
 */
function toolArguments(event: Extract<BridgeStreamEvent, { type: "tool_call_end" }>): string {
  if (event.argumentsJson !== undefined) return event.argumentsJson.trim() ? event.argumentsJson : "{}";
  return JSON.stringify(event.arguments);
}

/** Translate neutral core events into Harness stream chunks. */
export async function* streamToDsh(events: AsyncIterable<BridgeStreamEvent>): AsyncIterable<StreamChunk> {
  const openBlocks = new Set<number>();
  for await (const event of events) {
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
          block: { type: "tool-call", id: event.id as ToolCallId, name: event.name, arguments: toolArguments(event) },
        };
        break;
      case "usage":
        yield { type: "usage", usage: toDshUsage(event.usage) };
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
      // `start` needs no chunk. `reset` can arrive on a mid-stream-error retry;
      // the Harness cannot un-deliver a block, so the marker is ignored and the
      // retried attempt continues on fresh indexes.
    }
  }

  // A block the core opened but never closed would leave the assembler waiting
  // for content that is not coming. Close them rather than trust the core.
  for (const index of openBlocks) {
    yield { type: "block-end", index, block: { type: "text", text: "" } };
  }
}
