// ABOUTME: The harness stream forwards host tools and renders Arnict thinking as a reasoning block.

import type { GenerateOptions, Message, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { StreamArnictOptions } from "ns-arnict-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ streamArnict: vi.fn() }));

vi.mock("ns-arnict-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ns-arnict-core")>();
  return {
    ...actual,
    streamArnict: core.streamArnict,
    ArnictAuthError: class ArnictAuthError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ArnictAuthError";
      }
    },
    ArnictApiError: class ArnictApiError extends Error {
      readonly status?: number;
      constructor(message: string, status?: number) {
        super(message);
        this.name = "ArnictApiError";
        this.status = status;
      }
    },
  };
});

import { ArnictAuthError } from "ns-arnict-core";
import { createArnictAdapter } from "../src/adapter.js";

let recorded: StreamArnictOptions | undefined;

const user = {
  id: "m1",
  source: { kind: "user" },
  role: "user",
  content: [{ type: "text", text: "ping" }],
} as unknown as Message;

function adapter() {
  return createArnictAdapter({ provider: "arnict", displayName: "Arnict" });
}

describe("Arnict adapter chat-completions stream", () => {
  beforeEach(() => {
    recorded = undefined;
    core.streamArnict.mockReset();
  });

  it("forwards the harness tool and renders thinking plus the tool call", async () => {
    core.streamArnict.mockImplementation(async function* (request: StreamArnictOptions) {
      recorded = request;
      yield { type: "thinking_start", index: 0 };
      yield { type: "thinking_delta", index: 0, delta: "Look" };
      yield { type: "thinking_end", index: 0, thinking: "Look" };
      yield { type: "tool_call_start", index: 1, id: "call_1", name: "ping" };
      yield {
        type: "tool_call_end",
        index: 1,
        id: "call_1",
        name: "ping",
        arguments: { value: "HOST-PING" },
        argumentsJson: '{"value":"HOST-PING"}',
      };
      yield {
        type: "usage",
        usage: {
          input: 80,
          output: 39,
          cacheRead: 128,
          totalTokens: 247,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      yield { type: "done", stopReason: "toolUse" };
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter().stream({
      provider: "arnict",
      model: "zai/glm-5.3-flash-uncensored",
      system: "be brief",
      reasoningEffort: "low",
      messages: [user],
      tools: [
        {
          name: "ping",
          description: "echo",
          parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        },
      ],
    } as unknown as GenerateOptions)) {
      chunks.push(chunk);
    }

    expect(recorded?.model).toBe("zai/glm-5.3-flash-uncensored");
    expect(recorded?.systemPrompt).toBe("be brief");
    expect(recorded?.effort).toBe("low");
    expect(recorded?.tools?.map((tool) => tool.name)).toEqual(["ping"]);
    expect(chunks).toContainEqual({ type: "reasoning-delta", index: 0, text: "Look" });
    expect(chunks).toContainEqual({
      type: "block-end",
      index: 1,
      block: { type: "tool-call", id: "call_1", name: "ping", arguments: '{"value":"HOST-PING"}' },
    });
    expect(chunks).toContainEqual({
      type: "usage",
      usage: {
        inputTokens: 80,
        outputTokens: 39,
        totalTokens: 247,
        cacheReadTokens: 128,
        cacheWriteTokens: 0,
      },
    });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
    // The core records the native 1,048,576 window itself; the standard window
    // the Harness compacts in must not reach the request.
    expect(recorded).not.toHaveProperty("contextWindow");
  });

  it("keys the usage ledger on the Harness session id", async () => {
    core.streamArnict.mockImplementation(async function* (request: StreamArnictOptions) {
      recorded = request;
      yield { type: "text_start", index: 0 };
      yield { type: "text_delta", index: 0, delta: "ok" };
      yield { type: "text_end", index: 0, text: "ok" };
      yield { type: "done", stopReason: "stop" };
    });
    for await (const _ of adapter().stream({
      provider: "arnict",
      model: "zai/glm-5.3-flash-uncensored",
      messages: [user],
      sessionId: "session-42",
    } as unknown as GenerateOptions)) {
      // drain
    }
    expect(recorded?.sessionId).toBe("session-42");
  });

  it("asks the user to add an API key when none is stored", async () => {
    core.streamArnict.mockImplementation(() => {
      throw new ArnictAuthError("Arnict API key not found. Set ARNICT_API_KEY or run `ns-bridge arnict login`.");
    });
    await expect(async () => {
      for await (const _chunk of adapter().stream({
        provider: "arnict",
        model: "zai/glm-5.3-flash-uncensored",
        messages: [user],
      } as unknown as GenerateOptions)) {
        // The failure is thrown before a chunk.
      }
    }).rejects.toMatchObject({ code: "AUTH" });
  });
});
