import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ spawn: vi.fn() }));
const core = vi.hoisted(() => ({ streamGrok: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: child.spawn }));
vi.mock("ns-grok-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ns-grok-core")>();
  return { ...actual, streamGrok: core.streamGrok };
});

import { streamGrokForPi } from "../src/grok/provider.js";

const model = { id: "grok-4.7", api: "grok-cli", provider: "grok", name: "Grok" } as Model<Api>;

describe("api grok mode", () => {
  beforeEach(() => {
    child.spawn.mockReset();
    core.streamGrok.mockReset();
  });

  it("calls the Responses client with the host tool and does not spawn grok", async () => {
    let request: { model?: string; tools?: Array<{ name: string }>; messages?: unknown[] } | undefined;
    core.streamGrok.mockImplementation(async function* (options: {
      model: string;
      tools?: Array<{ name: string }>;
      messages: unknown[];
    }) {
      request = options;
      yield { type: "start" };
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
      };
      yield { type: "done", stopReason: "toolUse" };
    });

    const context = {
      systemPrompt: "be brief",
      tools: [{ name: "ping", description: "echo", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: "ping" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "SECRET-THOUGHT" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    } as unknown as Context;

    const output = await streamGrokForPi(model, context, { reasoning: "low" }).result();
    expect(child.spawn).not.toHaveBeenCalled();
    expect(request?.model).toBe("grok-4.7");
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["ping"]);
    expect(JSON.stringify(request?.tools)).not.toContain("read_file");
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toContainEqual({ type: "thinking", thinking: "Look" });
    expect(output.content).toContainEqual({
      type: "toolCall",
      id: "call_1",
      name: "ping",
      arguments: { value: "HOST-PING" },
    });
  });
});
