// ABOUTME: Parses Arnict's OpenAI chat-completions SSE into neutral stream events.
// ABOUTME: Tool calls are reported, never executed. Usage closes the ledger with published rates.

import { arnictModelSpec } from "./catalog.js";
import { ArnictApiError } from "./errors.js";
import type { ArnictStreamEvent } from "./types.js";
import { type ArnictWireUsage, toArnictUsage } from "./usage.js";

export interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface WireChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: WireToolCallDelta[];
  };
  message?: {
    content?: string | null;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
}

export interface WireChatChunk {
  id?: string;
  model?: string;
  choices?: WireChoice[];
  usage?: ArnictWireUsage;
}

export interface WireChatCompletion {
  id?: string;
  model?: string;
  choices?: WireChoice[];
  usage?: ArnictWireUsage;
}

interface OpenBlock {
  kind: "thinking" | "text" | "tool";
  index: number;
  id: string;
  name: string;
  text: string;
  closed: boolean;
}

export interface ChatReduceState {
  requestedModel: string;
  nextIndex: number;
  started: boolean;
  settled: boolean;
  sawTool: boolean;
  sawFinishReason: boolean;
  stopReason: "stop" | "toolUse" | "length";
  responseId?: string;
  upstreamModel?: string;
  usage?: ArnictWireUsage;
  openText?: OpenBlock;
  openThinking?: OpenBlock;
  tools: Map<number, OpenBlock>;
}

export function createChatState(requestedModel: string): ChatReduceState {
  return {
    requestedModel,
    nextIndex: 0,
    started: false,
    settled: false,
    sawTool: false,
    sawFinishReason: false,
    stopReason: "stop",
    tools: new Map(),
  };
}

function ensureStart(state: ChatReduceState, events: ArnictStreamEvent[]): void {
  if (state.started) return;
  state.started = true;
  events.push({ type: "start" });
}

function closeBlock(block: OpenBlock): ArnictStreamEvent | undefined {
  if (block.closed) return undefined;
  block.closed = true;
  if (block.kind === "thinking") return { type: "thinking_end", index: block.index, thinking: block.text };
  if (block.kind === "text") return { type: "text_end", index: block.index, text: block.text };
  const argumentsJson = block.text.trim() ? block.text : "{}";
  let arguments_: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      arguments_ = parsed as Record<string, unknown>;
    }
  } catch {
    // The host keeps the raw JSON and shows the model an empty argument object.
  }
  return {
    type: "tool_call_end",
    index: block.index,
    id: block.id,
    name: block.name,
    arguments: arguments_,
    argumentsJson,
  };
}

function closeTextAndThinking(state: ChatReduceState, events: ArnictStreamEvent[]): void {
  for (const block of [state.openText, state.openThinking]) {
    if (!block) continue;
    const event = closeBlock(block);
    if (event) events.push(event);
  }
}

function closeTools(state: ChatReduceState, events: ArnictStreamEvent[]): void {
  const ordered = [...state.tools.entries()].sort((left, right) => left[0] - right[0]);
  for (const [, block] of ordered) {
    const event = closeBlock(block);
    if (event) events.push(event);
  }
}

function mapFinishReason(reason: string): "stop" | "toolUse" | "length" {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  return "stop";
}

function toolCallEvents(state: ChatReduceState, calls: WireToolCallDelta[]): ArnictStreamEvent[] {
  const events: ArnictStreamEvent[] = [];
  calls.forEach((call, position) => {
    const key = typeof call.index === "number" ? call.index : position;
    let block = state.tools.get(key);
    if (!block) {
      closeTextAndThinking(state, events);
      block = {
        kind: "tool",
        index: state.nextIndex,
        id: call.id ?? "",
        name: call.function?.name ?? "",
        text: "",
        closed: false,
      };
      state.nextIndex += 1;
      state.tools.set(key, block);
      state.sawTool = true;
      ensureStart(state, events);
      events.push({ type: "tool_call_start", index: block.index, id: block.id, name: block.name });
    } else {
      if (call.id) block.id = call.id;
      if (call.function?.name) block.name = call.function.name;
    }
    const delta = call.function?.arguments;
    if (delta) {
      block.text += delta;
      events.push({ type: "tool_call_delta", index: block.index, id: block.id, argumentsDelta: delta });
    }
  });
  return events;
}

