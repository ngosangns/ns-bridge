import { describe, expect, it } from "vitest";

import { getCurrentSystemPrompt, getCurrentTools, withoutInitialSystemMessage } from "../src/compat/transcript.js";

const tool = (name: string, description = name) => ({ name, description, parameters: { type: "object" } });

describe("Pi 1.0 transcript helpers", () => {
  const piTranscript = [
    { role: "system", content: "base prompt", toolsAdded: [tool("read"), tool("bash")], timestamp: 0 },
    { role: "user", content: "hi", timestamp: 1 },
    { role: "system", content: [{ type: "text", text: "later note" }], toolsRemoved: [{ name: "bash" }], toolsAdded: [tool("edit")], sections: { env: "cwd=/x" }, timestamp: 2 },
    { role: "assistant", content: [], timestamp: 3 },
  ];

  it("replays system messages into the current prompt and tool set", () => {
    expect(getCurrentSystemPrompt(piTranscript)).toBe("base prompt\n\nlater note\n\ncwd=/x");
    expect(getCurrentTools<{ name: string }>(piTranscript).map((t) => t.name)).toEqual(["read", "edit"]);
  });

  it("drops only a leading system message", () => {
    expect(withoutInitialSystemMessage(piTranscript)).toHaveLength(3);
    expect(withoutInitialSystemMessage(piTranscript)[0]?.role).toBe("user");
    const noLeading = piTranscript.slice(1);
    expect(withoutInitialSystemMessage(noLeading)).toBe(noLeading);
  });

  it("section null removes a previously set section", () => {
    const msgs = [
      { role: "system", content: "p", sections: { a: "A", b: "B" } },
      { role: "system", content: "", sections: { a: null } },
    ];
    expect(getCurrentSystemPrompt(msgs)).toBe("p\n\nB");
  });

  it("is inert on OMP transcripts (no system messages)", () => {
    const omp = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [] },
      { role: "toolResult", content: [] },
    ];
    expect(getCurrentSystemPrompt(omp)).toBe("");
    expect(getCurrentTools(omp)).toEqual([]);
    expect(withoutInitialSystemMessage(omp)).toBe(omp);
  });
});
