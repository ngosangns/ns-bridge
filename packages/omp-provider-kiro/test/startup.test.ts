import { rmSync, writeFileSync } from "node:fs";
import { KIRO_MANAGEMENT_CACHE_PATH } from "ns-kiro-core";
import { describe, expect, it, vi } from "vitest";

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

// `stream.ts` imports `@oh-my-pi/pi-ai`, which loads `@oh-my-pi/pi-utils`.
// That env loader reads `Bun.env` at module-eval time and throws under Node.
vi.mock("@oh-my-pi/pi-ai", () => ({}));

import plugin from "../src/index.js";

function piDouble() {
  const providers = new Map<
    string,
    {
      models: { id: string }[];
      fetchDynamicModels?: (key?: string) => unknown;
      oauth?: { modifyModels?: unknown };
    }
  >();
  const handlers: Array<() => unknown> = [];
  const pi = {
    registerProvider: vi.fn(
      (
        name: string,
        config: {
          models: { id: string }[];
          fetchDynamicModels?: (key?: string) => unknown;
          oauth?: { modifyModels?: unknown };
        },
      ) => {
        providers.set(name, config);
      },
    ),
    on: vi.fn((event: string, handler: () => unknown) => {
      if (event === "session_start") handlers.push(handler);
    }),
  };
  return { pi, providers, handlers };
}

function expectNoSpawn(): void {
  expect(child.execFile).not.toHaveBeenCalled();
  expect(child.execFileSync).not.toHaveBeenCalled();
  expect(child.execSync).not.toHaveBeenCalled();
  expect(child.spawn).not.toHaveBeenCalled();
  expect(child.spawnSync).not.toHaveBeenCalled();
}

describe("Kiro catalog refresh does not block OMP startup", () => {
  it("registers from the local list and does not wait to answer fetchDynamicModels", async () => {
    rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    const { pi, providers, handlers } = piDouble();

    const started = Date.now();
    plugin(pi as never);
    expect(Date.now() - started).toBeLessThan(400);

    const config = providers.get("kiro");
    expect(config?.models.length).toBeGreaterThan(0);
    // OMP rebuilds its whole model registry the first time a provider registers
    // modifyModels. Startup must not hand it that hook.
    expect(config?.oauth?.modifyModels).toBeUndefined();
    await expect(Promise.resolve(config?.fetchDynamicModels?.(undefined))).resolves.toBeNull();
    expect(pi.registerProvider).toHaveBeenCalledTimes(1);
    await Promise.resolve(handlers[0]?.());
    expect(pi.registerProvider).toHaveBeenCalledTimes(1);
    expectNoSpawn();
  });

  it("reads a fresh Kiro catalog at call time instead of a closed-over snapshot", async () => {
    rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    const { pi, providers } = piDouble();
    plugin(pi as never);
    const config = providers.get("kiro");
    await expect(Promise.resolve(config?.fetchDynamicModels?.(undefined))).resolves.toBeNull();

    const diskModel = {
      id: "cache-only-model",
      kiroModelId: "cache-only-model",
      name: "Cache Only",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    writeFileSync(
      KIRO_MANAGEMENT_CACHE_PATH,
      JSON.stringify({
        version: 1,
        source: "ns-kiro-provider-management",
        regions: { "us-east-1": { region: "us-east-1", fetchedAt: Date.now(), models: [diskModel] } },
      }),
    );
    try {
      const latest = (await Promise.resolve(config?.fetchDynamicModels?.(undefined))) as { id: string }[];
      expect(latest).not.toBeNull();
      expect(latest).not.toEqual([]);
      expect(latest.map((model) => model.id)).toEqual(["cache-only-model"]);
      expect(config?.models.map((model) => model.id)).not.toContain("cache-only-model");
      expectNoSpawn();
    } finally {
      rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    }
  });
});
