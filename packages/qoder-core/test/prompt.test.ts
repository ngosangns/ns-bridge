import { describe, expect, it } from "vitest";
import { toQoderWireMessages } from "../src/prompt.js";

describe("toQoderWireMessages", () => {
  it("maps system, user, assistant tool call, and tool result", () => {
    const messages = toQoderWireMessages(
      [
        { role: "user", content: [{ type: "text", text: "Run read" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file body" }],
        },
      ],
      "You are helpful",
    );
    expect(messages).toEqual([
      { role: "system", content: [{ type: "text", text: "You are helpful" }] },
      { role: "user", content: "Run read" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ]);
  });

  it("sends images beside text as parts, reusing data URLs", () => {
    const messages = toQoderWireMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    });
  });

  it("keeps assistant text as content and skips empty messages", () => {
    const messages = toQoderWireMessages([
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "only thoughts" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
    ]);
    expect(messages).toEqual([{ role: "assistant", content: "Done" }]);
  });
});
