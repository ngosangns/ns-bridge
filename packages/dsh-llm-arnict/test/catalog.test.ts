import { ARNICT_CATALOG_CACHE_DIR_ENV } from "ns-arnict-core";
import { describe, expect, it } from "vitest";
import {
  ARNICT_BOOTSTRAP_IDS,
  arnictCatalogCacheDir,
  modelsFromCatalogJson,
  readArnictCatalogFile,
} from "../src/catalog.js";

describe("arnict catalog", () => {
  it("lists an expired snapshot", () => {
    const raw = JSON.stringify({
      version: "v1",
      fetchedAt: 0,
      models: ARNICT_BOOTSTRAP_IDS.map((id) => ({ id, name: id, contextWindow: 500_000, maxTokens: 128_000 })),
    });
    expect(modelsFromCatalogJson(raw).map((model) => model.id)).toEqual([...ARNICT_BOOTSTRAP_IDS]);
  });

  it("uses the bootstrap ids when the file is missing, empty, or corrupt", () => {
    expect(modelsFromCatalogJson(undefined).map((model) => model.id)).toEqual([...ARNICT_BOOTSTRAP_IDS]);
    expect(modelsFromCatalogJson('{"models":[]}').map((model) => model.id)).toEqual([...ARNICT_BOOTSTRAP_IDS]);
    expect(modelsFromCatalogJson("not-json").map((model) => model.id)).toEqual([...ARNICT_BOOTSTRAP_IDS]);
    const missing = readArnictCatalogFile({
      home: "/tmp/ns-dsh-arnict-missing",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing.map((model) => model.id)).toEqual([...ARNICT_BOOTSTRAP_IDS]);
  });

  // The harness reads the Pi cache root by default, but a deployment that keeps
  // its cache elsewhere must not need a code change to say so.
  it("honours the cache-directory override", () => {
    expect(arnictCatalogCacheDir("/home/x", { [ARNICT_CATALOG_CACHE_DIR_ENV]: "/elsewhere" })).toBe("/elsewhere");
    expect(arnictCatalogCacheDir("/home/x", {})).toBe("/home/x/.pi/agent/cache/ns-pi-provider");
  });
});
