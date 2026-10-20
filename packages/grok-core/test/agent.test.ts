// ABOUTME: Tests the Grok model-list parser and the id mapping.
// ABOUTME: The CLI protocol itself is not exercised here; these are pure functions.

import { describe, expect, it } from "vitest";
import { parseGrokModelsOutput, resolveCliModelId } from "../src/agent/models.js";
import { GROK_DEFAULT_MODEL_ID } from "../src/catalog.js";

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
