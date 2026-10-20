// ABOUTME: Parses cli-chat-proxy Server-Sent Events into neutral stream events.
// ABOUTME: Tool calls are reported, never executed. Thinking is the summary text the host card shows.

import type { BridgeStreamEvent } from "ns-bridge-core";
import { GrokApiError } from "./errors.js";
import { type GrokWireUsage, toBridgeUsage } from "./usage.js";

interface WireItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: Array<{ text?: string }>;
  content?: Array<{ type?: string; text?: string }>;
}

interface WireResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: GrokWireUsage;
  output?: WireItem[];
  error?: { message?: string } | string;
}

export interface WireEvent {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  name?: string;
  item_id?: string;
  output_index?: number;
  item?: WireItem;
  response?: WireResponse;
  error?: { message?: string } | string;
}

interface OpenBlock {
  kind: "thinking" | "text" | "tool";
  index: number;
  id: string;
  name: string;
  text: string;
  closed: boolean;
}

export interface ResponsesReduceState {
  nextIndex: number;
  started: boolean;
  settled: boolean;
  sawTool: boolean;
  stopReason: "stop" | "toolUse" | "length";
  responseId?: string;
  upstreamModel?: string;
  requestedModel?: string;
  usage?: GrokWireUsage;
  blocks: Map<string, OpenBlock>;
}

export function createResponsesState(requestedModel?: string): ResponsesReduceState {
  return {
    nextIndex: 0,
    started: false,
    settled: false,
    sawTool: false,
    stopReason: "stop",
    blocks: new Map(),
    ...(requestedModel ? { requestedModel } : {}),
  };
}

function summaryText(item: WireItem | undefined): string {
  return (item?.summary ?? []).map((part) => part.text ?? "").join("");
}

function messageText(item: WireItem | undefined): string {
  return (item?.content ?? [])
    .filter((part) => !part.type || part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

function errorText(error: WireEvent["error"] | WireResponse["error"]): string {
  if (!error) return "Grok responses error";
  if (typeof error === "string") return error.slice(0, 300);
  return (error.message ?? "Grok responses error").slice(0, 300);
}

function parseToolArguments(raw: string): { arguments: Record<string, unknown>; argumentsJson: string } {
  const argumentsJson = raw.trim() ? raw : "{}";
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { arguments: parsed as Record<string, unknown>, argumentsJson };
    }
  } catch {
    // The host keeps the raw JSON and shows the model an empty argument object.
  }
  return { arguments: {}, argumentsJson };
}

function remember(state: ResponsesReduceState, block: OpenBlock, keys: Array<string | number | undefined>): void {
  for (const key of keys) {
    if (key === undefined || key === "") continue;
    state.blocks.set(String(key), block);
  }
}

function lookup(state: ResponsesReduceState, event: WireEvent): OpenBlock | undefined {
  const keys = [
    event.item_id,
    event.item?.id,
    event.output_index === undefined ? undefined : `out:${event.output_index}`,
  ];
  for (const key of keys) {
    if (key === undefined) continue;
    const block = state.blocks.get(String(key));
    if (block) return block;
  }
  return undefined;
}

function ensureStart(state: ResponsesReduceState): BridgeStreamEvent[] {
  if (state.started) return [];
  state.started = true;
  return [{ type: "start" }];
}

function openBlock(
  state: ResponsesReduceState,
  kind: OpenBlock["kind"],
  event: WireEvent,
  extra: { id?: string; name?: string } = {},
): { block: OpenBlock; events: BridgeStreamEvent[] } {
  const existing = lookup(state, event);
  if (existing && existing.kind === kind) return { block: existing, events: ensureStart(state) };
  const item = event.item;
  const block: OpenBlock = {
    kind,
    index: state.nextIndex,
    id: extra.id ?? item?.call_id ?? item?.id ?? event.item_id ?? `block-${state.nextIndex}`,
    name: extra.name ?? item?.name ?? event.name ?? "",
    text: "",
    closed: false,
  };
  state.nextIndex += 1;
  remember(state, block, [
    item?.id,
    event.item_id,
    block.id,
    event.output_index === undefined ? undefined : `out:${event.output_index}`,
  ]);
  const events = ensureStart(state);
  if (kind === "thinking") events.push({ type: "thinking_start", index: block.index });
  else if (kind === "text") events.push({ type: "text_start", index: block.index });
  else {
    state.sawTool = true;
    events.push({ type: "tool_call_start", index: block.index, id: block.id, name: block.name });
  }
  return { block, events };
}

