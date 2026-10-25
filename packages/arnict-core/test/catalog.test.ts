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
  ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
  ARNICT_KNOWN_MODELS,
  arnictBootstrapModels,
  arnictCatalogPath,
  arnictModelSpec,
  arnictModelsFromCatalogJson,
  arnictModelsFromModelIds,
  arnictNativeContextWindow,
  isArnictGlm53Id,
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

describe("isArnictGlm53Id", () => {
  it.each(["zai/glm-5.3", "zai/glm-5.3-flashx", "zai/glm-5.3:beta", "zai/glm-5.3/preview", "ZAI/GLM-5.3-Flash"])(
    "matches %s",
    (id) => {
      expect(isArnictGlm53Id(id)).toBe(true);
    },
  );

  it.each(["zai/glm-5.30", "zai/glm-5.3x", "zai/glm-4.7", "other", "xzai/glm-5.3"])("does not match %s", (id) => {
    expect(isArnictGlm53Id(id)).toBe(false);
  });
});

describe("arnictBootstrapModels", () => {
  it("lists the published specs with their rates and a compaction budget", () => {
    const models = arnictBootstrapModels();
    expect(models.map((model) => model.id)).toEqual(ARNICT_KNOWN_MODELS.map((model) => model.id));
    const flash = models.find((model) => model.id === FLASH);
    expect(flash).toMatchObject({
      name: "GLM 5.3 Flash Abliterated",
      contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
      nativeContextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: ["text", "image"],
      rates: { input: 0.125, cachedInput: 0.05, output: 0.5 },
    });
    expect(flash?.compaction).toEqual({ reserveTokens: 16_384, thresholdTokens: 383_616 });
  });

  it("keeps the text-only second model", () => {
    const full = arnictBootstrapModels().find((model) => model.id === FULL);
    expect(full).toMatchObject({
      name: "GLM 5.3 Abliterated",
      contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
      nativeContextWindow: 1_048_576,
      input: ["text"],
      rates: { input: 1.25, cachedInput: 0.3, output: 2.25 },
    });
    expect(full?.compaction).toEqual({ reserveTokens: 16_384, thresholdTokens: 383_616 });
  });

  it("applies the standard window to every id starting with zai/glm-5.3", () => {
    for (const model of ARNICT_KNOWN_MODELS) {
      if (!model.id.startsWith("zai/glm-5.3")) continue;
      expect(model.contextWindow).toBe(ARNICT_GLM_STANDARD_CONTEXT_WINDOW);
      expect(model.nativeContextWindow).toBe(1_048_576);
    }
  });
});

describe("arnictNativeContextWindow", () => {
  it("reports the served window for the GLM ids, the family window for pattern matches, and the default for the rest", () => {
    expect(arnictNativeContextWindow(FLASH)).toBe(1_048_576);
    expect(arnictNativeContextWindow(FULL)).toBe(1_048_576);
    expect(arnictNativeContextWindow("zai/glm-5.3-flashx")).toBe(1_048_576);
    expect(arnictNativeContextWindow("some/new-model")).toBe(ARNICT_DEFAULT_CONTEXT_WINDOW);
  });
});

