import { describe, expect, it } from "vitest";
import {
  QODER_DEFAULT_CONTEXT_WINDOW,
  QODER_DEFAULT_MAX_TOKENS,
  qoderBootstrapModels,
  qoderModelFromInfo,
  qoderModelsFromModelInfos,
} from "../src/catalog.js";

describe("qoderModelFromInfo", () => {
  // Shape of a real `getAvailableModels()` entry for a reasoning model (2026-10-28).
  const ultimate = {
    value: "ultimate",
    displayName: "Ultimate",
    isEnabled: true,
    isReasoning: true,
    isVl: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
    defaultContextWindow: 200_000,
    efforts: ["xhigh", "high", "low", "max", "medium"],
  };

  it("takes name, output ceiling, image input and efforts from the server entry", () => {
    expect(qoderModelFromInfo(ultimate)).toMatchObject({
      id: "ultimate",
      name: "Ultimate",
      reasoning: true,
      input: ["text", "image"],
      maxTokens: 32_000,
      // Lowest to highest, whatever order the server listed them in.
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("uses the default context tier, not the largest input the model accepts", () => {
    // A request gets the tier. Sizing the window on the 1M ceiling would compact far too late.
    expect(qoderModelFromInfo(ultimate).contextWindow).toBe(200_000);
  });

  it("never lets the tier exceed the input the model accepts", () => {
    expect(qoderModelFromInfo({ ...ultimate, maxInputTokens: 180_000 }).contextWindow).toBe(180_000);
  });

  it("marks a model text-only and non-reasoning when the server says neither", () => {
    const flash = qoderModelFromInfo({ value: "mmodel", displayName: "MiniMax-M3.1-Flash", isVl: false });
    expect(flash.input).toEqual(["text"]);
    expect(flash.reasoning).toBe(false);
    expect(flash).not.toHaveProperty("efforts");
  });

  it("falls back to the shared defaults for a field the server leaves out", () => {
    const bare = qoderModelFromInfo({ value: "x" });
    expect(bare).toMatchObject({
      name: "x",
      contextWindow: QODER_DEFAULT_CONTEXT_WINDOW,
      maxTokens: QODER_DEFAULT_MAX_TOKENS,
    });
  });

  it("names a known id after the app's label when the server gives none", () => {
    expect(qoderModelFromInfo({ value: "qmodel_38max" }).name).toBe("Qwen3.8-Max");
    expect(qoderModelFromInfo({ value: "dfmodel" }).name).toBe("DeepSeek-Flash");
  });

  it("ignores a zero or negative limit instead of publishing it", () => {
    // The server reports `maxInputTokens: 0` for kmodel. A zero window would break compaction.
    const kimi = qoderModelFromInfo({ value: "kmodel", maxInputTokens: 0, defaultContextWindow: 200_000 });
    expect(kimi.contextWindow).toBe(200_000);
  });
});

describe("qoderModelsFromModelInfos", () => {
  it("lists only enabled entries", () => {
    const models = qoderModelsFromModelInfos([
      { value: "on", isEnabled: true },
      { value: "off", isEnabled: false },
    ]);
    expect(models.map((model) => model.id)).toEqual(["on"]);
  });

  it("keeps the bootstrap list when the server enables nothing", () => {
    expect(qoderModelsFromModelInfos([{ value: "off", isEnabled: false }])).toEqual(qoderBootstrapModels());
  });
});

describe("qoderBootstrapModels", () => {
  it("lists ids with the shared defaults and claims no capability", () => {
    const models = qoderBootstrapModels();
    expect(models.map((model) => model.id)).toContain("smodel");
    expect(models.map((model) => model.id)).not.toContain("performance");
    expect(models.every((model) => model.input.length === 1 && model.input[0] === "text")).toBe(true);
    expect(models.every((model) => model.efforts === undefined)).toBe(true);
  });
});