function closeBlock(block: OpenBlock, full?: string): BridgeStreamEvent[] {
  if (block.closed) return [];
  block.closed = true;
  const text = block.text || full || "";
  if (block.kind === "thinking") return [{ type: "thinking_end", index: block.index, thinking: text }];
  if (block.kind === "text") return [{ type: "text_end", index: block.index, text }];
  const parsed = parseToolArguments(text);
  return [
    {
      type: "tool_call_end",
      index: block.index,
      id: block.id,
      name: block.name,
      arguments: parsed.arguments,
      argumentsJson: parsed.argumentsJson,
    },
  ];
}

function closeOpen(state: ResponsesReduceState): BridgeStreamEvent[] {
  const seen = new Set<OpenBlock>();
  const events: BridgeStreamEvent[] = [];
  const blocks = [...state.blocks.values()].sort((left, right) => left.index - right.index);
  for (const block of blocks) {
    if (seen.has(block)) continue;
    seen.add(block);
    events.push(...closeBlock(block));
  }
  return events;
}

function applyStop(state: ResponsesReduceState, response: WireResponse | undefined): void {
  if (state.sawTool) {
    state.stopReason = "toolUse";
    return;
  }
  const reason = response?.incomplete_details?.reason;
  if (response?.status === "incomplete" && reason === "max_output_tokens") state.stopReason = "length";
}

function settle(state: ResponsesReduceState, response: WireResponse | undefined): BridgeStreamEvent[] {
  if (state.settled) return [];
  state.settled = true;
  if (response?.id) state.responseId = response.id;
  if (response?.model && state.requestedModel && response.model !== state.requestedModel) {
    state.upstreamModel = response.model;
  }
  if (response?.usage) state.usage = response.usage;
  applyStop(state, response);
  const events = [...ensureStart(state), ...closeOpen(state)];
  if (state.usage) events.push({ type: "usage", usage: toBridgeUsage(state.usage) });
  events.push({
    type: "done",
    stopReason: state.stopReason,
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.upstreamModel ? { upstreamModel: state.upstreamModel } : {}),
  });
  return events;
}

function fillFromItem(block: OpenBlock, item: WireItem | undefined): void {
  if (!item || block.text) return;
  if (block.kind === "thinking") block.text = summaryText(item);
  else if (block.kind === "text") block.text = messageText(item);
  else if (item.arguments) block.text = item.arguments;
  if (item.name && block.kind === "tool" && !block.name) block.name = item.name;
}

