import { describe, expect, it } from "vitest";
import { buildQoderPrompt, collectQoderImages, qoderImageData } from "../src/prompt.js";

describe("buildQoderPrompt", () => {
  it("includes system, user, assistant tool call, and tool result", () => {
    const prompt = buildQoderPrompt(
      [
        { role: "user", content: [{ type: "text", text: "Run read" }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }],
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
    expect(prompt).toContain("<system>");
    expect(prompt).toContain("You are helpful");
    expect(prompt).toContain("tool_call read");
    expect(prompt).toContain("file body");
  });

  it("keeps image bytes beside the text prompt", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Look" },
          { type: "image" as const, mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    ];
    expect(buildQoderPrompt(messages)).toContain("[image attached]");
    expect(buildQoderPrompt(messages)).not.toContain("aGVsbG8=");
    expect(collectQoderImages(messages)).toEqual([{ mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" }]);
    expect(qoderImageData("data:image/png;base64,aGVsbG8=")).toBe("aGVsbG8=");
  });
});
