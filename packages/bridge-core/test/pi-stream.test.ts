import { describe, expect, it } from "vitest";
import { streamToPi, toPiThinkingLevelMap } from "../src/pi/index.js";
import type { BridgeStreamEvent } from "../src/types.js";

class FakeStream {
  events: Array<Record<string, unknown>> = [];
  ended = false;
  done: Promise<void>;
  private resolve!: () => void;
  constructor() {
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  push(event: unknown) {
    this.events.push(structuredClone(event) as Record<string, unknown>);
  }
  end() {
    this.ended = true;
    this.resolve();
  }
}

async function* from(events: BridgeStreamEvent[]) {
  for (const event of events) yield event;
}

const model = { id: "m", api: "test-api", provider: "test" };

describe("streamToPi", () => {
  it("assembles text, thinking, tool calls, usage and done", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          { type: "start" },
          { type: "thinking_start", index: 0 },
          { type: "thinking_delta", index: 0, delta: "th" },
          { type: "thinking_end", index: 0, thinking: "think", signature: "sig" },
          { type: "text_start", index: 1 },
          { type: "text_delta", index: 1, delta: "he" },
          { type: "text_end", index: 1, text: "hello" },
          { type: "tool_call_start", index: 2, id: "c1", name: "read" },
          { type: "tool_call_delta", index: 2, id: "c1", argumentsDelta: '{"p":1}' },
          { type: "tool_call_end", index: 2, id: "c1", name: "read", arguments: { p: 1 } },
          {
            type: "usage",
            usage: {
              input: 10,
              output: 5,
              totalTokens: 15,
              credits: 0.5,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
          { type: "done", stopReason: "toolUse", responseId: "resp-1", upstreamModel: "m-2" },
        ]),
    });
    await stream.done;
    const types = stream.events.map((event) => event.type);
    expect(types).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = stream.events.at(-1) as { reason: string; message: Record<string, unknown> };
    expect(done.reason).toBe("toolUse");
    expect(done.message).toMatchObject({
      api: "test-api",
      provider: "test",
      model: "m",
      responseId: "resp-1",
      responseModel: "m-2",
      stopReason: "toolUse",
      usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, credits: 0.5 },
      content: [
        { type: "thinking", thinking: "think", thinkingSignature: "sig" },
        { type: "text", text: "hello" },
        { type: "toolCall", id: "c1", name: "read", arguments: { p: 1 } },
      ],
    });
    expect(stream.ended).toBe(true);
  });

  it("truncates on reset and keeps indexes consistent", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          { type: "start" },
          { type: "text_start", index: 0 },
          { type: "text_end", index: 0, text: "discarded" },
          { type: "reset" },
          { type: "text_start", index: 1 },
          { type: "text_end", index: 1, text: "kept" },
          { type: "done", stopReason: "stop" },
        ]),
    });
    await stream.done;
    const done = stream.events.at(-1) as { message: { content: unknown[] } };
    expect(done.message.content).toEqual([{ type: "text", text: "kept" }]);
    const lastTextEnd = stream.events.filter((event) => event.type === "text_end").at(-1);
    expect(lastTextEnd?.contentIndex).toBe(0);
  });

  it("turns a failure into an error event with redacted text", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: async () => {
        throw new Error("401 for Bearer abcdefghijklmnopqrstuvwxyz");
      },
    });
    await stream.done;
    const error = stream.events.at(-1) as { type: string; reason: string; error: { errorMessage: string } };
    expect(error.type).toBe("error");
    expect(error.reason).toBe("error");
    expect(error.error.errorMessage).not.toContain("abcdefghijklmnop");
  });
});

describe("toPiThinkingLevelMap", () => {
  it("maps supported efforts to themselves and marks the rest unsupported", () => {
    expect(toPiThinkingLevelMap(["low", "high"])).toEqual({
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(toPiThinkingLevelMap(undefined)).toBeUndefined();
  });
});
