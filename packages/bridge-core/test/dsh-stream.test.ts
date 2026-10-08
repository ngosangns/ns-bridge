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
});
