// ABOUTME: Tests the Grok catalog contract every host reads.
// ABOUTME: The point is that a cold or corrupt cache still lists the bootstrap ids.

import { describe, expect, it } from "vitest";
import {
  GROK_BOOTSTRAP_MODEL_IDS,
  GROK_DEFAULT_CONTEXT_WINDOW,
  GROK_DEFAULT_MAX_TOKENS,
  grokBootstrapModels,
  grokCatalogPath,
  grokModelsFromCatalogJson,
  readGrokCatalog,
} from "../src/catalog.js";

describe("grokBootstrapModels", () => {
  it("lists the ids the CLI last printed, with the shared defaults", () => {
    const models = grokBootstrapModels();
    expect(models.map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_MODEL_IDS]);
    expect(models.every((model) => model.contextWindow === GROK_DEFAULT_CONTEXT_WINDOW)).toBe(true);
    expect(models.every((model) => model.maxTokens === GROK_DEFAULT_MAX_TOKENS)).toBe(true);
    expect(models.every((model) => model.reasoning)).toBe(true);
  });

  it("falls back to the 256k window grok-4.7 actually serves, not the 500k ceiling", () => {
    expect(GROK_DEFAULT_CONTEXT_WINDOW).toBe(256_000);
    expect(grokBootstrapModels().find((model) => model.id === "grok-4.7")?.contextWindow).toBe(256_000);
  });
});

describe("grokModelsFromCatalogJson", () => {
  it("lists an expired snapshot rather than dropping it", () => {
    const raw = JSON.stringify({
      version: "grok-cli-v1",
      fetchedAt: 0,
      models: [{ id: "grok-9", name: "Grok 9", contextWindow: 123, maxTokens: 45, reasoning: false }],
    });
    expect(grokModelsFromCatalogJson(raw)).toEqual([
      { id: "grok-9", name: "Grok 9", contextWindow: 123, maxTokens: 45, reasoning: false, input: ["text"] },
    ]);
  });

  it("fills in the shared defaults for a sparse entry", () => {
    const [model] = grokModelsFromCatalogJson(JSON.stringify({ models: [{ id: "grok-9" }] }));
    expect(model).toMatchObject({
      id: "grok-9",
      name: "grok-9",
      contextWindow: GROK_DEFAULT_CONTEXT_WINDOW,
      maxTokens: GROK_DEFAULT_MAX_TOKENS,
      reasoning: true,
    });
  });

  it("keeps only the modalities the harness understands", () => {
    const [model] = grokModelsFromCatalogJson(
      JSON.stringify({ models: [{ id: "grok-9", input: ["text", "audio", "image"] }] }),
    );
    expect(model?.input).toEqual(["text", "image"]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["no models array", '{"version":"v1"}'],
    ["empty models", '{"models":[]}'],
    ["not json", "not-json"],
    ["models is not an array", '{"models":"nope"}'],
  ])("falls back to the bootstrap list for %s", (_label, raw) => {
    expect(grokModelsFromCatalogJson(raw).map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_MODEL_IDS]);
  });

  it("skips an entry with no usable id", () => {
    const models = grokModelsFromCatalogJson(JSON.stringify({ models: [{ name: "no id" }, { id: "grok-9" }] }));
    expect(models.map((model) => model.id)).toEqual(["grok-9"]);
  });
});

describe("readGrokCatalog", () => {
  it("reads the file from the host's cache directory", () => {
    const seen: string[] = [];
    const models = readGrokCatalog({
      cacheDir: "/cache/root",
      readFile: (path) => {
        seen.push(path);
        return JSON.stringify({ models: [{ id: "grok-9" }] });
      },
    });
    expect(seen).toEqual([grokCatalogPath("/cache/root")]);
    expect(models.map((model) => model.id)).toEqual(["grok-9"]);
  });

  it("falls back to the bootstrap list when the file cannot be read", () => {
    const models = readGrokCatalog({
      cacheDir: "/cache/root",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(models.map((model) => model.id)).toEqual([...GROK_BOOTSTRAP_MODEL_IDS]);
  });
});
