import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bridgeEngineSetting,
  DEFAULT_BRIDGE_ENGINE,
  engineStream,
  SidecarError,
  selectBridgeEngine,
  sidecarBinaryAvailable,
} from "../src/sidecar/index.js";

const dir = mkdtempSync(join(tmpdir(), "ns-bridge-engine-"));
const fakeBin = join(dir, "ns-bridge");
writeFileSync(fakeBin, "");
// A binary too old for the request: it answers with an `unsupported` error.
const oldBin = join(dir, "ns-bridge-old");
writeFileSync(
  oldBin,
  `#!/bin/sh\nread -r line\necho '{"type":"error","error":{"kind":"unsupported","message":"unknown vendor"}}'\nexit 1\n`,
);
chmodSync(oldBin, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function* inProcess() {
  yield { type: "start" as const };
  yield { type: "done" as const, stopReason: "stop" as const };
}

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("engine selection", () => {
  it("defaults to auto: Go when a binary is installed", () => {
    expect(DEFAULT_BRIDGE_ENGINE).toBe("auto");
    expect(selectBridgeEngine("kiro", { NS_BRIDGE_BIN: fakeBin, PATH: "" })).toBe("go");
    expect(selectBridgeEngine("kiro", { NS_BRIDGE_BIN: fakeBin, PATH: "", NS_BRIDGE_ENGINE: "ts" })).toBe("ts");
  });

  it.skipIf(process.platform === "win32")("auto falls back when the binary is too old for the vendor", async () => {
    const env = { PATH: process.env.PATH, NS_BRIDGE_BIN: oldBin };
    const events = await drain(
      engineStream({ vendor: "echo", request: () => ({}), inProcess, env, sidecar: { stderr: false } }),
    );
    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
    await expect(
      drain(
        engineStream({
          vendor: "echo",
          request: () => ({}),
          inProcess,
          env: { ...env, NS_BRIDGE_ENGINE: "go" },
          sidecar: { stderr: false },
        }),
      ),
    ).rejects.toSatisfy((error) => error instanceof SidecarError && error.kind === "unsupported");
  });

  it("reads NS_BRIDGE_ENGINE, with a per-vendor override", () => {
    expect(bridgeEngineSetting("kiro", {})).toBe(DEFAULT_BRIDGE_ENGINE);
    expect(bridgeEngineSetting("kiro", { NS_BRIDGE_ENGINE: "go" })).toBe("go");
    expect(bridgeEngineSetting("kiro", { NS_BRIDGE_ENGINE: "TypeScript" })).toBe("ts");
    expect(bridgeEngineSetting("kiro", { NS_BRIDGE_ENGINE: "go", NS_BRIDGE_ENGINE_KIRO: "ts" })).toBe("ts");
    expect(bridgeEngineSetting("devin", { NS_BRIDGE_ENGINE: "go", NS_BRIDGE_ENGINE_KIRO: "ts" })).toBe("go");
    expect(bridgeEngineSetting("kiro", { NS_BRIDGE_ENGINE: "bogus" })).toBe(DEFAULT_BRIDGE_ENGINE);
  });

  it("resolves auto from whether a binary exists", () => {
    const missing = { NS_BRIDGE_ENGINE: "auto", NS_BRIDGE_BIN: join(dir, "nope"), PATH: "" };
    expect(sidecarBinaryAvailable(missing)).toBe(false);
    expect(selectBridgeEngine("devin", missing)).toBe("ts");
    const present = { NS_BRIDGE_ENGINE: "auto", NS_BRIDGE_BIN: fakeBin, PATH: "" };
    expect(selectBridgeEngine("devin", present)).toBe("go");
    expect(selectBridgeEngine("devin", { ...present, NS_BRIDGE_ENGINE: "ts" })).toBe("ts");
  });

  it("falls back to the in-process core only for auto", async () => {
    const env = { PATH: "", NS_BRIDGE_BIN: join(dir, "missing-binary") };
    const events = await drain(
      engineStream({
        vendor: "echo",
        request: () => ({}),
        inProcess,
        env,
        engine: undefined,
        sidecar: { stderr: false },
      }),
    );
    // NS_BRIDGE_BIN names a missing file, so auto picks the TS core outright.
    expect(events.map((e) => e.type)).toEqual(["start", "done"]);

    const autoEnv = { PATH: "", NS_BRIDGE_ENGINE: "auto", NS_BRIDGE_BIN: fakeBin };
    // The binary "exists" but cannot start (empty file): auto falls back.
    const fallback = await drain(engineStream({ vendor: "echo", request: () => ({}), inProcess, env: autoEnv }));
    expect(fallback.map((e) => e.type)).toEqual(["start", "done"]);

    const goEnv = { ...autoEnv, NS_BRIDGE_ENGINE: "go" };
    await expect(drain(engineStream({ vendor: "echo", request: () => ({}), inProcess, env: goEnv }))).rejects.toSatisfy(
      (error) => error instanceof SidecarError && error.kind === "unavailable",
    );
    const mapped = engineStream({
      vendor: "echo",
      request: () => ({}),
      inProcess,
      env: goEnv,
      mapError: (error) => new Error(`mapped ${error.kind}`),
    });
    await expect(drain(mapped)).rejects.toThrow("mapped unavailable");
  });
});
