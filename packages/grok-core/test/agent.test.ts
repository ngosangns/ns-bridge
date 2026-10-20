// ABOUTME: Tests the Grok model-list parser and the id mapping.
// ABOUTME: The CLI protocol itself is not exercised here; these are pure functions.

import { describe, expect, it } from "vitest";
import { grokContextWindowsFromCache, parseGrokModelsOutput, resolveCliModelId } from "../src/agent/models.js";
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MODEL_ID } from "../src/catalog.js";

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

  it("uses the window the CLI cache records and keeps the default for a model it lacks", () => {
    const windows = grokContextWindowsFromCache(
      JSON.stringify({
        models: {
          "grok-4.7": { info: { context_window: 256_000, context_windows: [256_000, 500_000] } },
          "grok-4.6": { info: { context_window: 0 } },
          "grok-4.5": { info: {} },
        },
      }),
    );
    const models = parseGrokModelsOutput(["  * grok-4.7", "  * grok-4.6", "  * grok-4.5"].join("\n"), windows);
    expect(models.find((model) => model.id === "grok-4.7")?.contextWindow).toBe(256_000);
    expect(models.find((model) => model.id === "grok-4.6")?.contextWindow).toBe(GROK_DEFAULT_CONTEXT_WINDOW);
    expect(models.find((model) => model.id === "grok-4.5")?.contextWindow).toBe(GROK_DEFAULT_CONTEXT_WINDOW);
  });
});

describe("grokContextWindowsFromCache", () => {
  it("returns nothing for a missing or unreadable cache", () => {
    expect(grokContextWindowsFromCache(undefined).size).toBe(0);
    expect(grokContextWindowsFromCache("not json").size).toBe(0);
    expect(grokContextWindowsFromCache(JSON.stringify({ models: [] })).size).toBe(0);
  });
});

describe("resolveCliModelId", () => {
  it("maps the pre-0.2 alias onto the default model", () => {
    expect(resolveCliModelId("grok-4.5-agent")).toBe(GROK_DEFAULT_MODEL_ID);
  });

  it("strips a generic -agent suffix", () => {
    expect(resolveCliModelId("grok-4.7-agent")).toBe("grok-4.7");
  });

  it("leaves a plain id alone", () => {
    expect(resolveCliModelId("grok-4.7")).toBe("grok-4.7");
  });
});
