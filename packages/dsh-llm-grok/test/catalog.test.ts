import { describe, expect, it } from "vitest";
import { GROK_BOOTSTRAP_IDS, modelsFromCatalogJson, readGrokCatalog } from "../src/catalog.js";

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
    const missing = readGrokCatalog({
      home: "/tmp/ns-dsh-grok-missing",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing.map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_IDS]);
  });
});
