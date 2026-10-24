import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devinModels } from "ns-devin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const wrap = (name: keyof typeof child) => {
    child[name].mockImplementation((...args: unknown[]) => (actual[name] as (...inner: unknown[]) => unknown)(...args));
  };
  wrap("execFile");
  wrap("execFileSync");
  wrap("execSync");
  wrap("spawn");
  wrap("spawnSync");
  return { ...actual, ...child };
});

vi.mock("ns-kiro-core", async () => {
  const actual = await vi.importActual<typeof import("ns-kiro-core")>("ns-kiro-core");
  return {
    ...actual,
    // A credential refresh is the startup wait. These must not be awaited
    // while the host is still loading the extension.
    resolveKiroCredentials: () => new Promise(() => {}),
    updateKiroModelsCache: () => new Promise(() => {}),
  };
});

import { registerDevinProvider } from "../src/devin/register.js";
import { registerGrokProvider } from "../src/grok/register.js";
import { registerKiroProvider } from "../src/kiro/register.js";

const envKeys = [
  "KIRO_API_KEY",
  "DEVIN_API_KEY",
  "DEVIN_SESSION_TOKEN",
  "WINDSURF_API_KEY",
  "GROK_BIN",
  "NS_DEVIN_MODEL_CACHE",
  "NS_BRIDGE_BACKGROUND_REFRESH",
] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function rememberEnv(): void {
  for (const key of envKeys) saved[key] = process.env[key];
}

function expectNoBlockingSpawn(): void {
  expect(child.execFileSync).not.toHaveBeenCalled();
  expect(child.execSync).not.toHaveBeenCalled();
  expect(child.spawn).not.toHaveBeenCalled();
  expect(child.spawnSync).not.toHaveBeenCalled();
}

async function finishes(work: Promise<unknown> | undefined, ms = 400): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("catalog refresh does not block host startup", () => {
  beforeEach(() => {
    child.execFile.mockClear();
    child.execFileSync.mockClear();
    child.execSync.mockClear();
    child.spawn.mockClear();
    child.spawnSync.mockClear();
  });

  it("registers Kiro from disk while credential refresh is still pending", async () => {
    rememberEnv();
    process.env.KIRO_API_KEY = "ksk_test";
    const handlers: Array<() => unknown> = [];
    const api = {
      registerProvider: vi.fn(),
      on: vi.fn((event: string, handler: () => unknown) => {
        if (event === "session_start") handlers.push(handler);
      }),
    };

    await finishes(registerKiroProvider(api as never));
    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    const config = api.registerProvider.mock.calls.at(-1)?.[1] as {
      models: unknown[];
      fetchDynamicModels: () => Promise<unknown>;
    };
    expect(config.models.length).toBeGreaterThan(0);
    await finishes(Promise.resolve(config.fetchDynamicModels()));
    await expect(config.fetchDynamicModels()).resolves.toBeNull();
    await finishes(Promise.resolve(handlers[0]?.()));
    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    expect(child.execFile).not.toHaveBeenCalled();
    expectNoBlockingSpawn();
  });

  it("registers Devin from the seed while discovery is still pending", async () => {
    rememberEnv();
    process.env.DEVIN_API_KEY = "tok";
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const api = {
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "session_start") handlers.push(handler);
      }),
    };

    await finishes(registerDevinProvider(api as never));
    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    const config = api.registerProvider.mock.calls[0]?.[1] as { models: { id: string }[] };
    expect(config.models.map((model) => model.id)).toContain("swe-1-6");
    await finishes(
      Promise.resolve(handlers[0]?.({}, { modelRegistry: { getApiKeyForProvider: () => new Promise(() => {}) } })),
    );
    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    expect(child.execFile).not.toHaveBeenCalled();
    expectNoBlockingSpawn();
  });

  it("does not hand OMP an empty Devin catalog from a fresh cache", async () => {
    rememberEnv();
    const dir = mkdtempSync(join(tmpdir(), "ns-pi-devin-cache-"));
    process.env.NS_DEVIN_MODEL_CACHE = join(dir, "models.json");
    const empty = { fetchedAt: Date.now(), models: [] };
    writeFileSync(process.env.NS_DEVIN_MODEL_CACHE, JSON.stringify(empty));
    const api = { registerProvider: vi.fn(), registerCommand: vi.fn(), on: vi.fn() };
    await finishes(registerDevinProvider(api as never));
    const fetchDynamicModels = api.registerProvider.mock.calls[0]?.[1].fetchDynamicModels as () => Promise<unknown>;
    await expect(fetchDynamicModels()).resolves.toBeNull();

    const fromDisk = { ...devinModels[0], id: "from-disk-only", name: "From disk" };
    writeFileSync(process.env.NS_DEVIN_MODEL_CACHE, JSON.stringify({ fetchedAt: Date.now(), models: [fromDisk] }));
    const latest = (await fetchDynamicModels()) as { id: string }[];
    expect(latest).not.toEqual([]);
    expect(latest.map((model) => model.id)).toContain("from-disk-only");
    expect(child.execFile).not.toHaveBeenCalled();
    expectNoBlockingSpawn();
  });

  it("registers Grok without spawning the CLI model probe", async () => {
    rememberEnv();
    process.env.NS_BRIDGE_BACKGROUND_REFRESH = "1";
    const dir = mkdtempSync(join(tmpdir(), "ns-pi-grok-slow-"));
    const marker = join(dir, "ran");
    const binary = join(dir, "grok");
    writeFileSync(binary, `#!/bin/sh\nsleep 0.2\n: > ${JSON.stringify(marker).slice(1, -1)}\n`, "utf8");
    chmodSync(binary, 0o755);
    process.env.GROK_BIN = binary;

    const api = {
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    const started = Date.now();
    await registerGrokProvider(api as never);
    expect(Date.now() - started).toBeLessThan(400);
    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    expect(child.execFile).not.toHaveBeenCalled();
    expectNoBlockingSpawn();
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });
});
