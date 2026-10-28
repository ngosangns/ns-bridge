import { describe, expect, it } from "vitest";
import { createSdkReduceState, finishSdkReduce, reduceSdkMessage } from "../src/sdk-reduce.js";

describe("sdk-reduce", () => {
  it("maps a non-streaming assistant message with tool_use", () => {
    const state = createSdkReduceState();
    const events = [
      ...reduceSdkMessage(state, {
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
          ],
          model: "auto",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
      ...finishSdkReduce(state),
    ];
    expect(events.some((e) => e.type === "text_end" && e.text === "Hello")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_end" && e.name === "read")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "toolUse" });
  });

  it("maps stream_event text deltas", () => {
    const state = createSdkReduceState();
    const events = [
      ...reduceSdkMessage(state, {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "s1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }),
      ...reduceSdkMessage(state, {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "s1",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      }),
      ...reduceSdkMessage(state, {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "u4",
        session_id: "s1",
        event: { type: "content_block_stop", index: 0 },
      }),
      ...reduceSdkMessage(state, {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "Hi",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } as never,
        modelUsage: {},
        permission_denials: [],
        uuid: "r1",
        session_id: "s1",
      }),
      ...finishSdkReduce(state),
    ];
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["Hi"]);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});
