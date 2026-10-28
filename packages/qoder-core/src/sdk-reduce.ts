// ABOUTME: Reduces Qoder SDK messages into neutral stream events.

import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import type { QoderStreamEvent, QoderUsage } from "./types.js";
import { type QoderWireUsage, toQoderUsage } from "./usage.js";

interface OpenBlock {
  kind: "text" | "thinking" | "tool";
  index: number;
  id: string;
  name: string;
  text: string;
  argsJson: string;
  closed: boolean;
}

export interface SdkReduceState {
  started: boolean;
  settled: boolean;
  nextIndex: number;
  openText?: OpenBlock;
  openThinking?: OpenBlock;
  tools: Map<string, OpenBlock>;
  sawTool: boolean;
  sawStream: boolean;
  stopReason: "stop" | "toolUse" | "length";
  usage?: QoderUsage;
  responseId?: string;
  upstreamModel?: string;
}

export function createSdkReduceState(): SdkReduceState {
  return {
    started: false,
    settled: false,
    nextIndex: 0,
    tools: new Map(),
    sawTool: false,
    sawStream: false,
    stopReason: "stop",
  };
}

function ensureStart(state: SdkReduceState, events: QoderStreamEvent[]): void {
  if (!state.started) {
    state.started = true;
    events.push({ type: "start" });
  }
}

function closeText(state: SdkReduceState, events: QoderStreamEvent[]): void {
  if (state.openText && !state.openText.closed) {
    state.openText.closed = true;
    events.push({ type: "text_end", index: state.openText.index, text: state.openText.text });
    state.openText = undefined;
  }
}

function closeThinking(state: SdkReduceState, events: QoderStreamEvent[]): void {
  if (state.openThinking && !state.openThinking.closed) {
    state.openThinking.closed = true;
    events.push({
      type: "thinking_end",
      index: state.openThinking.index,
      thinking: state.openThinking.text,
    });
    state.openThinking = undefined;
  }
}

function closeTools(state: SdkReduceState, events: QoderStreamEvent[]): void {
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

function mapStopReason(raw: string | null | undefined): "stop" | "toolUse" | "length" {
  if (raw === "tool_use") return "toolUse";
  if (raw === "max_tokens") return "length";
  return "stop";
}

function reduceStreamEvent(state: SdkReduceState, event: Record<string, unknown>): QoderStreamEvent[] {
  const events: QoderStreamEvent[] = [];
  ensureStart(state, events);
  state.sawStream = true;
  const type = event.type;
  if (type === "content_block_start") {
    const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
    if (!block?.type) return events;
    if (block.type === "text") {
      closeText(state, events);
      closeThinking(state, events);
      state.openText = {
        kind: "text",
        index: state.nextIndex,
        id: "",
        name: "",
        text: "",
        argsJson: "",
        closed: false,
      };
      state.nextIndex += 1;
      events.push({ type: "text_start", index: state.openText.index });
    } else if (block.type === "thinking") {
      closeText(state, events);
      closeThinking(state, events);
      state.openThinking = {
        kind: "thinking",
        index: state.nextIndex,
        id: "",
        name: "",
        text: "",
        argsJson: "",
        closed: false,
      };
      state.nextIndex += 1;
      events.push({ type: "thinking_start", index: state.openThinking.index });
    } else if (block.type === "tool_use" && block.id && block.name) {
      closeText(state, events);
      closeThinking(state, events);
      const toolBlock: OpenBlock = {
        kind: "tool",
        index: state.nextIndex,
        id: block.id,
        name: block.name,
        text: "",
        argsJson: "",
        closed: false,
      };
      state.nextIndex += 1;
      state.tools.set(block.id, toolBlock);
      state.sawTool = true;
      events.push({ type: "tool_call_start", index: toolBlock.index, id: toolBlock.id, name: toolBlock.name });
    }
    return events;
  }
  if (type === "content_block_delta") {
    const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
    if (!delta?.type) return events;
    if (delta.type === "text_delta" && state.openText) {
      const piece = delta.text ?? "";
      state.openText.text += piece;
      events.push({ type: "text_delta", index: state.openText.index, delta: piece });
    } else if (delta.type === "thinking_delta" && state.openThinking) {
      const piece = delta.thinking ?? "";
      state.openThinking.text += piece;
      events.push({ type: "thinking_delta", index: state.openThinking.index, delta: piece });
    } else if (delta.type === "input_json_delta") {
      const index = typeof event.index === "number" ? event.index : undefined;
      const tool = [...state.tools.values()].find((t) => !t.closed && (index === undefined || t.index === index));
      if (tool) {
        const piece = delta.partial_json ?? "";
        tool.argsJson += piece;
        events.push({ type: "tool_call_delta", index: tool.index, id: tool.id, argumentsDelta: piece });
      }
    }
    return events;
  }
  if (type === "content_block_stop") {
    closeText(state, events);
    closeThinking(state, events);
    return events;
  }
  if (type === "message_delta") {
    const stop = (event.delta as { stop_reason?: string } | undefined)?.stop_reason;
    if (stop) state.stopReason = mapStopReason(stop);
    return events;
  }
  return events;
}

function reduceAssistantMessage(
  state: SdkReduceState,
  message: SDKMessage & { type: "assistant" },
): QoderStreamEvent[] {
  if (state.sawStream) return [];
  const events: QoderStreamEvent[] = [];
  ensureStart(state, events);
  const content = message.message.content;
  if (!Array.isArray(content)) return events;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (typed.type === "text" && typed.text) {
      closeThinking(state, events);
      const index = state.nextIndex;
      state.nextIndex += 1;
      events.push({ type: "text_start", index });
      events.push({ type: "text_delta", index, delta: typed.text });
      events.push({ type: "text_end", index, text: typed.text });
    } else if (typed.type === "thinking" && typed.thinking) {
      const index = state.nextIndex;
      state.nextIndex += 1;
      events.push({ type: "thinking_start", index });
      events.push({ type: "thinking_delta", index, delta: typed.thinking });
      events.push({ type: "thinking_end", index, thinking: typed.thinking });
    } else if (typed.type === "tool_use" && typed.id && typed.name) {
      state.sawTool = true;
      const index = state.nextIndex;
      state.nextIndex += 1;
      const argsJson = JSON.stringify(typed.input ?? {});
      const args = (typed.input && typeof typed.input === "object" ? typed.input : {}) as Record<string, unknown>;
      events.push({ type: "tool_call_start", index, id: typed.id, name: typed.name });
      events.push({
        type: "tool_call_end",
        index,
        id: typed.id,
        name: typed.name,
        arguments: args,
        argumentsJson: argsJson,
      });
    }
  }
  if (message.request_id) state.responseId = message.request_id;
  return events;
}

export function reduceSdkMessage(state: SdkReduceState, message: SDKMessage): QoderStreamEvent[] {
  if (message.type === "stream_event") {
    return reduceStreamEvent(state, message.event as Record<string, unknown>);
  }
  if (message.type === "assistant") {
    return reduceAssistantMessage(state, message);
  }
  if (message.type === "result") {
    const events: QoderStreamEvent[] = [];
    ensureStart(state, events);
    const wire = message.usage as QoderWireUsage;
    state.usage = toQoderUsage(wire, message.total_credits);
    state.stopReason = mapStopReason(message.stop_reason);
    if (message.subtype === "error_max_turns") state.stopReason = "length";
    return events;
  }
  return [];
}

export function finishSdkReduce(state: SdkReduceState): QoderStreamEvent[] {
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
