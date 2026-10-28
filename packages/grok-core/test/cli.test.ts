// ABOUTME: Tests the Grok model-list parser and the context windows.
// ABOUTME: The CLI protocol itself is not exercised here; these are pure functions.

import { describe, expect, it } from "vitest";
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS } from "../src/catalog.js";
import { grokModelInfoFromCache, parseGrokModelsOutput } from "../src/cli/models.js";

describe("parseGrokModelsOutput", () => {
  it("reads the bullet list the CLI prints", () => {
    const stdout = ["Available models:", "  * grok-4.7", "  * grok-4.6 (default)", "  * grok-4.5"].join("\n");
    expect(parseGrokModelsOutput(stdout).map((model) => model.id)).toEqual(["grok-4.7", "grok-4.6", "grok-4.5"]);
  });

  it("puts the default model first", () => {
    const stdout = ["  * grok-4.7", "Default model: grok-4.5"].join("\n");
    expect(parseGrokModelsOutput(stdout).map((model) => model.id)).toEqual(["grok-4.5", "grok-4.7"]);
  });

  it("strips the trailing punctuation a default marker leaves behind", () => {
    expect(parseGrokModelsOutput("  * grok-4.6 (default)").map((model) => model.id)).toEqual(["grok-4.6"]);
  });

  it("does not list the same id twice", () => {
    const stdout = ["  * grok-4.7", "Default model: grok-4.7"].join("\n");
    expect(parseGrokModelsOutput(stdout).map((model) => model.id)).toEqual(["grok-4.7"]);
  });

  it("returns nothing for output with no models", () => {
    expect(parseGrokModelsOutput("not authenticated")).toEqual([]);
  });

  it("reads name, window, reasoning support and output ceiling from the CLI cache", () => {
    const cache = grokModelInfoFromCache(
      JSON.stringify({
        models: {
          "grok-4.7": {
            info: {
              name: "Grok 4.7",
              context_window: 256_000,
              context_windows: [256_000, 500_000],
              max_completion_tokens: 64_000,
              supports_reasoning_effort: true,
            },
          },
          "grok-plain": { info: { name: "Plain", context_window: 128_000, supports_reasoning_effort: false } },
        },
      }),
    );
    const models = parseGrokModelsOutput(["  * grok-4.7", "  * grok-plain"].join("\n"), cache);
    expect(models.find((model) => model.id === "grok-4.7")).toMatchObject({
      name: "Grok 4.7",
      // `context_window` is what a request gets. The 500k in `context_windows` is only a ceiling.
      contextWindow: 256_000,
      maxTokens: 64_000,
      supportsReasoningEffort: true,
    });
    expect(models.find((model) => model.id === "grok-plain")).toMatchObject({
      name: "Plain",
      contextWindow: 128_000,
      supportsReasoningEffort: false,
    });
  });

  it("keeps the defaults for a model the cache lacks and for a field it leaves null or invalid", () => {
    const cache = grokModelInfoFromCache(
      JSON.stringify({
        models: {
          "grok-4.6": { info: { context_window: 0, max_completion_tokens: null } },
          "grok-4.5": { info: {} },
        },
      }),
    );
    const models = parseGrokModelsOutput(["  * grok-4.6", "  * grok-4.5", "  * grok-new"].join("\n"), cache);
    for (const model of models) {
      expect(model.name).toBe(model.id);
      expect(model.contextWindow).toBe(GROK_DEFAULT_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(GROK_DEFAULT_MAX_TOKENS);
      expect(model.supportsReasoningEffort).toBe(true);
    }
  });
});

describe("grokModelInfoFromCache", () => {
  it("returns nothing for a missing or unreadable cache", () => {
    expect(grokModelInfoFromCache(undefined).size).toBe(0);
    expect(grokModelInfoFromCache("not json").size).toBe(0);
    expect(grokModelInfoFromCache(JSON.stringify({ models: [] })).size).toBe(0);
  });
});
