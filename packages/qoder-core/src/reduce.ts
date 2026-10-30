// ABOUTME: Reduces Qoder model-server SSE chunks into neutral stream events.

import type { QoderStreamEvent, QoderUsage } from "./types.js";
import { type QoderWireUsage, toQoderUsage } from "./usage.js";

interface OpenBlock {
  index: number;
  id: string;
  name: string;
  argsJson: string;
  closed: boolean;
}

export interface WireReduceState {
  started: boolean;
  settled: boolean;
  nextIndex: number;
  openText?: OpenBlock;
  openThinking?: OpenBlock;
  tools: Map<number, OpenBlock>;
  sawTool: boolean;
  stopReason: "stop" | "toolUse" | "length";
  usage?: QoderUsage;
  responseId?: string;
  upstreamModel?: string;
}

export function createWireReduceState(): WireReduceState {
  return {
    started: false,
    settled: false,
    nextIndex: 0,
    tools: new Map(),
    sawTool: false,
    stopReason: "stop",
  };
}

function ensureStart(state: WireReduceState, events: QoderStreamEvent[]): void {
  if (!state.started) {
    state.started = true;
    events.push({ type: "start" });
  }
}

function closeText(state: WireReduceState, events: QoderStreamEvent[]): void {
  if (state.openText && !state.openText.closed) {
    state.openText.closed = true;
    events.push({ type: "text_end", index: state.openText.index, text: state.openText.argsJson });
    state.openText = undefined;
  }
}

function closeThinking(state: WireReduceState, events: QoderStreamEvent[]): void {
  if (state.openThinking && !state.openThinking.closed) {
    state.openThinking.closed = true;
    events.push({
      type: "thinking_end",
      index: state.openThinking.index,
      thinking: state.openThinking.argsJson,
    });
    state.openThinking = undefined;
  }
}

function closeTools(state: WireReduceState, events: QoderStreamEvent[]): void {
  for (const block of state.tools.values()) {
    if (block.closed) continue;
    block.closed = true;
    let args: Record<string, unknown> = {};
    try {
      args = block.argsJson ? (JSON.parse(block.argsJson) as Record<string, unknown>) : {};
    } catch {
      args = { __unparsed: block.argsJson };
    }
    events.push({
      type: "tool_call_end",
      index: block.index,
      id: block.id,
      name: block.name,
      arguments: args,
      argumentsJson: block.argsJson,
    });
  }
  state.tools.clear();
}

function mapFinishReason(raw: string | null | undefined): "stop" | "toolUse" | "length" {
  if (raw === "tool_calls" || raw === "function_call") return "toolUse";
  if (raw === "length") return "length";
  return "stop";
}

function openText(state: WireReduceState, events: QoderStreamEvent[]): OpenBlock {
  closeText(state, events);
  closeThinking(state, events);
  state.openText = { index: state.nextIndex, id: "", name: "", argsJson: "", closed: false };
  state.nextIndex += 1;
  events.push({ type: "text_start", index: state.openText.index });
  return state.openText;
}

function openThinking(state: WireReduceState, events: QoderStreamEvent[]): OpenBlock {
  closeText(state, events);
  closeThinking(state, events);
  state.openThinking = { index: state.nextIndex, id: "", name: "", argsJson: "", closed: false };
  state.nextIndex += 1;
  events.push({ type: "thinking_start", index: state.openThinking.index });
  return state.openThinking;
}

/**
 * One SSE JSON frame (`data:` payload). Unknown shapes yield no events so
 * fields the server adds later pass through silently.
 */
export function reduceWireChunk(state: WireReduceState, chunk: unknown): QoderStreamEvent[] {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return [];
  const record = chunk as Record<string, unknown>;
  const events: QoderStreamEvent[] = [];
  if (record.error !== undefined && record.error !== null) {
    const error = record.error as { message?: unknown };
    const detail = typeof error.message === "string" && error.message ? error.message : JSON.stringify(record.error);
    throw new Error(detail);
  }
  const hasChoices = Array.isArray(record.choices) && record.choices.length > 0;
  if (!hasChoices && record.raw_usage === undefined && record.usage === undefined) return [];
  ensureStart(state, events);
  if (typeof record.id === "string" && record.id) state.responseId = record.id;
  if (typeof record.model === "string" && record.model) state.upstreamModel = record.model;

  if (record.raw_usage !== undefined || record.usage !== undefined) {
    const raw = (record.raw_usage ?? record.usage) as unknown;
    const data =
      raw && typeof raw === "object" && !Array.isArray(raw) && "data" in (raw as Record<string, unknown>)
        ? (raw as Record<string, unknown>).data
        : raw;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      state.usage = toQoderUsage(data as QoderWireUsage);
    }
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return events;
  const { delta, finish_reason: finish } = choice as {
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown };
    finish_reason?: string | null;
  };

  const reasoning = delta?.reasoning_content;
  if (typeof reasoning === "string" && reasoning) {
    const block = state.openThinking ?? openThinking(state, events);
    block.argsJson += reasoning;
    events.push({ type: "thinking_delta", index: block.index, delta: reasoning });
  }
  const content = delta?.content;
  if (typeof content === "string" && content) {
    const block = state.openText ?? openText(state, events);
    block.argsJson += content;
    events.push({ type: "text_delta", index: block.index, delta: content });
  }

  if (Array.isArray(delta?.tool_calls)) {
    for (const raw of delta.tool_calls) {
      if (!raw || typeof raw !== "object") continue;
      const call = raw as {
        index?: number;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      };
      const wireIndex = typeof call.index === "number" ? call.index : state.tools.size;
      let block = state.tools.get(wireIndex);
      if (!block) {
        closeText(state, events);
        closeThinking(state, events);
        block = {
          index: state.nextIndex,
          id: call.id ?? `tool_${wireIndex}`,
          name: call.function?.name ?? "",
          argsJson: "",
          closed: false,
        };
        state.nextIndex += 1;
        state.tools.set(wireIndex, block);
        state.sawTool = true;
        events.push({ type: "tool_call_start", index: block.index, id: block.id, name: block.name });
      } else {
        if (call.id && call.id !== block.id) block.id = call.id;
        if (call.function?.name && !block.name) block.name = call.function.name;
      }
      const piece = call.function?.arguments;
      if (typeof piece === "string" && piece) {
        block.argsJson += piece;
        events.push({ type: "tool_call_delta", index: block.index, id: block.id, argumentsDelta: piece });
      }
    }
  }

  if (finish) state.stopReason = mapFinishReason(finish);
  return events;
}

export function finishWireReduce(state: WireReduceState): QoderStreamEvent[] {
  if (state.settled) return [];
  state.settled = true;
  const events: QoderStreamEvent[] = [];
  closeText(state, events);
  closeThinking(state, events);
  closeTools(state, events);
  if (state.sawTool) state.stopReason = "toolUse";
  if (state.usage) events.push({ type: "usage", usage: state.usage });
  events.push({
    type: "done",
    stopReason: state.stopReason,
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.upstreamModel ? { upstreamModel: state.upstreamModel } : {}),
  });
  return events;
}
