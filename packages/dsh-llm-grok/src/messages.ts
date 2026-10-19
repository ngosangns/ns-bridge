/**
 * Map one `streaming-messages-json` line (Anthropic Messages NDJSON) onto
 * harness stream chunks. No process is spawned here.
 */

import { type StreamChunk, ToolCallId } from "@deepseek-ai/dsh-llm";

interface OpenBlock {
  index: number;
  kind: "text" | "reasoning" | "tool-call";
  text: string;
  id: string;
  name: string;
  /** Tool input present on the start event, used when no JSON delta arrives. */
  startInput?: string;
}

export interface MessagesParseState {
  blocks: Map<number, OpenBlock>;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** A streaming block already opened, so the later whole assistant message must not repeat it. */
  sawStreamBlocks: boolean;
  /** Text, reasoning, or a tool call was emitted from a whole assistant message. */
  emittedContent: boolean;
  finished: boolean;
}

export function createMessagesParseState(): MessagesParseState {
  return { blocks: new Map(), sawStreamBlocks: false, emittedContent: false, finished: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function finishReasonFromStop(stop: string | undefined): StreamChunk {
  const reason =
    stop === "tool_use"
      ? { kind: "tool-calls" as const }
      : stop === "max_tokens"
        ? { kind: "max-tokens" as const }
        : { kind: "stop" as const };
  return { type: "finish", reason };
}

function blockEnd(block: OpenBlock): StreamChunk {
  if (block.kind === "tool-call") {
    return {
      type: "block-end",
      index: block.index,
      block: {
        type: "tool-call",
        id: ToolCallId(block.id || `grok-tool-${block.index}`),
        name: block.name || "tool",
        arguments: block.text || block.startInput || "{}",
      },
    };
  }
  if (block.kind === "reasoning") {
    return { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } };
  }
  return { type: "block-end", index: block.index, block: { type: "text", text: block.text } };
}

export function finishMessagesParse(state: MessagesParseState): StreamChunk[] {
  if (state.finished) return [];
  state.finished = true;
  const chunks: StreamChunk[] = [];
  for (const block of [...state.blocks.values()].sort((left, right) => left.index - right.index)) {
    chunks.push(blockEnd(block));
  }
  state.blocks.clear();
  if (
    state.inputTokens !== undefined ||
    state.outputTokens !== undefined ||
    state.cacheReadTokens !== undefined ||
    state.cacheWriteTokens !== undefined
  ) {
    chunks.push({
      type: "usage",
      usage: {
        inputTokens: state.inputTokens ?? 0,
        outputTokens: state.outputTokens ?? 0,
        ...(state.cacheReadTokens !== undefined ? { cacheReadTokens: state.cacheReadTokens } : {}),
        ...(state.cacheWriteTokens !== undefined ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
      },
    });
  }
  chunks.push(finishReasonFromStop(state.stopReason));
  return chunks;
}

function rememberUsage(state: MessagesParseState, usage: Record<string, unknown> | undefined): void {
  const input = numberField(usage, "input_tokens");
  const output = numberField(usage, "output_tokens");
  const cacheRead = numberField(usage, "cache_read_input_tokens");
  const cacheWrite = numberField(usage, "cache_creation_input_tokens");
  if (input !== undefined) state.inputTokens = input;
  if (output !== undefined) state.outputTokens = output;
  if (cacheRead !== undefined) state.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) state.cacheWriteTokens = cacheWrite;
}

function rememberStop(state: MessagesParseState, stop: unknown): void {
  if (typeof stop === "string" && stop.length > 0) state.stopReason = stop;
}

/** Emit one finished Anthropic content block. Used for a whole assistant message. */
function emitWholeBlock(record: Record<string, unknown>, index: number): StreamChunk[] {
  const block = openBlock(record, index);
  if (!block) return [];
  const chunks: StreamChunk[] = [];
  const blockType = block.kind === "tool-call" ? "tool-call" : block.kind;
  chunks.push({ type: "block-start", index, blockType });
  if (block.kind === "text" && block.text) chunks.push({ type: "text-delta", index, text: block.text });
  if (block.kind === "reasoning" && block.text) chunks.push({ type: "reasoning-delta", index, text: block.text });
  if (block.kind === "tool-call") {
    const args = block.text || block.startInput || "{}";
    block.text = args;
    chunks.push({
      type: "tool-call-delta",
      index,
      id: ToolCallId(block.id || `grok-tool-${index}`),
      name: block.name || undefined,
      argumentsDelta: args,
    });
  }
  chunks.push(blockEnd(block));
  return chunks;
}

function emitAssistantMessage(message: Record<string, unknown> | undefined, state: MessagesParseState): StreamChunk[] {
  if (!message || state.finished) return [];
  rememberUsage(state, asRecord(message.usage));
  rememberStop(state, message.stop_reason);
  if (state.sawStreamBlocks || state.emittedContent) return [];
  const content = Array.isArray(message.content) ? message.content : [];
  const chunks: StreamChunk[] = [];
  let index = 0;
  for (const entry of content) {
    const record = asRecord(entry);
    if (!record) continue;
    const blockChunks = emitWholeBlock(record, index);
    if (blockChunks.length === 0) continue;
    state.emittedContent = true;
    chunks.push(...blockChunks);
    index += 1;
  }
  return chunks;
}

function openBlock(content: Record<string, unknown>, index: number): OpenBlock | undefined {
  const type = content.type;
  if (type === "text") {
    return { index, kind: "text", text: typeof content.text === "string" ? content.text : "", id: "", name: "" };
  }
  if (type === "thinking" || type === "reasoning") {
    const text =
      typeof content.thinking === "string" ? content.thinking : typeof content.text === "string" ? content.text : "";
    return { index, kind: "reasoning", text, id: "", name: "" };
  }
  if (type === "tool_use") {
    const input = asRecord(content.input);
    const startInput = input && Object.keys(input).length > 0 ? JSON.stringify(input) : undefined;
    return {
      index,
      kind: "tool-call",
      text: "",
      id: typeof content.id === "string" ? content.id : "",
      name: typeof content.name === "string" ? content.name : "",
      startInput,
    };
  }
  return undefined;
}

function applyDelta(block: OpenBlock, delta: Record<string, unknown>): StreamChunk | undefined {
  const type = delta.type;
  if ((type === "text_delta" || type === "text") && block.kind === "text" && typeof delta.text === "string") {
    block.text += delta.text;
    return { type: "text-delta", index: block.index, text: delta.text };
  }
  if (
    (type === "thinking_delta" || type === "reasoning_delta") &&
    block.kind === "reasoning" &&
    typeof delta.thinking === "string"
  ) {
    block.text += delta.thinking;
    return { type: "reasoning-delta", index: block.index, text: delta.thinking };
  }
  if (type === "input_json_delta" && block.kind === "tool-call" && typeof delta.partial_json === "string") {
    block.text += delta.partial_json;
    return {
      type: "tool-call-delta",
      index: block.index,
      id: ToolCallId(block.id || `grok-tool-${block.index}`),
      name: block.name || undefined,
      argumentsDelta: delta.partial_json,
    };
  }
  return undefined;
}

/** Parse one NDJSON line. Non-JSON lines are ignored. */
export function parseGrokMessagesLine(line: string, state: MessagesParseState): StreamChunk[] {
  const trimmed = line.trim();
  if (!trimmed || state.finished) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const event = asRecord(parsed);
  if (!event || typeof event.type !== "string") return [];
  return parseGrokMessagesEvent(event, state);
}

function parseGrokMessagesEvent(event: Record<string, unknown>, state: MessagesParseState): StreamChunk[] {
  if (state.finished || typeof event.type !== "string") return [];
  const chunks: StreamChunk[] = [];

  // `--include-partial-messages` wraps each Anthropic event in `stream_event`.
  if (event.type === "stream_event") {
    const inner = asRecord(event.event);
    return inner ? parseGrokMessagesEvent(inner, state) : chunks;
  }

  // Without partial messages the CLI sends one whole assistant message, then a result.
  if (event.type === "assistant") return emitAssistantMessage(asRecord(event.message), state);

  if (event.type === "result") {
    rememberUsage(state, asRecord(event.usage));
    rememberStop(state, event.stop_reason);
    if (event.is_error === true && !state.emittedContent && !state.sawStreamBlocks) {
      const message = typeof event.result === "string" && event.result.trim() ? event.result : "Grok CLI failed";
      state.finished = true;
      return [{ type: "finish", reason: { kind: "error", failure: { message, code: "GROK_CLI" } } }];
    }
    if (
      !state.emittedContent &&
      !state.sawStreamBlocks &&
      typeof event.result === "string" &&
      event.result.length > 0
    ) {
      chunks.push(...emitAssistantMessage({ content: [{ type: "text", text: event.result }] }, state));
    }
    chunks.push(...finishMessagesParse(state));
    return chunks;
  }

  if (event.type === "message_start") {
    rememberUsage(state, asRecord(asRecord(event.message)?.usage));
    return chunks;
  }

  if (event.type === "content_block_start") {
    const index = numberField(event, "index");
    const content = asRecord(event.content_block);
    if (index === undefined || !content) return chunks;
    const block = openBlock(content, index);
    if (!block) return chunks;
    state.sawStreamBlocks = true;
    state.blocks.set(index, block);
    const blockType = block.kind === "tool-call" ? "tool-call" : block.kind;
    chunks.push({ type: "block-start", index, blockType });
    if (block.kind === "text" && block.text) chunks.push({ type: "text-delta", index, text: block.text });
    if (block.kind === "reasoning" && block.text) chunks.push({ type: "reasoning-delta", index, text: block.text });
    return chunks;
  }

  if (event.type === "content_block_delta") {
    const index = numberField(event, "index");
    const delta = asRecord(event.delta);
    if (index === undefined || !delta) return chunks;
    const block = state.blocks.get(index);
    if (!block) return chunks;
    const chunk = applyDelta(block, delta);
    if (chunk) chunks.push(chunk);
    return chunks;
  }

  if (event.type === "content_block_stop") {
    const index = numberField(event, "index");
    if (index === undefined) return chunks;
    const block = state.blocks.get(index);
    if (!block) return chunks;
    state.blocks.delete(index);
    chunks.push(blockEnd(block));
    return chunks;
  }

  if (event.type === "message_delta") {
    const delta = asRecord(event.delta);
    const stop = delta?.stop_reason;
    if (typeof stop === "string" && stop.length > 0) state.stopReason = stop;
    rememberUsage(state, asRecord(event.usage));
    return chunks;
  }

  if (event.type === "message_stop") return finishMessagesParse(state);
  return chunks;
}
