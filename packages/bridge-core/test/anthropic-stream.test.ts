// ABOUTME: Tests the projection from neutral core events into Anthropic Messages SSE frames
// ABOUTME: and the non-streaming collected message.

import { describe, expect, it } from "vitest";
import { anthropicError, collectAnthropicMessage, toAnthropicSse } from "../src/anthropic/stream.js";
import type { BridgeStreamEvent } from "../src/types.js";

/** Loosely typed on purpose: assertions read wire JSON, not typed events. */
interface SseData {
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  message?: { usage?: { input_tokens?: number } };
  error?: { type?: string; message?: string };
  [key: string]: unknown;
}

interface SseFrame {
  event: string;
  data: SseData;
}

function parseFrame(raw: string): SseFrame {
  const [eventLine, dataLine] = raw.split("\n");
  return {
    event: (eventLine ?? "").slice("event: ".length),
    data: JSON.parse((dataLine ?? "").slice("data: ".length)) as SseData,
  };
}

async function frames(events: BridgeStreamEvent[], options?: { inputTokensHint?: number }): Promise<SseFrame[]> {
  async function* source() {
    for (const event of events) yield event;
  }
  const out: SseFrame[] = [];
  for await (const raw of toAnthropicSse(source(), { model: "claude-x", messageId: "msg_1", ...options })) {
    out.push(parseFrame(raw));
  }
  return out;
}

async function* throwingAfter(events: BridgeStreamEvent[]): AsyncGenerator<BridgeStreamEvent> {
  for (const event of events) yield event;
  throw new Error("upstream boom");
}

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

