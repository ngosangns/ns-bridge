import { describe, expect, it } from "vitest";
import { streamToDsh, toDshUsage } from "../src/dsh/index.js";
import type { BridgeStreamEvent } from "../src/types.js";

async function collect(events: BridgeStreamEvent[]) {
  async function* source() {
    for (const event of events) yield event;
  }
  const out: Array<Record<string, unknown>> = [];
  for await (const chunk of streamToDsh(source())) out.push(chunk as unknown as Record<string, unknown>);
  return out;
}

describe("streamToDsh", () => {
  it("passes raw argument JSON through when the core kept it, serializes otherwise", async () => {
    const out = await collect([
      { type: "tool_call_start", index: 0, id: "a", name: "x" },
      { type: "tool_call_end", index: 0, id: "a", name: "x", arguments: { k: 1 }, argumentsJson: '{"k": 1 }' },
      { type: "tool_call_start", index: 1, id: "b", name: "y" },
      { type: "tool_call_end", index: 1, id: "b", name: "y", arguments: { k: 2 } },
      { type: "done", stopReason: "toolUse" },
    ]);
    const ends = out.filter((chunk) => chunk.type === "block-end") as Array<{ block: { arguments: string } }>;
    expect(ends.map((chunk) => chunk.block.arguments)).toEqual(['{"k": 1 }', '{"k":2}']);
    expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
  });

  it("closes blocks the core never ended", async () => {
    const out = await collect([{ type: "text_start", index: 3 }]);
    expect(out.at(-1)).toEqual({ type: "block-end", index: 3, block: { type: "text", text: "" } });
  });

  it("reports cache buckets only when they add up", () => {
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    expect(toDshUsage({ input: 1, output: 2, totalTokens: 3, cost })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(toDshUsage({ input: 1, output: 2, totalTokens: 9, cost })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 9,
    });
  });

  it("yields nothing for an empty core stream", async () => {
    expect(await collect([])).toEqual([]);
  });

  it("ignores start, reset, and unknown events", async () => {
    const out = await collect([
      { type: "start" },
      { type: "reset" },
      { type: "nope" } as unknown as BridgeStreamEvent,
      { type: "done", stopReason: "length", errorMessage: "cut" },
    ]);
    expect(out).toEqual([
      { type: "finish", reason: { kind: "max-tokens" }, replayState: { response: { errorMessage: "cut" } } },
    ]);
  });

  it("emits a tool end and a usage chunk with no surrounding events", async () => {
    const out = await collect([
      { type: "tool_call_end", index: 2, id: "a", name: "x", arguments: { k: 1 }, argumentsJson: "   " },
      {
        type: "usage",
        usage: {
          input: 1,
          output: 1,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ]);
    expect(out).toEqual([
      { type: "block-end", index: 2, block: { type: "tool-call", id: "a", name: "x", arguments: "{}" } },
      {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it("closes an unfinished thinking block as an empty text block after finish", async () => {
    const out = await collect([
      { type: "thinking_start", index: 1 },
      { type: "thinking_delta", index: 1, delta: "hmm" },
      { type: "done", stopReason: "stop" },
    ]);
    expect(out.at(0)).toEqual({ type: "block-start", index: 1, blockType: "reasoning" });
    expect(out.at(1)).toEqual({ type: "reasoning-delta", index: 1, text: "hmm" });
    expect(out.at(2)).toEqual({ type: "finish", reason: { kind: "stop" } });
    expect(out.at(3)).toEqual({ type: "block-end", index: 1, block: { type: "text", text: "" } });
  });
});
