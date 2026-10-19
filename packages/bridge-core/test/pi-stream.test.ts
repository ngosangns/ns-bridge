import { describe, expect, it, vi } from "vitest";
import { streamToDsh } from "../src/dsh/index.js";
import { HOST_TURN_BUDGET_MS, streamToPi, toPiThinkingLevelMap } from "../src/pi/index.js";
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

  it("ends without events when the core produces nothing", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () => from([]),
    });
    await stream.done;
    expect(stream.events).toEqual([]);
    expect(stream.ended).toBe(true);
  });

  it("drops a delta or tool end that has no matching start", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          { type: "text_delta", index: 4, delta: "nope" },
          { type: "tool_call_end", index: 5, id: "c", name: "read", arguments: { p: 1 } },
          { type: "done", stopReason: "stop" },
        ]),
    });
    await stream.done;
    expect(stream.events.map((event) => event.type)).toEqual(["start", "done"]);
    const done = stream.events.at(-1) as { message: { content: unknown[] } };
    expect(done.message.content).toEqual([]);
  });

  it("keeps thinking text accumulated from deltas when the block never ends", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          { type: "thinking_start", index: 0 },
          { type: "thinking_delta", index: 0, delta: "hmm" },
          {
            type: "usage",
            usage: {
              input: 3,
              output: 1,
              totalTokens: 4,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
          { type: "done", stopReason: "length" },
        ]),
    });
    await stream.done;
    const done = stream.events.at(-1) as { reason: string; message: { content: unknown[]; usage: { input: number } } };
    expect(done.reason).toBe("length");
    expect(done.message.content).toEqual([{ type: "thinking", thinking: "hmm" }]);
    expect(done.message.usage.input).toBe(3);
  });

  it("ends the host stream when usage arrives without a done event", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          {
            type: "usage",
            usage: {
              input: 1,
              output: 1,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ]),
    });
    await stream.done;
    expect(stream.events).toEqual([]);
    expect(stream.ended).toBe(true);
  });

  it("ignores an unknown event and still finishes", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () => from([{ type: "nope" } as unknown as BridgeStreamEvent, { type: "done", stopReason: "stop" }]),
    });
    await stream.done;
    expect(stream.events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("reports aborted when the signal is already aborted, and redacts a non-Error throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = streamToPi({
      model,
      signal: controller.signal,
      createStream: () => new FakeStream(),
      events: async () => {
        throw new Error("Bearer abcdefghijklmnopqrstuvwxyz");
      },
    });
    await aborted.done;
    const abortedEvent = aborted.events.at(-1) as { reason: string; error: { errorMessage: string } };
    expect(abortedEvent.reason).toBe("aborted");
    expect(abortedEvent.error.errorMessage).not.toContain("abcdefghijklmnop");

    const plain = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () => {
        throw "devin-session-token$abcdefghijklmnopqrstuvwxyz";
      },
    });
    await plain.done;
    const plainEvent = plain.events.at(-1) as { reason: string; error: { errorMessage: string; content: unknown[] } };
    expect(plainEvent.reason).toBe("error");
    expect(plainEvent.error.errorMessage).toBe("devin-session-token$[redacted]");
    expect(plainEvent.error.content).toEqual([]);
  });

  it("merges consecutive deltas for one block into a single host update", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, delta: "he" },
          { type: "text_delta", index: 0, delta: "llo" },
          { type: "text_end", index: 0, text: "hello" },
          { type: "thinking_start", index: 1 },
          { type: "thinking_delta", index: 1, delta: "a" },
          { type: "thinking_delta", index: 1, delta: "b" },
          { type: "thinking_end", index: 1, thinking: "ab" },
          { type: "tool_call_start", index: 2, id: "c1", name: "read" },
          { type: "tool_call_delta", index: 2, id: "c1", argumentsDelta: '{"p":' },
          { type: "tool_call_delta", index: 2, id: "c1", argumentsDelta: "1}" },
          { type: "tool_call_end", index: 2, id: "c1", name: "read", arguments: { p: 1 } },
          { type: "done", stopReason: "toolUse" },
        ]),
    });
    await stream.done;
    const deltas = stream.events.filter(
      (event) => event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta",
    );
    expect(deltas.map((event) => event.delta)).toEqual(["hello", "ab", '{"p":1}']);
    const done = stream.events.at(-1) as { message: { content: unknown[] } };
    expect(done.message.content).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "ab" },
      { type: "toolCall", id: "c1", name: "read", arguments: { p: 1 } },
    ]);
  });

  it("flushes a burst of deltas while the next read is still pending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: async function* () {
        yield { type: "text_start", index: 0 };
        yield { type: "text_delta", index: 0, delta: "aa" };
        yield { type: "text_delta", index: 0, delta: "bb" };
        await gate;
        yield { type: "text_delta", index: 0, delta: "cc" };
        yield { type: "done", stopReason: "stop" };
      },
    });
    await vi.waitFor(
      () => {
        const deltas = stream.events.filter((event) => event.type === "text_delta");
        expect(deltas.map((event) => event.delta)).toEqual(["aabb"]);
      },
      { timeout: 500 },
    );
    release();
    await stream.done;
    const deltas = stream.events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.delta)).toEqual(["aabb", "cc"]);
    const done = stream.events.at(-1) as { message: { content: Array<{ text: string }> } };
    expect(done.message.content).toEqual([{ type: "text", text: "aabbcc" }]);
  });

  it("holds tool argument deltas until the call ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: async function* () {
        yield { type: "tool_call_start", index: 0, id: "c1", name: "write" };
        yield { type: "tool_call_delta", index: 0, id: "c1", argumentsDelta: "aaaa" };
        yield { type: "tool_call_delta", index: 0, id: "c1", argumentsDelta: "bbbb" };
        await gate;
        yield { type: "tool_call_end", index: 0, id: "c1", name: "write", arguments: { path: "a" } };
        yield { type: "done", stopReason: "toolUse" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stream.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
    release();
    await stream.done;
    const deltas = stream.events.filter((event) => event.type === "toolcall_delta");
    expect(deltas.map((event) => event.delta)).toEqual(["aaaabbbb"]);
  });

  it("waits longer before repainting a large open code fence", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fence = `\`\`\`ts\n${"const x = 1;\n".repeat(3_000)}`;
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: async function* () {
        yield { type: "text_start", index: 0 };
        yield { type: "text_delta", index: 0, delta: fence };
        await gate;
        yield { type: "done", stopReason: "stop" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.events.some((event) => event.type === "text_delta")).toBe(false);
    await vi.waitFor(
      () => {
        expect(stream.events.some((event) => event.type === "text_delta")).toBe(true);
      },
      { timeout: 800 },
    );
    release();
    await stream.done;
  });

  it("drops deltas still held when a retry resets the message", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: () =>
        from([
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, delta: "nope" },
          { type: "reset" },
          { type: "text_start", index: 1 },
          { type: "text_delta", index: 1, delta: "ok" },
          { type: "text_end", index: 1, text: "ok" },
          { type: "done", stopReason: "stop" },
        ]),
    });
    await stream.done;
    const deltas = stream.events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.delta)).toEqual(["ok"]);
    const done = stream.events.at(-1) as { message: { content: unknown[] } };
    expect(done.message.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("keeps a 200-delta burst, including a 30KB fence, inside the host turn budget", async () => {
    const textDeltas = 150;
    const thinkingDeltas = 30;
    const toolDeltas = 20;
    const fence = `\`\`\`ts\n${"const x = 1;\n".repeat(2_300)}`;
    const events: BridgeStreamEvent[] = [{ type: "text_start", index: 0 }];
    for (let index = 0; index < textDeltas; index += 1) {
      events.push({ type: "text_delta", index: 0, delta: index === 0 ? fence : "a" });
    }
    events.push({ type: "thinking_start", index: 1 });
    for (let index = 0; index < thinkingDeltas; index += 1) {
      events.push({ type: "thinking_delta", index: 1, delta: "t" });
    }
    events.push({ type: "tool_call_start", index: 2, id: "c1", name: "read" });
    for (let index = 0; index < toolDeltas; index += 1) {
      events.push({ type: "tool_call_delta", index: 2, id: "c1", argumentsDelta: "{}" });
    }
    events.push({ type: "tool_call_end", index: 2, id: "c1", name: "read", arguments: {} });
    events.push({ type: "done", stopReason: "stop" });

    const dsh: Array<Record<string, unknown>> = [];
    for await (const chunk of streamToDsh(from(events))) dsh.push(chunk as unknown as Record<string, unknown>);
    // Characterization of the current Harness bridge: one host chunk per core
    // delta. Coalescing DSH waits on this count and on the Pi budget above.
    expect(dsh.filter((chunk) => chunk.type === "text-delta")).toHaveLength(textDeltas);
    expect(dsh.filter((chunk) => chunk.type === "reasoning-delta")).toHaveLength(thinkingDeltas);
    expect(dsh.filter((chunk) => chunk.type === "tool-call-delta")).toHaveLength(toolDeltas + 1);

    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => {
      clock += 1;
      return clock;
    });
    const marks = [0];
    const realTimeout = globalThis.setTimeout;
    const realImmediate = globalThis.setImmediate;
    // Block boundaries flush the held text. A real flush timer would also
    // fire when the event loop is busy, so this test silences that timer and
    // measures the synchronous budget with a fake clock.
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof delay === "number" && delay >= 32) {
        const handle = realTimeout(() => {}, 0);
        clearTimeout(handle);
        return handle;
      }
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementation(((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => {
      marks.push(clock);
      return realImmediate(callback, ...args);
    }) as typeof setImmediate);
    try {
      const stream = streamToPi({
        model,
        createStream: () => new FakeStream(),
        events: () => from(events),
      });
      await stream.done;
      marks.push(clock);
      const endAt = stream.events.findIndex((event) => event.type === "toolcall_end");
      const textUpdates = stream.events.slice(0, endAt).filter((event) => event.type === "text_delta");
      expect(textUpdates.length).toBeGreaterThan(0);
      expect(textUpdates.length).toBeLessThanOrEqual(8);
      expect(String(textUpdates[0]?.delta)).toContain(fence);
      const gaps = marks.slice(1).map((mark, index) => mark - marks[index]);
      const widest = Math.max(...gaps);
      // The budget is checked after the event that crosses it, and resetting
      // the window reads the clock once more. A fake clock keeps this off the
      // machine's load average.
      expect(widest, `clock marks ${marks.join(",")}`).toBeLessThanOrEqual(HOST_TURN_BUDGET_MS + 3);
    } finally {
      immediate.mockRestore();
      timeout.mockRestore();
      now.mockRestore();
    }
  });

  it("keeps blocks already opened when the core throws mid-turn", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakeStream(),
      events: async function* () {
        yield { type: "text_start", index: 0 };
        yield { type: "text_delta", index: 0, delta: "hel" };
        throw new Error("ksk_abcdefghijklmnopqrstuvwxyz");
      },
    });
    await stream.done;
    const error = stream.events.at(-1) as {
      type: string;
      error: { errorMessage: string; content: Array<{ text?: string }> };
    };
    expect(error.type).toBe("error");
    expect(error.error.errorMessage).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(error.error.content).toEqual([{ type: "text", text: "hel" }]);
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