describe("toAnthropicSse", () => {
  it("maps non-contiguous neutral indexes onto Anthropic positions in start order", async () => {
    const out = await frames([
      { type: "text_start", index: 3 },
      { type: "text_delta", index: 3, delta: "Hello" },
      { type: "thinking_start", index: 7 },
      { type: "thinking_delta", index: 7, delta: "hmm" },
      { type: "thinking_end", index: 7, thinking: "hmm", signature: "sig" },
      { type: "text_end", index: 3, text: "Hello" },
      { type: "tool_call_start", index: 9, id: "c1", name: "Bash" },
      {
        type: "tool_call_end",
        index: 9,
        id: "c1",
        name: "Bash",
        arguments: { command: "ls" },
        argumentsJson: '{"command":"ls"}',
      },
      { type: "done", stopReason: "toolUse" },
    ]);
    expect(out.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const blocks = out.filter((frame) => frame.event.startsWith("content_block"));
    expect(blocks.map((frame) => frame.data.index)).toEqual([0, 0, 1, 1, 1, 1, 0, 2, 2, 2]);
    expect(out[0]).toEqual({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-x",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
    expect(out[1]?.data.content_block).toEqual({ type: "text", text: "" });
    expect(out[2]?.data.delta).toEqual({ type: "text_delta", text: "Hello" });
    expect(out[3]?.data.content_block).toEqual({ type: "thinking", thinking: "" });
    expect(out[4]?.data.delta).toEqual({ type: "thinking_delta", thinking: "hmm" });
    expect(out[5]?.data.delta).toEqual({ type: "signature_delta", signature: "sig" });
    expect(out[8]?.data.content_block).toEqual({ type: "tool_use", id: "c1", name: "Bash", input: {} });
    expect(out[9]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"command":"ls"}' });
    expect(out.at(-2)?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(out.at(-1)?.data).toEqual({ type: "message_stop" });
  });

  it("seeds message_start input tokens from the hint", async () => {
    const out = await frames([{ type: "done", stopReason: "stop" }], { inputTokensHint: 123 });
    expect(out[0]?.data.message?.usage?.input_tokens).toBe(123);
  });

  it("forwards tool argument deltas and sends no whole-arguments delta when they streamed", async () => {
    const out = await frames([
      { type: "tool_call_start", index: 0, id: "c1", name: "Edit" },
      { type: "tool_call_delta", index: 0, id: "c1", argumentsDelta: '{"file_' },
      { type: "tool_call_delta", index: 0, id: "c1", argumentsDelta: 'path":"a"}' },
      { type: "tool_call_end", index: 0, id: "c1", name: "Edit", arguments: { file_path: "a" } },
      { type: "done", stopReason: "toolUse" },
    ]);
    const json = out.filter((frame) => frame.data.delta?.type === "input_json_delta");
    expect(json.map((frame) => frame.data.delta?.partial_json)).toEqual(['{"file_', 'path":"a"}']);
  });

  it("emits the whole tool arguments in one delta when none streamed", async () => {
    const withRaw = await frames([
      {
        type: "tool_call_end",
        index: 2,
        id: "c1",
        name: "Bash",
        arguments: { command: "ls" },
        argumentsJson: '{"command": "ls"}',
      },
      { type: "done", stopReason: "toolUse" },
    ]);
    expect(withRaw[1]?.data.content_block).toEqual({ type: "tool_use", id: "c1", name: "Bash", input: {} });
    expect(withRaw[2]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"command": "ls"}' });

    const withoutRaw = await frames([
      { type: "tool_call_end", index: 2, id: "c1", name: "Bash", arguments: { command: "ls" } },
      { type: "done", stopReason: "toolUse" },
    ]);
    expect(withoutRaw[2]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"command":"ls"}' });
  });

  it("synthesizes a start when a block ends without one", async () => {
    const out = await frames([
      { type: "text_end", index: 4, text: "whole text" },
      { type: "done", stopReason: "stop" },
    ]);
    expect(out.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(out[1]?.data.index).toBe(0);
    expect(out[1]?.data.content_block).toEqual({ type: "text", text: "" });
    expect(out[2]?.data.delta).toEqual({ type: "text_delta", text: "whole text" });
  });

  it("ignores resets; blocks a retry emits become new Anthropic blocks", async () => {
    const out = await frames([
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, delta: "discarded" },
      { type: "reset" },
      { type: "text_start", index: 1 },
      { type: "text_delta", index: 1, delta: "kept" },
      { type: "text_end", index: 1, text: "kept" },
      { type: "done", stopReason: "stop" },
    ]);
    const starts = out.filter((frame) => frame.event === "content_block_start");
    expect(starts.map((frame) => frame.data.index)).toEqual([0, 1]);
    const deltas = out.filter((frame) => frame.data.delta?.type === "text_delta");
    expect(deltas.map((frame) => frame.data.delta?.text)).toEqual(["discarded", "kept"]);
  });

  it("reports the last usage, mapping cache buckets and leaving absent ones out", async () => {
    const out = await frames([
      { type: "usage", usage: { input: 10, output: 5, totalTokens: 15, cost: COST } },
      { type: "usage", usage: { input: 20, output: 9, totalTokens: 39, cacheRead: 8, cacheWrite: 2, cost: COST } },
      { type: "done", stopReason: "stop" },
    ]);
    expect(out.at(-2)?.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 9,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 2,
    });
  });

  it("closes open blocks and yields an error frame when the core throws, never throwing itself", async () => {
    const out: SseFrame[] = [];
    for await (const raw of toAnthropicSse(throwingAfter([{ type: "text_start", index: 0 }]), {
      model: "claude-x",
      messageId: "msg_1",
    })) {
      out.push(parseFrame(raw));
    }
    expect(out.at(-2)).toEqual({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
    expect(out.at(-1)?.event).toBe("error");
    expect(out.at(-1)?.data).toEqual({ type: "error", error: { type: "api_error", message: "upstream boom" } });
    expect(out.some((frame) => frame.event === "message_stop")).toBe(false);
  });

  it("treats an iterator that ends without done as an end_turn", async () => {
    const out = await frames([
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, delta: "hi" },
    ]);
    expect(out.at(-2)?.data.delta?.stop_reason).toBe("end_turn");
    expect(out.at(-1)?.data).toEqual({ type: "message_stop" });
  });

  it("maps stop reasons onto Anthropic ones", async () => {
    for (const [neutral, anthropic] of [
      ["stop", "end_turn"],
      ["toolUse", "tool_use"],
      ["length", "max_tokens"],
    ] as const) {
      const out = await frames([{ type: "done", stopReason: neutral }]);
      expect(out.at(-2)?.data.delta?.stop_reason).toBe(anthropic);
    }
  });

  it("emits the closing frames even for an empty core stream", async () => {
    const out = await frames([]);
    expect(out.map((frame) => frame.event)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

describe("collectAnthropicMessage", () => {
  it("assembles the non-streaming response with the same block mapping", async () => {
    async function* source(): AsyncGenerator<BridgeStreamEvent> {
      yield { type: "thinking_start", index: 0 };
      yield { type: "thinking_delta", index: 0, delta: "hmm" };
      yield { type: "thinking_end", index: 0, thinking: "hmm", signature: "sig" };
      yield { type: "text_start", index: 1 };
      yield { type: "text_delta", index: 1, delta: "Hello" };
      yield { type: "text_end", index: 1, text: "Hello" };
      yield { type: "tool_call_start", index: 5, id: "c1", name: "Bash" };
      yield {
        type: "tool_call_end",
        index: 5,
        id: "c1",
        name: "Bash",
        arguments: { command: "ls" },
        argumentsJson: '{"command":"ls"}',
      };
      yield {
        type: "usage",
        usage: { input: 20, output: 9, totalTokens: 39, cacheRead: 8, cacheWrite: 2, cost: COST },
      };
      yield { type: "done", stopReason: "toolUse" };
    }
    const message = await collectAnthropicMessage(source(), { model: "claude-x", messageId: "msg_9" });
    expect(message).toEqual({
      id: "msg_9",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 },
    });
  });

  it("throws when the core stream fails", async () => {
    await expect(
      collectAnthropicMessage(throwingAfter([{ type: "text_start", index: 0 }]), {
        model: "m",
        messageId: "msg_1",
      }),
    ).rejects.toThrow("upstream boom");
  });

  it("ends as end_turn when the stream stops without done", async () => {
    async function* source(): AsyncGenerator<BridgeStreamEvent> {
      yield { type: "text_start", index: 0 };
      yield { type: "text_delta", index: 0, delta: "hi" };
    }
    const message = (await collectAnthropicMessage(source(), { model: "m", messageId: "msg_1" })) as {
      stop_reason: string;
      content: unknown;
    };
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("anthropicError", () => {
  it("defaults the error type by status", () => {
    expect(anthropicError(400, "bad")).toEqual({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    });
    expect(anthropicError(401, "no")?.body.error.type).toBe("authentication_error");
    expect(anthropicError(404, "no")?.body.error.type).toBe("not_found_error");
    expect(anthropicError(429, "no")?.body.error.type).toBe("rate_limit_error");
    expect(anthropicError(529, "no")?.body.error.type).toBe("overloaded_error");
    expect(anthropicError(500, "no")?.body.error.type).toBe("api_error");
  });

  it("keeps an explicit type", () => {
    expect(anthropicError(500, "no", "timeout_error")?.body.error.type).toBe("timeout_error");
  });
});