/** Fold one chat-completions chunk into zero or more neutral events. */
export function reduceChatChunk(state: ChatReduceState, chunk: WireChatChunk): ArnictStreamEvent[] {
  if (state.settled) return [];
  const events: ArnictStreamEvent[] = [];
  if (chunk.id) state.responseId = chunk.id;
  if (chunk.model) state.upstreamModel = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return events;
  const delta = choice.delta ?? {};
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (reasoning) {
    if (!state.openThinking || state.openThinking.closed) {
      closeTextAndThinking(state, events);
      state.openThinking = {
        kind: "thinking",
        index: state.nextIndex,
        id: "",
        name: "",
        text: "",
        closed: false,
      };
      state.nextIndex += 1;
      ensureStart(state, events);
      events.push({ type: "thinking_start", index: state.openThinking.index });
    }
    state.openThinking.text += reasoning;
    events.push({ type: "thinking_delta", index: state.openThinking.index, delta: reasoning });
  }
  if (delta.content) {
    if (!state.openText || state.openText.closed) {
      closeTextAndThinking(state, events);
      state.openText = { kind: "text", index: state.nextIndex, id: "", name: "", text: "", closed: false };
      state.nextIndex += 1;
      ensureStart(state, events);
      events.push({ type: "text_start", index: state.openText.index });
    }
    state.openText.text += delta.content;
    events.push({ type: "text_delta", index: state.openText.index, delta: delta.content });
  }
  if (delta.tool_calls && delta.tool_calls.length > 0) events.push(...toolCallEvents(state, delta.tool_calls));
  if (choice.finish_reason) {
    state.sawFinishReason = true;
    state.stopReason = mapFinishReason(choice.finish_reason);
    closeTextAndThinking(state, events);
    closeTools(state, events);
  }
  return events;
}

/**
 * Close the stream out. `[DONE]` never reaches the reducer, so `sawFinishReason`
 * is the reliable marker of a complete stream; without it the upstream ended early.
 */
export function finishChat(state: ChatReduceState): ArnictStreamEvent[] {
  if (state.settled) return [];
  state.settled = true;
  const events: ArnictStreamEvent[] = [];
  closeTextAndThinking(state, events);
  closeTools(state, events);
  if (state.sawTool) state.stopReason = "toolUse";
  if (state.usage) {
    events.push({
      type: "usage",
      usage: toArnictUsage(state.usage, arnictModelSpec(state.requestedModel).rates),
    });
  }
  events.push({
    type: "done",
    stopReason: state.stopReason,
    ...(state.sawFinishReason ? {} : { errorMessage: "Arnict stream ended early" }),
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.upstreamModel ? { upstreamModel: state.upstreamModel } : {}),
  });
  return events;
}

/** A non-stream completion, expressed as the chunks the reducer already understands. */
export function chatCompletionChunks(completion: WireChatCompletion): WireChatChunk[] {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  const content = message?.content ?? "";
  const toolCalls: WireToolCallDelta[] = (message?.tool_calls ?? []).map((call, index) => ({
    index,
    id: call.id,
    type: call.type,
    function: { name: call.function?.name, arguments: call.function?.arguments ?? "" },
  }));
  return [
    {
      id: completion.id,
      model: completion.model,
      choices: [
        {
          delta: {
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(content ? { content } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
    },
    {
      id: completion.id,
      model: completion.model,
      choices: [{ delta: {}, finish_reason: choice?.finish_reason ?? "stop" }],
      usage: completion.usage,
    },
  ];
}

function sseData(frame: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice("data:".length).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}

/**
 * Read one SSE body. `data: [DONE]` ends the stream. Comment, blank, and
 * `event:` lines are skipped; a data line that is not JSON is an API error.
 */
export async function* parseSseData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<WireChatChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = function* (frame: string): Generator<WireChatChunk> {
    const data = sseData(frame);
    if (data === undefined || data.trim() === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new ArnictApiError("Arnict chat stream was not JSON");
    }
    if (parsed && typeof parsed === "object") yield parsed as WireChatChunk;
  };
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = sseData(frame);
      if (data !== undefined && data.trim() === "[DONE]") return;
      yield* emit(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = sseData(buffer);
    if (data !== undefined && data.trim() === "[DONE]") return;
    yield* emit(buffer);
  }
}
