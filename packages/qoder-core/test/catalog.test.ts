import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QODER_DEFAULT_CONTEXT_WINDOW,
  QODER_DEFAULT_MAX_TOKENS,
  qoderBootstrapModels,
  qoderModelFromInfo,
  qoderModelInfosFromVendorCatalog,
  qoderModelsFromModelInfos,
  resolveQoderModelSpec,
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

  it("uses the greatest offered bound, so a larger tier wins over a smaller ceiling", () => {
    // Hosts compact from this window. A tier the catalog lists is a bound the server has offered.
    expect(qoderModelFromInfo(ultimate).contextWindow).toBe(1_000_000);
    expect(
      qoderModelFromInfo({ ...ultimate, defaultContextWindow: 400_000, maxInputTokens: 180_000 }).contextWindow,
    ).toBe(400_000);
    expect(
      qoderModelFromInfo({
        ...ultimate,
        value: "kmodel_latest",
        maxInputTokens: 180_000,
        defaultContextWindow: 200_000,
        largestContextWindow: 1_000_000,
      }).contextWindow,
    ).toBe(1_000_000);
  });

  it("uses the default tier when the server gives no positive input ceiling", () => {
    expect(qoderModelFromInfo({ ...ultimate, maxInputTokens: 0, defaultContextWindow: 30_000 }).contextWindow).toBe(
      30_000,
    );
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

describe("qoderModelInfosFromVendorCatalog", () => {
  // Trimmed shape of `~/.qoder/.models/<uid>/catalog-v7` (2026-10-30).
  const catalog = JSON.stringify({
    assistant: [
      {
        key: "auto",
        enable: true,
        display_name: "Auto",
        is_vl: true,
        is_reasoning: false,
        max_input_tokens: 200_000,
        context_config: {
          "1M": { token_count: 1_000_000 },
          "200K": { token_count: 200_000, is_default: true },
          "400K": { token_count: 400_000 },
        },
      },
      {
        key: "dfmodel",
        enable: true,
        display_name: "DeepSeek-Flash",
        is_vl: true,
        is_reasoning: true,
        max_input_tokens: 1_000_000,
        context_config: { "200K": { token_count: 200_000, is_default: true } },
        thinking_config: { enabled: { efforts: { high: { is_default: true }, low: {}, max: {} } } },
      },
      {
        key: "kmodel_latest",
        enable: true,
        display_name: "Kimi-K3.1-Pro",
        is_vl: true,
        is_reasoning: true,
        max_input_tokens: 180_000,
        context_config: {
          "1M": { token_count: 1_000_000 },
          "200K": { token_count: 200_000, is_default: true },
          "400K": { token_count: 400_000 },
        },
      },
      { enable: false, display_name: "no key" },
    ],
    chat: [{ key: "chat-only", enable: true }],
  });

  it("takes the scene the CLI serves, not whichever list is first", () => {
    expect(qoderModelInfosFromVendorCatalog(catalog, "chat").map((info) => info.value)).toEqual(["chat-only"]);
    expect(qoderModelInfosFromVendorCatalog(catalog).map((info) => info.value)).toEqual([
      "auto",
      "dfmodel",
      "kmodel_latest",
    ]);
  });

  it("maps the vendor fields onto the catalog entry", () => {
    const [auto, flash] = qoderModelInfosFromVendorCatalog(catalog);
    expect(auto).toMatchObject({
      value: "auto",
      displayName: "Auto",
      isEnabled: true,
      isVl: true,
      isReasoning: false,
      maxInputTokens: 200_000,
      defaultContextWindow: 200_000,
    });
    expect(flash).toMatchObject({
      value: "dfmodel",
      displayName: "DeepSeek-Flash",
      isReasoning: true,
      defaultContextWindow: 200_000,
      efforts: ["high", "low", "max"],
    });
  });

  it("ignores entries without a key and unknown shapes", () => {
    expect(qoderModelInfosFromVendorCatalog(catalog).map((info) => info.value)).not.toContain(undefined);
    expect(qoderModelInfosFromVendorCatalog("[]")).toEqual([]);
    expect(qoderModelInfosFromVendorCatalog("{}")).toEqual([]);
  });

  it("publishes the greatest catalog bound as the window", () => {
    const models = qoderModelsFromModelInfos(qoderModelInfosFromVendorCatalog(catalog));
    expect(models.find((model) => model.id === "dfmodel")).toMatchObject({
      contextWindow: 1_000_000,
      input: ["text", "image"],
      efforts: ["low", "high", "max"],
    });
    expect(models.find((model) => model.id === "auto")?.contextWindow).toBe(1_000_000);
    expect(models.find((model) => model.id === "kmodel_latest")?.contextWindow).toBe(1_000_000);
  });
});

describe("resolveQoderModelSpec", () => {
  it("prefers a refreshed disk row and falls back to bootstrap when the id is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-catalog-"));
    writeFileSync(
      join(dir, "qoder.models.json"),
      JSON.stringify({
        version: "1",
        fetchedAt: 1,
        models: [
          {
            id: "qmodel_latest",
            name: "Qwen3.7-Max",
            reasoning: true,
            input: ["text"],
            contextWindow: 180_000,
            maxTokens: 8192,
          },
        ],
      }),
    );
    expect(resolveQoderModelSpec("qmodel_latest", dir)).toMatchObject({
      contextWindow: 180_000,
      reasoning: true,
    });
    expect(resolveQoderModelSpec("efficient", dir)?.id).toBe("efficient");
    expect(resolveQoderModelSpec("missing", dir)).toBeUndefined();
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
