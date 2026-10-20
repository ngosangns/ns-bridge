import { describe, expect, it } from "vitest";
import { buildResponsesBody } from "../src/request.js";

const ping = {
  name: "ping",
  description: "echo a value",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

describe("Responses request body", () => {
  it("sends the host tool and leaves Grok's own tools out", () => {
    const body = buildResponsesBody({
      model: "grok-4.7-agent",
      systemPrompt: "be brief",
      effort: "low",
      tools: [ping],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "SECRET-THOUGHT" },
            { type: "text", text: "ok" },
            { type: "toolCall", id: "call_1", name: "ping", arguments: { value: "a" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "ping",
          isError: false,
          content: [{ type: "text", text: "a" }],
        },
        {
          role: "user",
          content: [{ type: "image", data: "aaaa", mimeType: "image/png" }],
        },
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    });

    const encoded = JSON.stringify(body);
    expect(body.model).toBe("grok-4.7");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("be brief");
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body.tools).toEqual([{ type: "function", ...ping }]);
    expect(encoded).not.toContain("read_file");
    expect(encoded).not.toContain("SECRET-THOUGHT");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call", call_id: "call_1", name: "ping", arguments: '{"value":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "a" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,aaaa" }],
      },
    ]);
  });

  it("omits reasoning when the host turned it off", () => {
    const body = buildResponsesBody({
      model: "grok-4.5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBeUndefined();
  });
});
