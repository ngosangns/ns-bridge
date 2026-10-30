import { describe, expect, it } from "vitest";
import { streamQoder } from "../src/stream.js";
import type { QoderStreamEvent } from "../src/types.js";

const AUTH = { mode: "pat" as const, token: "test-token" };
const MESSAGES = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

function frame(delta: Record<string, unknown>, finish: string | null = null): unknown {
  return {
    id: "chatcmpl-test",
    model: "dfmodel",
    choices: [{ delta, finish_reason: finish, index: 0 }],
  };
}

function wireText(frames: readonly string[]): string {
  return `${frames.map((entry) => `data: ${entry}\n\n`).join("")}data: [DONE]\n\n`;
}

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function collect(text: string, chunkSize = 4096): Promise<QoderStreamEvent[]> {
  const events: QoderStreamEvent[] = [];
  for await (const event of streamQoder({
    model: "dfmodel",
    messages: MESSAGES,
    auth: AUTH,
    fetchImpl: async () => new Response(chunked(text, chunkSize), { status: 200 }),
  })) {
    events.push(event);
  }
  return events;
}

function textOf(events: readonly QoderStreamEvent[], type: "text_delta" | "thinking_delta"): string {
  return events
    .filter((event): event is Extract<QoderStreamEvent, { type: typeof type }> => event.type === type)
    .map((event) => event.delta)
    .join("");
}

describe("qoder wire stream", () => {
  it("recovers a frame the server wrapped with a raw newline inside a string", async () => {
    const reasoning = JSON.stringify(frame({ reasoning_content: "We need exact strings" }));
    // The model server wraps long frames and can split a JSON string, which is
    // invalid JSON until the injected control character is removed.
    const content1 = JSON.stringify(frame({ content: "packages/editors/viclass && ngosa" })).replace(
      "packages/editors",
      "pack\nages/editors",
    );
    const content2 = JSON.stringify(frame({ content: "ngns 2>&1 | head -100" }));
    const callStart = JSON.stringify(
      frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command": ' } }] }),
    );
    const callArgs1 = JSON.stringify(
      frame({ tool_calls: [{ index: 0, function: { arguments: '"echo \\"packages/editors' } }] }),
    ).replace("packages/editors", "pack\nages/editors");
    const callArgs2 = JSON.stringify(
      frame({ tool_calls: [{ index: 0, function: { arguments: '/viclass && ngosangns 2>&1 | head -100\\""}' } }] }),
    );
    const finish = JSON.stringify(frame({}, "tool_calls"));

    const events = await collect(wireText([reasoning, content1, content2, callStart, callArgs1, callArgs2, finish]));

    expect(textOf(events, "thinking_delta")).toBe("We need exact strings");
    expect(textOf(events, "text_delta")).toBe("packages/editors/viclass && ngosangns 2>&1 | head -100");
    expect(events.find((event) => event.type === "tool_call_end")).toMatchObject({
      type: "tool_call_end",
      name: "bash",
      arguments: { command: 'echo "packages/editors/viclass && ngosangns 2>&1 | head -100"' },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "toolUse" });
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const events = await collect(
      wireText([
        JSON.stringify(frame({ reasoning_content: "think " })),
        JSON.stringify(frame({ reasoning_content: "then act" })),
        JSON.stringify(frame({ content: "ok" })),
        JSON.stringify(frame({}, "stop")),
      ]),
      7,
    );
    expect(textOf(events, "thinking_delta")).toBe("think then act");
    expect(textOf(events, "text_delta")).toBe("ok");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });
});
