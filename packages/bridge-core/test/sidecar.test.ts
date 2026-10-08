// End-to-end: the Go sidecar's echo vendor, through the TypeScript client and
// both host bridges. Builds go/cmd/ns-bridge once; skipped when Go is absent.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { streamToDsh } from "../src/dsh/index.js";
import { streamToPi } from "../src/pi/index.js";
import {
  findPackagedSidecarBinary,
  isSidecarError,
  resolveSidecarBinary,
  SidecarError,
  sidecarStream,
} from "../src/sidecar/index.js";
import type { BridgeStreamEvent } from "../src/types.js";

const goModule = fileURLToPath(new URL("../../../go", import.meta.url));
const hasGo = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
const isWindows = process.platform === "win32";

let dir = "";
let bin = "";
let env: NodeJS.ProcessEnv = {};

beforeAll(() => {
  if (!hasGo) return;
  dir = mkdtempSync(join(tmpdir(), "ns-bridge-sidecar-"));
  bin = join(dir, isWindows ? "ns-bridge.exe" : "ns-bridge");
  execFileSync("go", ["build", "-o", bin, "./cmd/ns-bridge"], { cwd: goModule, stdio: "inherit" });
  env = { ...process.env, NS_BRIDGE_BIN: bin };
}, 180_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function userSays(text: string, echo: Record<string, unknown> = {}) {
  return { messages: [{ role: "user", content: [{ type: "text", text }] }], echo };
}

async function drain(events: AsyncIterable<BridgeStreamEvent>): Promise<BridgeStreamEvent[]> {
  const out: BridgeStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

class FakePiStream {
  events: Array<Record<string, unknown>> = [];
  done: Promise<void>;
  private resolve!: () => void;
  constructor() {
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  push(event: unknown) {
    this.events.push(structuredClone(event) as Record<string, unknown>);
  }
  end() {
    this.resolve();
  }
}

const model = { id: "echo-1", api: "echo-api", provider: "echo" };

describe("resolveSidecarBinary", () => {
  const packaged = () => ({ path: "/pkg/ns-bridge" });
  const missing = () => ({ error: "ns-bridge-bin is not installed" });

  it("prefers NS_BRIDGE_BIN, then the explicit path, then ns-bridge-bin, then ns-bridge on PATH", () => {
    expect(resolveSidecarBinary("/opt/x", { NS_BRIDGE_BIN: "/env/ns-bridge" }, { packaged })).toBe("/env/ns-bridge");
    expect(resolveSidecarBinary("/opt/x", { NS_BRIDGE_BIN: "  " }, { packaged })).toBe("/opt/x");
    expect(resolveSidecarBinary(undefined, {}, { packaged })).toBe("/pkg/ns-bridge");
    expect(resolveSidecarBinary(undefined, {}, { packaged: missing })).toBe("ns-bridge");
  });

  it("finds the binary ns-bridge-bin installed, or says why not", () => {
    const found = findPackagedSidecarBinary();
    if ("path" in found) {
      expect(found.path).toMatch(/bridge-bin-[a-z0-9]+-[a-z0-9]+[/\\]bin[/\\]ns-bridge(\.exe)?$/);
    } else {
      // A checkout that has not run scripts/build-sidecar.mjs links the package without a binary.
      expect(found.error).toMatch(/ns-bridge-bin/);
    }
  });
});

describe.skipIf(!hasGo)("sidecarStream (Go echo vendor)", () => {
  it("streams through streamToDsh", async () => {
    const chunks: unknown[] = [];
    for await (const chunk of streamToDsh(sidecarStream("echo", userSays("hi there"), { env }))) chunks.push(chunk);
    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "echo: " },
      { type: "text-delta", index: 0, text: "hi " },
      { type: "text-delta", index: 0, text: "there" },
      { type: "block-end", index: 0, block: { type: "text", text: "echo: hi there" } },
      {
        type: "usage",
        usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  });

  it("keeps the model's raw tool-call JSON for the Harness", async () => {
    const raw = '{"path":"a.ts","n":1e3,"z":1,"a":2}';
    const chunks: Array<Record<string, unknown>> = [];
    const request = userSays("go", { toolCall: { id: "c1", name: "read", arguments: JSON.parse(raw) } });
    for await (const chunk of streamToDsh(sidecarStream("echo", request, { env }))) {
      chunks.push(chunk as unknown as Record<string, unknown>);
    }
    const end = chunks.find(
      (chunk) => chunk.type === "block-end" && (chunk.block as { type: string }).type === "tool-call",
    );
    expect(end).toMatchObject({ block: { type: "tool-call", id: "c1", name: "read" } });
    expect(JSON.parse((end as { block: { arguments: string } }).block.arguments)).toEqual(JSON.parse(raw));
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
  });

  it("streams through streamToPi: thinking, text, tool call, usage, done", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakePiStream(),
      events: () =>
        sidecarStream(
          "echo",
          userSays("hello", {
            thinking: "let me think",
            thinkingSignature: "sig-1",
            toolCall: { id: "c1", name: "read", arguments: { path: "README.md" } },
            responseId: "resp-1",
          }),
          { env },
        ),
    });
    await stream.done;
    const types = stream.events.map((event) => event.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("thinking_end");
    expect(types).toContain("text_end");
    expect(types.slice(-2)).toEqual(["toolcall_end", "done"]);
    const done = stream.events.at(-1) as { reason: string; message: Record<string, unknown> };
    expect(done.reason).toBe("toolUse");
    expect(done.message).toMatchObject({
      provider: "echo",
      model: "echo-1",
      responseId: "resp-1",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "let me think", thinkingSignature: "sig-1" },
        { type: "text", text: "echo: hello" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
      ],
    });
    expect((done.message.usage as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
  });

  it("raises the binary's terminal error as a typed SidecarError, after the partial output", async () => {
    const events: BridgeStreamEvent[] = [];
    const request = userSays("x", {
      error: { kind: "rate_limit", message: "slow down", status: 429, retryAfterMs: 1500, reasonCode: "THROTTLED" },
    });
    const failure = await (async () => {
      for await (const event of sidecarStream("echo", request, { env })) events.push(event);
    })().catch((error: unknown) => error);
    expect(isSidecarError(failure)).toBe(true);
    expect(failure).toMatchObject({
      kind: "rate_limit",
      message: "slow down",
      vendor: "echo",
      status: 429,
      retryAfterMs: 1500,
      reasonCode: "THROTTLED",
    });
    expect(events.map((event) => event.type)).toContain("text_end");
  });

  it("turns a terminal error into a Pi error event", async () => {
    const stream = streamToPi({
      model,
      createStream: () => new FakePiStream(),
      events: () => sidecarStream("echo", userSays("x", { error: { kind: "auth", message: "no session" } }), { env }),
    });
    await stream.done;
    expect(stream.events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { stopReason: "error", errorMessage: "no session" },
    });
  });

  it("reports protocol-level refusals from the binary", async () => {
    await expect(drain(sidecarStream("no-such-vendor", userSays("x"), { env }))).rejects.toMatchObject({
      kind: "unsupported",
      vendor: "no-such-vendor",
    });
  });

  it("aborts a call in flight", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const events: BridgeStreamEvent[] = [];
    const failure = await (async () => {
      for await (const event of sidecarStream("echo", userSays("x", { hang: true }), {
        env,
        signal: controller.signal,
      })) {
        events.push(event);
        controller.abort();
      }
    })().catch((error: unknown) => error);
    expect(events.map((event) => event.type)).toEqual(["start"]);
    expect((failure as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("marks an aborted Pi turn as aborted", async () => {
    const controller = new AbortController();
    const stream = streamToPi({
      model,
      createStream: () => new FakePiStream(),
      signal: controller.signal,
      events: () => sidecarStream("echo", userSays("x", { hang: true }), { env, signal: controller.signal }),
    });
    setTimeout(() => controller.abort(), 50);
    await stream.done;
    expect(stream.events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("rejects at once when the signal is already aborted", async () => {
    await expect(
      drain(sidecarStream("echo", userSays("x"), { env, signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the process when the consumer stops early", async () => {
    const started = Date.now();
    for await (const event of sidecarStream("echo", userSays("x", { hang: true }), { env })) {
      expect(event.type).toBe("start");
      break;
    }
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("uses the explicit binary when NS_BRIDGE_BIN is unset", async () => {
    const { NS_BRIDGE_BIN: _unset, ...rest } = env;
    const events = await drain(sidecarStream("echo", userSays("x"), { env: rest, binary: bin }));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });
});

describe("sidecarStream failures outside the protocol", () => {
  it("reports a missing binary as unavailable", async () => {
    const failure = await drain(
      sidecarStream("echo", {}, { env: { ...process.env, NS_BRIDGE_BIN: "/nonexistent/ns-bridge" } }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SidecarError);
    expect(failure).toMatchObject({ kind: "unavailable" });
    expect((failure as Error).message).toContain("NS_BRIDGE_BIN");
  });

  it.skipIf(isWindows)("reports a binary that dies without a terminal line as crashed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ns-bridge-fake-"));
    try {
      const fake = join(scratch, "ns-bridge");
      writeFileSync(fake, '#!/bin/sh\necho \'{"type":"start"}\'\necho "boom: segfault-ish" >&2\nexit 3\n');
      chmodSync(fake, 0o755);
      const events: BridgeStreamEvent[] = [];
      const failure = await (async () => {
        for await (const event of sidecarStream("echo", {}, { env: { ...process.env, NS_BRIDGE_BIN: fake } })) {
          events.push(event);
        }
      })().catch((error: unknown) => error);
      expect(events).toEqual([{ type: "start" }]);
      expect(failure).toMatchObject({ kind: "crashed", exitCode: 3, stderr: "boom: segfault-ish" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows).each([
    ["a clean exit without done", 'echo \'{"type":"start"}\'', "without a done event"],
    ["a line that is not JSON", "echo 'not json'", "not JSON"],
  ])("reports %s as a protocol error", async (_name, body, message) => {
    const scratch = mkdtempSync(join(tmpdir(), "ns-bridge-fake-"));
    try {
      const fake = join(scratch, "ns-bridge");
      writeFileSync(fake, `#!/bin/sh\n${body}\n`);
      chmodSync(fake, 0o755);
      const failure = await drain(sidecarStream("echo", {}, { env: { ...process.env, NS_BRIDGE_BIN: fake } })).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ kind: "protocol" });
      expect((failure as Error).message).toContain(message);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
