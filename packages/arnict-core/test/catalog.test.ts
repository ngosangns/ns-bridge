// ABOUTME: Tests the Arnict catalog contract every host reads.
// ABOUTME: The point is that a bare or corrupt model list still resolves to a usable spec.

import { describe, expect, it } from "vitest";
import {
  ARNICT_CATALOG_CACHE_DIR_ENV,
  ARNICT_CATALOG_FILE,
  ARNICT_CATALOG_PROVIDER_ID,
  ARNICT_DEFAULT_CONTEXT_WINDOW,
  ARNICT_DEFAULT_MAX_TOKENS,
  ARNICT_DEFAULT_MODEL_ID,
  ARNICT_KNOWN_MODELS,
  arnictBootstrapModels,
  arnictCatalogPath,
  arnictModelSpec,
  arnictModelsFromCatalogJson,
  arnictModelsFromModelIds,
  readArnictCatalog,
} from "../src/catalog.js";

const FLASH = "zai/glm-5.3-flash-uncensored";
const FULL = "zai/glm-5.3-uncensored";

describe("arnict catalog constants", () => {
  it("names the provider, file, and cache-dir override", () => {
    expect(ARNICT_CATALOG_PROVIDER_ID).toBe("arnict");
    expect(ARNICT_CATALOG_FILE).toBe("arnict.models.json");
    expect(ARNICT_CATALOG_CACHE_DIR_ENV).toBe("NS_ARNICT_CATALOG_CACHE_DIR");
    expect(arnictCatalogPath("/cache/root")).toBe("/cache/root/arnict.models.json");
  });

  it("falls back to the flash model", () => {
    expect(ARNICT_DEFAULT_MODEL_ID).toBe(FLASH);
    expect(arnictBootstrapModels().map((model) => model.id)).toContain(FLASH);
  });
});

describe("arnictBootstrapModels", () => {
  it("lists the published specs with their rates and a compaction budget", () => {
    const models = arnictBootstrapModels();
    expect(models.map((model) => model.id)).toEqual(ARNICT_KNOWN_MODELS.map((model) => model.id));
    const flash = models.find((model) => model.id === FLASH);
    expect(flash).toMatchObject({
      name: "GLM 5.3 Flash Abliterated",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: ["text", "image"],
      rates: { input: 0.125, cachedInput: 0.05, output: 0.5 },
    });
    expect(flash?.compaction).toEqual({ reserveTokens: 16_384, thresholdTokens: 1_032_192 });
  });

  it("keeps the text-only second model", () => {
    const full = arnictBootstrapModels().find((model) => model.id === FULL);
    expect(full).toMatchObject({
      name: "GLM 5.3 Abliterated",
      input: ["text"],
      rates: { input: 1.25, cachedInput: 0.3, output: 2.25 },
    });
  });
});

describe("arnictModelSpec", () => {
  it("returns the published spec for a known id", () => {
    const spec = arnictModelSpec(FLASH);
    expect(spec.rates).toEqual({ input: 0.125, cachedInput: 0.05, output: 0.5 });
    expect(spec.contextWindow).toBe(1_048_576);
  });

  it("shapes an unknown id with the defaults and no rates", () => {
    const spec = arnictModelSpec("some/new-model");
    expect(spec).toEqual({
      id: "some/new-model",
      name: "some/new-model",
      contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
      maxTokens: ARNICT_DEFAULT_MAX_TOKENS,
      reasoning: false,
      input: ["text"],
      compaction: { reserveTokens: 16_384, thresholdTokens: 245_760 },
    });
    expect(spec.rates).toBeUndefined();
  });
});

describe("arnictModelsFromModelIds", () => {
  it("merges published specs into a live /v1/models list", () => {
    const models = arnictModelsFromModelIds([FLASH, "brand-new"]);
    expect(models).toHaveLength(2);
    expect(models[0]?.rates).toBeDefined();
    expect(models[1]).toMatchObject({
      id: "brand-new",
      contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
      reasoning: false,
    });
    expect(models[1]?.rates).toBeUndefined();
  });

  it("drops duplicates and empty ids", () => {
    const models = arnictModelsFromModelIds([FLASH, "", FLASH]);
    expect(models.map((model) => model.id)).toEqual([FLASH]);
  });

  it("falls back to the bootstrap list when the API lists nothing", () => {
    expect(arnictModelsFromModelIds([]).map((model) => model.id)).toEqual(ARNICT_KNOWN_MODELS.map((model) => model.id));
  });
});

describe("arnictModelsFromCatalogJson", () => {
  it("keeps published rates for a known id and ignores rates written in the file", () => {
    const raw = JSON.stringify({
      version: "v1",
      fetchedAt: 0,
      models: [
        {
          id: FLASH,
          name: "Renamed",
          contextWindow: 1,
          maxTokens: 2,
          reasoning: false,
          rates: { input: 99, cachedInput: 99, output: 99 },
        },
        { id: "unknown-in-file", name: "Unknown", rates: { input: 99, cachedInput: 99, output: 99 } },
      ],
    });
    const models = arnictModelsFromCatalogJson(raw);
    expect(models[0]).toMatchObject({
      id: FLASH,
      name: "Renamed",
      rates: { input: 0.125, cachedInput: 0.05, output: 0.5 },
    });
    expect(models[1]?.rates).toBeUndefined();
  });

  it("fills in the defaults for a sparse entry", () => {
    const [model] = arnictModelsFromCatalogJson(JSON.stringify({ models: [{ id: "some/new-model" }] }));
    expect(model).toMatchObject({
      id: "some/new-model",
      name: "some/new-model",
      contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
      maxTokens: ARNICT_DEFAULT_MAX_TOKENS,
      reasoning: false,
      input: ["text"],
    });
  });

  it("keeps only the modalities the harness understands", () => {
    const [model] = arnictModelsFromCatalogJson(JSON.stringify({ models: [{ id: FLASH, input: ["text", "audio"] }] }));
    expect(model?.input).toEqual(["text"]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["no models array", '{"version":"v1"}'],
    ["empty models", '{"models":[]}'],
    ["not json", "not-json"],
    ["models is not an array", '{"models":"nope"}'],
  ])("falls back to the bootstrap list for %s", (_label, raw) => {
    expect(arnictModelsFromCatalogJson(raw).map((model) => model.id)).toEqual(
      ARNICT_KNOWN_MODELS.map((model) => model.id),
    );
  });
});

describe("readArnictCatalog", () => {
  it("reads the file from the host's cache directory", () => {
    const seen: string[] = [];
    const models = readArnictCatalog({
      cacheDir: "/cache/root",
      readFile: (path) => {
        seen.push(path);
        return JSON.stringify({ models: [{ id: "some/new-model" }] });
      },
    });
    expect(seen).toEqual([arnictCatalogPath("/cache/root")]);
    expect(models.map((model) => model.id)).toEqual(["some/new-model"]);
  });

  it("falls back to the bootstrap list when the file cannot be read", () => {
    const models = readArnictCatalog({
      cacheDir: "/cache/root",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(models.map((model) => model.id)).toEqual(ARNICT_KNOWN_MODELS.map((model) => model.id));
  });
});
