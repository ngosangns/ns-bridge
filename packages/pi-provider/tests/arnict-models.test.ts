import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARNICT_DEFAULT_BASE_URL,
  ARNICT_DEFAULT_CONTEXT_WINDOW,
  ARNICT_DEFAULT_MAX_TOKENS,
  arnictBootstrapModels,
} from "ns-arnict-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshArnictModels } from "../src/arnict/register.js";
import { CatalogCache } from "../src/shared/catalog-cache.js";

const envKeys = ["ARNICT_API_KEY", "NS_BRIDGE_ARNICT_CONFIG"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of envKeys) saved[key] = process.env[key];
  delete process.env.ARNICT_API_KEY;
  delete process.env.NS_BRIDGE_ARNICT_CONFIG;
});

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const KEY = "arnict-secret-key-value";

function fakeFetch(body: unknown): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("refreshArnictModels", () => {
  let cache: CatalogCache;
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "ns-pi-arnict-cache-"));
    cache = new CatalogCache({ cacheDir, ttlMs: 10_000 });
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("serves the bootstrap list when the network is not allowed and nothing is cached", async () => {
    const refreshed = await refreshArnictModels({ allowNetwork: false, cache });
    expect(refreshed.source).toBe("fallback");
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.models.map((m) => m.id)).toEqual(arnictBootstrapModels().map((m) => m.id));
    // Published rates land on the Pi model; cacheWrite stays 0 (no billing).
    expect(refreshed.models[0].cost).toEqual({ input: 0.125, output: 0.5, cacheRead: 0.05, cacheWrite: 0 });
    expect(existsSync(cache.pathFor("arnict"))).toBe(false);
  });

  it("serves a cached snapshot and an expired one without the network", async () => {
    const planted = arnictBootstrapModels().map((spec) => ({
      id: spec.id,
      name: spec.name,
      api: "arnict-chat",
      provider: "arnict",
      reasoning: spec.reasoning,
      input: spec.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
    }));
    cache.store("arnict", planted, { version: "arnict-v1" });
    const fresh = await refreshArnictModels({ allowNetwork: false, cache });
    expect(fresh.source).toBe("cache");
    expect(fresh.fromCache).toBe(true);
    expect(fresh.models.map((m) => m.id)).toEqual(arnictBootstrapModels().map((m) => m.id));

    const expired = new CatalogCache({
      cacheDir,
      ttlMs: 0,
      now: () => Date.now() + 1_000,
    });
    const stale = await refreshArnictModels({ allowNetwork: false, cache: expired });
    expect(stale.source).toBe("cache");
    expect(stale.fromCache).toBe(false);
    expect(stale.models.map((m) => m.id)).toEqual(arnictBootstrapModels().map((m) => m.id));
  });

  it("fetches /v1/models when the network is allowed and stores version arnict-v1", async () => {
    process.env.ARNICT_API_KEY = KEY;
    const { fetchImpl, calls } = fakeFetch({
      data: [{ id: "zai/glm-5.3-flash-uncensored" }, { id: "brand/new-model" }],
    });

    const refreshed = await refreshArnictModels({ allowNetwork: true, cache, fetchImpl });
    expect(refreshed.source).toBe("live");
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.error).toBeUndefined();
    expect(refreshed.models.map((m) => m.id)).toEqual(["zai/glm-5.3-flash-uncensored", "brand/new-model"]);
    expect(calls[0]?.url).toBe(`${ARNICT_DEFAULT_BASE_URL}/models`);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);

    const stored = JSON.parse(readFileSync(cache.pathFor("arnict"), "utf8")) as {
      version: string;
      models: Array<{
        id: string;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
        compaction?: { reserveTokens: number; thresholdTokens: number };
        contextWindow: number;
        maxTokens: number;
      }>;
    };
    expect(stored.version).toBe("arnict-v1");
    const flash = stored.models.find((m) => m.id === "zai/glm-5.3-flash-uncensored");
    expect(flash?.cost).toEqual({ input: 0.125, output: 0.5, cacheRead: 0.05, cacheWrite: 0 });
    // The compaction budget a core spec carries survives onto the catalog row.
    expect(flash?.compaction).toEqual(
      arnictBootstrapModels().find((m) => m.id === "zai/glm-5.3-flash-uncensored")?.compaction,
    );

    // An id the table does not know gets the default shape and no rates.
    const unknown = stored.models.find((m) => m.id === "brand/new-model");
    expect(unknown?.contextWindow).toBe(ARNICT_DEFAULT_CONTEXT_WINDOW);
    expect(unknown?.maxTokens).toBe(ARNICT_DEFAULT_MAX_TOKENS);
    expect(unknown?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls back to the bootstrap list when the network fails, reports the error, and stores nothing", async () => {
    process.env.ARNICT_API_KEY = KEY;
    const fetchImpl = (async () => {
      throw new Error("socket hangup");
    }) as typeof fetch;

    const refreshed = await refreshArnictModels({ allowNetwork: true, cache, fetchImpl });
    expect(refreshed.source).toBe("fallback");
    expect(refreshed.error).toContain("socket hangup");
    expect(refreshed.models.map((m) => m.id)).toEqual(arnictBootstrapModels().map((m) => m.id));
    expect(existsSync(cache.pathFor("arnict"))).toBe(false);
  });

  it("falls back without fetching when there is no key", async () => {
    process.env.NS_BRIDGE_ARNICT_CONFIG = join(mkdtempSync(join(tmpdir(), "ns-pi-arnict-nokey-")), "missing.json");
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const refreshed = await refreshArnictModels({ allowNetwork: true, cache, fetchImpl });
    expect(fetched).toBe(false);
    expect(refreshed.source).toBe("fallback");
    expect(refreshed.error).toContain("ns-bridge arnict login");
    expect(existsSync(cache.pathFor("arnict"))).toBe(false);
    rmSync(process.env.NS_BRIDGE_ARNICT_CONFIG, { force: true });
  });
});
