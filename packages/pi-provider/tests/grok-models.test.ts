import { describe, it, expect, beforeEach, vi } from "vitest";

const child = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
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
  wrap("spawn");
  wrap("spawnSync");
  return { ...actual, ...child };
});

import { CatalogCache } from "../src/shared/catalog-cache.js";
import { parseGrokModelsOutput, fallbackModels, toProviderModels } from "../src/grok/models.js";
import { refreshGrokModels } from "../src/grok/register.js";
import { ensureCacheCost } from "../src/shared/types.js";

describe("grok models + cache", () => {
  let cache: CatalogCache;
  const memFs = new Map<string, string>();
  let now = 0;

  beforeEach(() => {
    now = 1000;
    memFs.clear();
    child.execFile.mockClear();
    child.execFileSync.mockClear();
    child.spawn.mockClear();
    child.spawnSync.mockClear();
    cache = new CatalogCache({
      cacheDir: "/tmp/ns-pi-grok-cache",
      ttlMs: 10_000,
      now: () => now,
      fs: {
        existsSync: (p) => memFs.has(String(p)),
        readFileSync: (p) => {
          const v = memFs.get(String(p));
          if (!v) throw new Error("ENOENT");
          return v;
        },
        writeFileSync: (p, d) => {
          memFs.set(String(p), String(d));
        },
        mkdirSync: () => undefined,
        renameSync: (a, b) => {
          memFs.set(String(b), memFs.get(String(a))!);
          memFs.delete(String(a));
        },
      },
    });
  });

  it("parses CLI models output", () => {
    const parsed = parseGrokModelsOutput(`
Available models:
  * grok-4.5 (default)
  * grok-4.6
Default model: grok-4.5
`);
    expect(parsed.map((m) => m.id)).toEqual(expect.arrayContaining(["grok-4.5", "grok-4.6"]));
  });

  it("toProviderModels includes cache cost fields", () => {
    const models = toProviderModels(fallbackModels());
    for (const m of models) {
      const cost = ensureCacheCost(m.cost);
      expect(cost).toHaveProperty("cacheRead");
      expect(cost).toHaveProperty("cacheWrite");
    }
  });

  it("refreshGrokModels caches and hits TTL", () => {
    const first = refreshGrokModels({ force: true, binary: undefined, cache });
    expect(first.fromCache).toBe(false);
    expect(first.models.length).toBeGreaterThan(0);
    // costs on provider models
    expect(first.models[0].cost).toMatchObject({
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
    });

    const second = refreshGrokModels({ binary: undefined, cache });
    expect(second.fromCache).toBe(true);
    expect(second.source).toBe("cache");
  });

  it("serves the fallback on a cache miss when the CLI is not allowed", () => {
    const refreshed = refreshGrokModels({ allowCli: false, cache });
    expect(refreshed.source).toBe("fallback");
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5", "grok-4.5-agent"]),
    );
    expect(memFs.size).toBe(0);
    expect(child.execFile).not.toHaveBeenCalled();
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(child.spawn).not.toHaveBeenCalled();
    expect(child.spawnSync).not.toHaveBeenCalled();
  });

  it("serves an expired disk catalog without spawning or rewriting it", () => {
    const planted = {
      version: "grok-cli-v1",
      fetchedAt: now - 60_000,
      models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].map((id) => ({
        id,
        name: id,
        api: "grok-cli",
        provider: "grok",
        baseUrl: "grok-cli://local",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 500_000,
        maxTokens: 128_000,
      })),
    };
    memFs.set(cache.pathFor("grok"), JSON.stringify(planted));
    const before = memFs.size;
    const refreshed = refreshGrokModels({ allowCli: false, cache });
    expect(refreshed.source).toBe("cache");
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]),
    );
    expect(memFs.size).toBe(before);
    expect(child.execFile).not.toHaveBeenCalled();
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(child.spawn).not.toHaveBeenCalled();
    expect(child.spawnSync).not.toHaveBeenCalled();
  });
});
