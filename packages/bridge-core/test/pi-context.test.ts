import { describe, expect, it } from "vitest";
import { resolveSystemPrompt, resolveTools, toBridgeContext, toBridgeMessages } from "../src/pi/index.js";

const tool = (name: string) => ({ name, description: `${name} tool`, parameters: { type: "object" } });

describe("toBridgeContext", () => {
  it("reads a Pi 1.x transcript: system messages carry the prompt and tool deltas", () => {
    const context = {
      messages: [
        {
          role: "system",
          content: "base prompt",
          sections: { env: "<env/>" },
          toolsAdded: [tool("read"), tool("bash")],
        },
        { role: "user", content: "hi" },
        { role: "system", content: "", toolsRemoved: [{ name: "bash" }], sections: { env: null } },
      ],
    };
    const out = toBridgeContext(context);
    expect(out.systemPrompt).toBe("base prompt");
    expect(out.tools?.map((t) => t.name)).toEqual(["read"]);
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("reads an OMP context: systemPrompt array, explicit tools, developer turns", () => {
    const out = toBridgeContext({
      systemPrompt: ["one", "", "two"],
      tools: [tool("edit")],
      messages: [{ role: "developer", content: "reminder" }],
    });
    expect(out.systemPrompt).toBe("one\n\ntwo");
    expect(out.tools).toEqual([{ name: "edit", description: "edit tool", parameters: { type: "object" } }]);
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "reminder" }] }]);
  });

  it("prefers explicit tools over transcript tools and omits empty prompts", () => {
    const context = { tools: [tool("a")], messages: [{ role: "system", content: "", toolsAdded: [tool("b")] }] };
    expect(resolveTools(context).map((t) => t.name)).toEqual(["a"]);
    expect(resolveSystemPrompt({ messages: [] })).toBeUndefined();
  });
});

describe("toBridgeMessages", () => {
  it("keeps thinking signatures, parses string tool arguments, and pairs tool results", () => {
    const out = toBridgeMessages([
      {
        role: "assistant",
        stopReason: "toolUse",
        responseId: "r1",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
          { type: "redactedThinking", data: "x" },
          { type: "toolCall", id: "c1", name: "read", arguments: '{"path":"a"}' },
          { type: "toolCall", id: "c2", name: "read", arguments: "{broken" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ]);
    expect(out[0]).toEqual({
      role: "assistant",
      stopReason: "toolUse",
      responseId: "r1",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "c2", name: "read", arguments: {} },
      ],
    });
    expect(out[1]).toEqual({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
  });

  it("carries images as base64 user content", () => {
    const out = toBridgeMessages([{ role: "user", content: [{ type: "image", data: "AAA", mimeType: "image/png" }] }]);
    expect(out).toEqual([{ role: "user", content: [{ type: "image", data: "AAA", mimeType: "image/png" }] }]);
  });
});
