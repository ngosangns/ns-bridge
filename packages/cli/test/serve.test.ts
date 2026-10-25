import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicBackend } from "ns-bridge-core/anthropic";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Runner, run } from "../src/cli.js";
import { isLoopbackHost, type RunServeOptions, runServe, type ServeBundle } from "../src/serve.js";

/** A port the OS says is free; a small race remains, which a test can live with. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = netCreateServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    log: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
  };
}

const noopBackends: Record<"kiro" | "devin" | "grok" | "arnict", AnthropicBackend> = {
  kiro: { listModels: () => [], stream: () => (async function* () {})() },
  devin: { listModels: () => [], stream: () => (async function* () {})() },
  grok: { listModels: () => [], stream: () => (async function* () {})() },
  arnict: { listModels: () => [], stream: () => (async function* () {})() },
};

function fakeBundle(overrides: Partial<ServeBundle> = {}): ServeBundle {
  return {
    createBundledBackends: () => noopBackends,
    createAnthropicServer: () =>
      createServer((_req, res) => {
        res.destroy();
      }),
    setUsageHost: () => {},
    ...overrides,
  };
}

const tempDirs: string[] = [];

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ns-bridge-serve-"));
  tempDirs.push(dir);
  return join(dir, "zcode.json");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("serve host check", () => {
  it("treats loopback spellings as loopback", () => {
    for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "example.com", "192.168.1.4", "127.0.0.1.evil.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("runServe", () => {
  function baseOptions(io: ReturnType<typeof capture>, over: Partial<RunServeOptions> = {}): RunServeOptions {
    return { port: 0, host: "127.0.0.1", configPath: tempConfigPath(), log: io.log, err: io.err, ...over };
  }

  it("refuses a non-loopback host before touching the config or the bundle", async () => {
    const io = capture();
    const loader = vi.fn(async () => fakeBundle());
    const code = await runServe({ host: "0.0.0.0", log: io.log, err: io.err, loadBundle: loader });
    expect(code).toBe(1);
    expect(io.stderr[0]).toContain("not a loopback address");
    expect(io.stderr[0]).toContain("--allow-remote");
    expect(loader).not.toHaveBeenCalled();
  });

  it("binds a non-loopback host only with allowRemote", async () => {
    const controller = new AbortController();
    const io = capture();
    const run = runServe(
      baseOptions(io, {
        host: "0.0.0.0",
        allowRemote: true,
        signal: controller.signal,
        loadBundle: async () => fakeBundle(),
      }),
    );
    controller.abort();
    expect(await run).toBe(0);
    expect(io.stdout[0]).toContain("ns-bridge serve listening on http://0.0.0.0:");
  });

  it("starts, prints the listening line, and resolves when the signal aborts", async () => {
    const controller = new AbortController();
    const setUsageHost = vi.fn();
    const io = capture();
    const run = runServe(
      baseOptions(io, { signal: controller.signal, loadBundle: async () => fakeBundle({ setUsageHost }) }),
    );
    controller.abort();
    expect(await run).toBe(0);
    expect(setUsageHost).toHaveBeenCalledWith("zcode");
    expect(io.stdout[0]).toMatch(
      /^ns-bridge serve listening on http:\/\/127\.0\.0\.1:\d+ \(kiro, devin, grok, arnict\)$/,
    );
  });

  it("never prints the generated token", async () => {
    const controller = new AbortController();
    const io = capture();
    const configPath = tempConfigPath();
    const run = runServe(
      baseOptions(io, { signal: controller.signal, configPath, loadBundle: async () => fakeBundle() }),
    );
    controller.abort();
    await run;
    const token = (JSON.parse(readFileSync(configPath, "utf8")) as { token: string }).token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect([...io.stdout, ...io.stderr].join("\n")).not.toContain(token);
  });

  it("reports a bundle that cannot load", async () => {
    const io = capture();
    const code = await runServe(
      baseOptions(io, {
        loadBundle: async () => {
          throw new Error("no bundle");
        },
      }),
    );
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("could not load the provider bundle");
    expect(io.stderr.join("\n")).toContain("no bundle");
  });
});

describe("ns-bridge serve", () => {
  it("refuses a non-loopback host without --allow-remote", async () => {
    const io = capture();
    const loader = vi.fn(async () => fakeBundle());
    const code = await run(["serve", "--host", "0.0.0.0"], { ...io, serveBundleLoader: loader });
    expect(code).toBe(1);
    expect(io.stderr[0]).toContain("not a loopback address");
    expect(loader).not.toHaveBeenCalled();
  });

  it("binds a remote host with --allow-remote and stops on SIGTERM", async () => {
    const io = capture();
    const port = await freePort();
    const done = run(["serve", "--host", "0.0.0.0", "--allow-remote", "--port", String(port)], {
      ...io,
      serveBundleLoader: async () => fakeBundle(),
      serveConfigPath: tempConfigPath(),
    });
    await vi.waitFor(() => expect(io.stdout[0]).toContain(`listening on http://0.0.0.0:${port}`));
    process.emit("SIGTERM", "SIGTERM");
    expect(await done).toBe(0);
  });

  it("validates its flags", async () => {
    const loader = vi.fn(async () => fakeBundle());
    for (const argv of [
      ["serve", "extra"],
      ["serve", "--port", "0"],
      ["serve", "--port", "99999"],
      ["serve", "--port", "abc"],
      ["serve", "--host"],
      ["serve", "--unknown"],
    ]) {
      const fresh = capture();
      expect(await run(argv, { ...fresh, serveBundleLoader: loader })).toBe(1);
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it("prints the serve usage in help", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect(await run(["help"], { ...io, runner })).toBe(0);
    expect(io.stdout.join("\n")).toContain("ns-bridge serve [--port N] [--host H] [--allow-remote]");
    expect(io.stdout.join("\n")).toContain("~/.ns-bridge/zcode.json");
  });
});

describe("bundled backends", () => {
  it("lists the arnict catalog models from NS_ARNICT_CATALOG_CACHE_DIR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-serve-arnict-"));
    tempDirs.push(dir);
    // The row shape the arnict cache writes: standard window, native window,
    // and the compaction budget ns-core-utils derives.
    writeFileSync(
      join(dir, "arnict.models.json"),
      JSON.stringify({
        fetchedAt: 1,
        models: [
          {
            id: "zai/glm-5.3-flash-uncensored",
            name: "GLM 5.3 Flash Abliterated",
            contextWindow: 400_000,
            nativeContextWindow: 1_048_576,
            maxTokens: 131_072,
            reasoning: true,
            input: ["text", "image"],
            compaction: { reserveTokens: 16_384, thresholdTokens: 383_616 },
          },
          {
            id: "zai/glm-5.3-uncensored",
            name: "GLM 5.3 Abliterated",
            contextWindow: 400_000,
            nativeContextWindow: 1_048_576,
            maxTokens: 131_072,
            reasoning: true,
            input: ["text"],
            compaction: { reserveTokens: 16_384, thresholdTokens: 383_616 },
          },
        ],
      }),
    );
    vi.stubEnv("NS_ARNICT_CATALOG_CACHE_DIR", dir);
    try {
      const { createBundledBackends } = await import("../src/serve-entry.js");
      expect(createBundledBackends().arnict.listModels()).toEqual([
        { id: "zai/glm-5.3-flash-uncensored", name: "GLM 5.3 Flash Abliterated" },
        { id: "zai/glm-5.3-uncensored", name: "GLM 5.3 Abliterated" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
