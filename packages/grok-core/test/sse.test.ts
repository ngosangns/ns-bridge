import { describe, expect, it } from "vitest";
import { createResponsesState, reduceResponsesEvent, type WireEvent } from "../src/sse.js";

function reduce(events: WireEvent[], model = "grok-4.5") {
  const state = createResponsesState(model);
  const out = [];
  for (const event of events) out.push(...reduceResponsesEvent(state, event));
  return out;
}

const toolTurn: WireEvent[] = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.in_progress" },
  { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
  { type: "response.reasoning_summary_part.added", item_id: "rs_1" },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Look" },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: " up" },
  { type: "response.reasoning_summary_text.done", item_id: "rs_1", text: "Look up" },
  { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "ping", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"value":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"HOST-PING"}' },
  {
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    name: "ping",
    arguments: '{"value":"HOST-PING"}',
  },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "ping" },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      model: "grok-4.5-build",
      status: "completed",
      usage: {
        input_tokens: 208,
        input_tokens_details: { cached_tokens: 128 },
        output_tokens: 39,
        total_tokens: 247,
      },
    },
  },
];

describe("Responses SSE reducer", () => {
  it("emits thinking, the host tool call, and cache-split usage", () => {
    const events = reduce(toolTurn);
    expect(events).toContainEqual({ type: "thinking_start", index: 0 });
    expect(events).toContainEqual({ type: "thinking_delta", index: 0, delta: "Look" });
    expect(events).toContainEqual({ type: "thinking_end", index: 0, thinking: "Look up" });
    expect(events).toContainEqual({ type: "tool_call_start", index: 1, id: "call_1", name: "ping" });
    expect(events).toContainEqual({
      type: "tool_call_end",
      index: 1,
      id: "call_1",
      name: "ping",
      arguments: { value: "HOST-PING" },
      argumentsJson: '{"value":"HOST-PING"}',
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        input: 80,
        output: 39,
        cacheRead: 128,
        totalTokens: 247,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "toolUse",
      responseId: "resp_1",
      upstreamModel: "grok-4.5-build",
    });
    expect(JSON.stringify(events)).not.toContain("read_file");
  });

  it("emits text and stop when the model does not call a tool", () => {
    const events = reduce([
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
      { type: "response.output_text.done", item_id: "msg_1", text: "Hi" },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message" } },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    ]);
    expect(events).toContainEqual({ type: "text_start", index: 0 });
    expect(events).toContainEqual({ type: "text_delta", index: 0, delta: "Hi" });
    expect(events).toContainEqual({ type: "text_end", index: 0, text: "Hi" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", responseId: "resp_2" });
  });

  it("keeps unparseable tool arguments for the host and reports an empty object", () => {
    const events = reduce([
      {
        type: "response.output_item.added",
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "ping" },
      },
      { type: "response.function_call_arguments.done", item_id: "fc_1", name: "ping", arguments: "{" },
      { type: "response.completed", response: { status: "completed" } },
    ]);
    expect(events).toContainEqual({
      type: "tool_call_end",
      index: 0,
      id: "call_1",
      name: "ping",
      arguments: {},
      argumentsJson: "{",
    });
  });

  it("reports length when the proxy stops for max_output_tokens", () => {
    const events = reduce([
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
    ]);
    expect(events).toContainEqual({ type: "text_end", index: 0, text: "Hi" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "length" });
  });
});
