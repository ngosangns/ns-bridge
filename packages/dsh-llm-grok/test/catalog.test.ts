import { GROK_CATALOG_CACHE_DIR_ENV } from "ns-grok-core";
import { describe, expect, it } from "vitest";
import { GROK_BOOTSTRAP_IDS, grokCatalogCacheDir, modelsFromCatalogJson, readGrokCatalogFile } from "../src/catalog.js";

describe("grok catalog", () => {
  it("lists an expired snapshot", () => {
    const raw = JSON.stringify({
      version: "grok-cli-v1",
      fetchedAt: 0,
      models: GROK_BOOTSTRAP_IDS.map((id) => ({ id, name: id, contextWindow: 500_000, maxTokens: 128_000 })),
    });
    expect(modelsFromCatalogJson(raw).map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_IDS]);
  });

  it("uses the bootstrap ids when the file is missing, empty, or corrupt", () => {
    expect(modelsFromCatalogJson(undefined).map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_IDS]);
    expect(modelsFromCatalogJson('{"models":[]}').map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_IDS]);
    expect(modelsFromCatalogJson("not-json").map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_IDS]);
    const missing = readGrokCatalogFile({
      home: "/tmp/ns-dsh-grok-missing",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing.map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_IDS]);
  });

  // The harness reads the Pi cache root by default, but a deployment that keeps
  // its cache elsewhere must not need a code change to say so.
  it("honours the cache-directory override", () => {
    expect(grokCatalogCacheDir("/home/x", { [GROK_CATALOG_CACHE_DIR_ENV]: "/elsewhere" })).toBe("/elsewhere");
    expect(grokCatalogCacheDir("/home/x", {})).toBe("/home/x/.pi/agent/cache/ns-pi-provider");
  });
});
