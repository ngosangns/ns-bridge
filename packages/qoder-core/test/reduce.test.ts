import { describe, expect, it } from "vitest";
import { createWireReduceState, finishWireReduce, reduceWireChunk } from "../src/reduce.js";

describe("wire reduce", () => {
  it("maps text and reasoning deltas across interleaved blocks", () => {
    const state = createWireReduceState();
    const events = [
      ...reduceWireChunk(state, {
        id: "chatcmpl-1",
        model: "dfmodel",
        choices: [{ delta: { reasoning_content: "think" } }],
      }),
      ...reduceWireChunk(state, { choices: [{ delta: { reasoning_content: "ing" } }] }),
      ...reduceWireChunk(state, { choices: [{ delta: { content: "Hi" } }] }),
      ...finishWireReduce(state),
    ];
    expect(events[0]).toEqual({ type: "start" });
    expect(events.filter((e) => e.type === "thinking_delta").map((e) => e.delta)).toEqual(["think", "ing"]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta)).toEqual(["Hi"]);
    const done = events.at(-1) as { type: string; stopReason: string; responseId?: string; upstreamModel?: string };
    expect(done).toMatchObject({
      type: "done",
      stopReason: "stop",
      responseId: "chatcmpl-1",
      upstreamModel: "dfmodel",
    });
  });

  it("reassembles indexed tool call fragments and maps finish_reason", () => {
    const state = createWireReduceState();
    const events = [
      ...reduceWireChunk(state, {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":' } }],
            },
          },
        ],
      }),
      ...reduceWireChunk(state, {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }],
      }),
      ...reduceWireChunk(state, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ...finishWireReduce(state),
    ];
    const end = events.find((e) => e.type === "tool_call_end") as { name: string; arguments: unknown };
    expect(end.name).toBe("read");
    expect(end.arguments).toEqual({ path: "a.ts" });
    const done = events.at(-1) as { type: string; stopReason: string };
    expect(done.stopReason).toBe("toolUse");
  });

  it("prefers raw_usage.data for usage", () => {
    const state = createWireReduceState();
    const events = [
      ...reduceWireChunk(state, {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        raw_usage: {
          account_discount: 1,
          data: {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_cache_hit_tokens: 60,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      }),
      ...finishWireReduce(state),
    ];
    const usage = events.find((e) => e.type === "usage") as {
      usage: { input: number; output: number; totalTokens: number; cacheRead?: number };
    };
    expect(usage.usage.input).toBe(100);
    expect(usage.usage.output).toBe(10);
    expect(usage.usage.totalTokens).toBe(110);
    expect(usage.usage.cacheRead).toBe(60);
  });

  it("ignores unrecognized frames", () => {
    const state = createWireReduceState();
    expect(reduceWireChunk(state, { weird: true })).toEqual([]);
    expect(reduceWireChunk(state, "junk")).toEqual([]);
    expect(reduceWireChunk(state, null)).toEqual([]);
  });
});
