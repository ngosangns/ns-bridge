// ABOUTME: The harness stream forwards host tools and renders Grok thinking as a reasoning block.

import type { GenerateOptions, Message, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { StreamGrokOptions } from "ns-grok-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ streamGrok: vi.fn() }));

vi.mock("ns-grok-core", () => ({
  streamGrok: core.streamGrok,
  GrokAuthError: class GrokAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GrokAuthError";
    }
  },
  GrokApiError: class GrokApiError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "GrokApiError";
      this.status = status;
    }
  },
}));

import { GrokAuthError } from "ns-grok-core";
import { createGrokAdapter } from "../src/adapter.js";

let recorded: StreamGrokOptions | undefined;

const user = {
  id: "m1",
  source: { kind: "user" },
  role: "user",
  content: [{ type: "text", text: "ping" }],
} as unknown as Message;

function adapter() {
  return createGrokAdapter({ provider: "grok", displayName: "Grok" });
}

describe("Grok adapter responses stream", () => {
  beforeEach(() => {
    recorded = undefined;
    core.streamGrok.mockReset();
  });

  it("forwards the harness tool and renders thinking plus the tool call", async () => {
    core.streamGrok.mockImplementation(async function* (request: StreamGrokOptions) {
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
      provider: "grok",
      model: "grok-4.7",
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

    expect(recorded?.model).toBe("grok-4.7");
    expect(recorded?.systemPrompt).toBe("be brief");
    expect(recorded?.effort).toBe("low");
    expect(recorded?.tools?.map((tool) => tool.name)).toEqual(["ping"]);
    expect(JSON.stringify(recorded?.tools)).not.toContain("read_file");
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
  });

  it("asks the user to log in when the CLI session is missing", async () => {
    core.streamGrok.mockImplementation(() => {
      throw new GrokAuthError("Grok CLI is not signed in. Run `grok login`.");
    });
    await expect(async () => {
      for await (const _chunk of adapter().stream({
        provider: "grok",
        model: "grok-4.7",
        messages: [user],
      } as unknown as GenerateOptions)) {
        // The failure is thrown before a chunk.
      }
    }).rejects.toMatchObject({ code: "AUTH" });
  });
});