describe("arnictModelSpec", () => {
  it("returns the published spec for a known id", () => {
    const spec = arnictModelSpec(FLASH);
    expect(spec.rates).toEqual({ input: 0.125, cachedInput: 0.05, output: 0.5 });
    expect(spec.contextWindow).toBe(400_000);
    expect(spec.nativeContextWindow).toBe(1_048_576);
    expect(spec.compaction).toEqual({ reserveTokens: 16_384, thresholdTokens: 383_616 });
  });

  it("shapes an unknown id with the defaults and no rates", () => {
    const spec = arnictModelSpec("some/new-model");
    expect(spec).toEqual({
      id: "some/new-model",
      name: "some/new-model",
      contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
      nativeContextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
      maxTokens: ARNICT_DEFAULT_MAX_TOKENS,
      reasoning: false,
      input: ["text"],
      compaction: { reserveTokens: 16_384, thresholdTokens: 245_760 },
    });
    expect(spec.rates).toBeUndefined();
  });

  it("gives an unknown id matching the GLM 5.3 pattern the family shape and no rates", () => {
    const spec = arnictModelSpec("zai/glm-5.3:beta");
    expect(spec).toEqual({
      id: "zai/glm-5.3:beta",
      name: "zai/glm-5.3:beta",
      contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
      nativeContextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: ["text"],
      compaction: { reserveTokens: 16_384, thresholdTokens: 383_616 },
    });
    expect(spec.rates).toBeUndefined();
  });

  it("keeps the generic default for an id that only looks like GLM 5.3", () => {
    for (const id of ["zai/glm-5.30", "zai/glm-4.7", "other"]) {
      const spec = arnictModelSpec(id);
      expect(spec.contextWindow).toBe(ARNICT_DEFAULT_CONTEXT_WINDOW);
      expect(spec.nativeContextWindow).toBe(ARNICT_DEFAULT_CONTEXT_WINDOW);
      expect(spec.maxTokens).toBe(ARNICT_DEFAULT_MAX_TOKENS);
      expect(spec.reasoning).toBe(false);
    }
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

  it("applies the GLM 5.3 shape to unknown ids matching the family pattern", () => {
    const models = arnictModelsFromModelIds(["zai/glm-5.3-flashx", "zai/glm-5.30", "other"]);
    expect(models[0]).toMatchObject({
      id: "zai/glm-5.3-flashx",
      contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
      nativeContextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: ["text"],
    });
    expect(models[0]?.rates).toBeUndefined();
    for (const model of models.slice(1)) {
      expect(model.contextWindow).toBe(ARNICT_DEFAULT_CONTEXT_WINDOW);
      expect(model.nativeContextWindow).toBe(ARNICT_DEFAULT_CONTEXT_WINDOW);
    }
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
      // The window policy is recomputed by id: the file's 1 cannot shrink it.
      contextWindow: 400_000,
      nativeContextWindow: 1_048_576,
    });
    expect(models[1]?.rates).toBeUndefined();
  });

  it("keeps an unknown id's own window as both its standard and native window", () => {
    const [model] = arnictModelsFromCatalogJson(
      JSON.stringify({ models: [{ id: "vendor/other", contextWindow: 512_000 }] }),
    );
    expect(model).toMatchObject({
      id: "vendor/other",
      contextWindow: 512_000,
      nativeContextWindow: 512_000,
    });
  });

  it("forces the GLM 5.3 shape onto an unknown id matching the family pattern", () => {
    const [model] = arnictModelsFromCatalogJson(
      JSON.stringify({
        models: [
          {
            id: "zai/glm-5.3:beta",
            name: "Beta Cut",
            contextWindow: 1,
            maxTokens: 2,
            reasoning: false,
            input: ["audio"],
            rates: { input: 99, cachedInput: 99, output: 99 },
          },
        ],
      }),
    );
    expect(model).toEqual({
      id: "zai/glm-5.3:beta",
      name: "Beta Cut",
      contextWindow: ARNICT_GLM_STANDARD_CONTEXT_WINDOW,
      nativeContextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: ["text"],
      compaction: { reserveTokens: 16_384, thresholdTokens: 383_616 },
    });
    expect(model?.rates).toBeUndefined();
  });

  it("keeps a near-miss id's own window as both its standard and native window", () => {
    const [model] = arnictModelsFromCatalogJson(
      JSON.stringify({ models: [{ id: "zai/glm-5.30", contextWindow: 512_000 }] }),
    );
    expect(model).toMatchObject({ id: "zai/glm-5.30", contextWindow: 512_000, nativeContextWindow: 512_000 });
  });

  it("round-trips the bootstrap list with the policy intact", () => {
    const roundTrip = arnictModelsFromCatalogJson(JSON.stringify(arnictBootstrapModels()));
    expect(roundTrip).toEqual(arnictBootstrapModels());
  });

  it("fills in the defaults for a sparse entry", () => {
    const [model] = arnictModelsFromCatalogJson(JSON.stringify({ models: [{ id: "some/new-model" }] }));
    expect(model).toMatchObject({
      id: "some/new-model",
      name: "some/new-model",
      contextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
      nativeContextWindow: ARNICT_DEFAULT_CONTEXT_WINDOW,
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