/** Fold one proxy event into zero or more neutral events. Throws on a terminal proxy error. */
export function reduceResponsesEvent(state: ResponsesReduceState, event: WireEvent): BridgeStreamEvent[] {
  if (state.settled) return [];
  const type = event.type;
  if (type === "error" || type === "response.failed")
    throw new GrokApiError(errorText(event.error ?? event.response?.error));
  if (event.response?.id) state.responseId = event.response.id;

  if (type === "response.created" || type === "response.in_progress") return ensureStart(state);

  if (type === "response.output_item.added") {
    const item = event.item;
    if (item?.type === "reasoning") return openBlock(state, "thinking", event).events;
    if (item?.type === "function_call") {
      const opened = openBlock(state, "tool", event, { id: item.call_id ?? item.id, name: item.name });
      if (item.arguments && !opened.block.closed && !opened.block.text) {
        opened.block.text = item.arguments;
        opened.events.push({
          type: "tool_call_delta",
          index: opened.block.index,
          id: opened.block.id,
          argumentsDelta: item.arguments,
        });
      }
      return opened.events;
    }
    if (item?.type === "message" || item?.type === undefined) return openBlock(state, "text", event).events;
    return ensureStart(state);
  }

  if (type === "response.reasoning_summary_text.delta") {
    const opened = openBlock(state, "thinking", event);
    const delta = event.delta ?? "";
    opened.block.text += delta;
    if (delta) opened.events.push({ type: "thinking_delta", index: opened.block.index, delta });
    return opened.events;
  }

  if (type === "response.output_text.delta") {
    const opened = openBlock(state, "text", event);
    const delta = event.delta ?? event.text ?? "";
    opened.block.text += delta;
    if (delta) opened.events.push({ type: "text_delta", index: opened.block.index, delta });
    return opened.events;
  }

  if (type === "response.function_call_arguments.delta") {
    const opened = openBlock(state, "tool", event, { id: event.item_id, name: event.name });
    const delta = event.delta ?? "";
    opened.block.text += delta;
    if (delta) {
      opened.events.push({
        type: "tool_call_delta",
        index: opened.block.index,
        id: opened.block.id,
        argumentsDelta: delta,
      });
    }
    return opened.events;
  }

  if (type === "response.function_call_arguments.done") {
    const opened = openBlock(state, "tool", event, { id: event.item_id, name: event.name });
    if (event.name) opened.block.name = event.name;
    const full = event.arguments ?? opened.block.text;
    opened.block.text = full;
    return [...opened.events, ...closeBlock(opened.block, full)];
  }

  if (type === "response.reasoning_summary_text.done" || type === "response.output_text.done") {
    const kind = type === "response.output_text.done" ? "text" : "thinking";
    const opened = openBlock(state, kind, event);
    if (!opened.block.text && event.text) opened.block.text = event.text;
    return opened.events;
  }

  if (type === "response.output_item.done") {
    const item = event.item;
    const kind = item?.type === "reasoning" ? "thinking" : item?.type === "function_call" ? "tool" : "text";
    if (
      item?.type !== "reasoning" &&
      item?.type !== "function_call" &&
      item?.type !== "message" &&
      item?.type !== undefined
    ) {
      return [];
    }
    const opened = openBlock(state, kind, event, {
      id: item?.call_id ?? item?.id,
      name: item?.name,
    });
    fillFromItem(opened.block, item);
    if (item?.name && opened.block.kind === "tool") opened.block.name = item.name;
    return [...opened.events, ...closeBlock(opened.block)];
  }

  if (type === "response.completed" || type === "response.incomplete") {
    if (event.response?.status === "failed") throw new GrokApiError(errorText(event.response.error));
    const prelude = state.blocks.size === 0 ? absorbOutput(state, event.response?.output ?? []) : [];
    return [...prelude, ...settle(state, event.response)];
  }

  return [];
}

function absorbOutput(state: ResponsesReduceState, output: readonly WireItem[]): BridgeStreamEvent[] {
  const events: BridgeStreamEvent[] = [];
  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    if (!item) continue;
    events.push(...reduceResponsesEvent(state, { type: "response.output_item.added", output_index: index, item }));
    if (item.type === "reasoning") {
      const text = summaryText(item);
      if (text) {
        events.push(
          ...reduceResponsesEvent(state, {
            type: "response.reasoning_summary_text.delta",
            item_id: item.id,
            output_index: index,
            delta: text,
          }),
        );
      }
    } else if (item.type === "message") {
      const text = messageText(item);
      if (text) {
        events.push(
          ...reduceResponsesEvent(state, {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: index,
            delta: text,
          }),
        );
      }
    } else if (item.type === "function_call" && item.arguments) {
      events.push(
        ...reduceResponsesEvent(state, {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: index,
          name: item.name,
          arguments: item.arguments,
        }),
      );
    }
    events.push(...reduceResponsesEvent(state, { type: "response.output_item.done", output_index: index, item }));
  }
  return events;
}

export function finishResponses(state: ResponsesReduceState): BridgeStreamEvent[] {
  return settle(state, undefined);
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

/** Read one SSE body. `data: [DONE]` ends the stream. Malformed JSON is a proxy error. */
export async function* parseSseJson(body: AsyncIterable<Uint8Array>): AsyncGenerator<WireEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = function* (frame: string): Generator<WireEvent> {
    const data = sseData(frame);
    if (data === undefined || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object") yield parsed as WireEvent;
    } catch {
      throw new GrokApiError("Grok responses stream was not JSON");
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) yield* emit(frame);
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* emit(buffer);
}
