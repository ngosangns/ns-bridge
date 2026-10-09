import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveKiroEffort, fallbackKiroEffort } from "../src/effort.js";
import {
  applyEffortLadder,
  getCachedModels,
  isCacheStale,
  KIRO_MANAGEMENT_CACHE_PATH,
  KIRO_MANAGEMENT_CACHE_SOURCE,
  KIRO_MANAGEMENT_CACHE_VERSION,
  KIRO_MODEL_IDS,
  type KiroModel,
  kiroModels,
  resolveApiRegion,
  resolveKiroModel,
} from "../src/models.js";
import type { KiroEffort } from "../src/types.js";

const LEGACY_CACHE_PATH = join(homedir(), ".kiro-models-cache.json");
const TEST_REGION = "test-region-1";

function effortSchema(
  field: "reasoning" | "output_config",
  values: string[],
  summarizedThinking = false,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [field]: {
        type: "object",
        properties: { effort: { type: "string", enum: values } },
        additionalProperties: false,
      },
      ...(summarizedThinking
        ? { thinking: { type: "object", properties: { display: { enum: ["summarized", "omitted"] } } } }
        : {}),
    },
    additionalProperties: false,
  };
}

/** A cache-file-shaped model row, as the Go vendor's refreshModels writes. */
function cachedModel(id: string, overrides: Partial<KiroModel> = {}): KiroModel {
  return {
    id: id.replace(/(\d)\.(\d)/g, "$1-$2"),
    kiroModelId: id,
    name: id,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  rmSync(LEGACY_CACHE_PATH, { force: true });
});

afterEach(() => {
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  rmSync(LEGACY_CACHE_PATH, { force: true });
});

describe("Feature 2: Model Definitions", () => {
  describe("resolveKiroModel", () => {
    it.each([
      ["claude-opus-4-8", "claude-opus-4.8"],
      ["claude-sonnet-5", "claude-sonnet-5"],
      ["claude-haiku-4-5", "claude-haiku-4.5"],
      ["claude-fable-5", "claude-fable-5"],
      ["deepseek-3-2", "deepseek-3.2"],
      ["minimax-m2-1", "minimax-m2.1"],
      ["glm-5", "glm-5"],
      ["qwen3-coder-next", "qwen3-coder-next"],
    ])("maps bootstrap ID %s to exact service ID %s", (piId, kiroId) => {
      expect(resolveKiroModel(piId)).toBe(kiroId);
    });

    it("throws on an unknown model ID", () => {
      expect(() => resolveKiroModel("nonexistent")).toThrow("Unknown Kiro model ID");
    });

    it("tracks exact service IDs from the bootstrap catalog", () => {
      expect(KIRO_MODEL_IDS).toEqual(new Set(kiroModels.map((model) => model.kiroModelId)));
    });
  });

  describe("resolveApiRegion", () => {
    it.each([
      ["us-east-2", "us-east-1"],
      ["eu-west-1", "eu-central-1"],
      ["ap-southeast-2", "us-east-1"],
      ["sa-east-1", "us-east-1"],
      ["us-east-1", "us-east-1"],
      [undefined, "us-east-1"],
    ])("maps %s to %s", (ssoRegion, apiRegion) => {
      expect(resolveApiRegion(ssoRegion)).toBe(apiRegion);
    });
  });

  describe("management model cache", () => {
    it("reads the versioned cache the Go vendor writes", () => {
      const models = [cachedModel("claude-opus-4.8"), cachedModel("qwen3-coder-next")];
      writeFileSync(
        KIRO_MANAGEMENT_CACHE_PATH,
        JSON.stringify({
          version: KIRO_MANAGEMENT_CACHE_VERSION,
          source: KIRO_MANAGEMENT_CACHE_SOURCE,
          regions: {
            [TEST_REGION]: { region: TEST_REGION, fetchedAt: Date.now(), models },
          },
        }),
        "utf-8",
      );

      const cachedModels = getCachedModels(TEST_REGION);
      expect(cachedModels.map((model) => model.id)).toEqual(["claude-opus-4-8", "qwen3-coder-next"]);
      expect(resolveKiroModel("claude-opus-4-8")).toBe("claude-opus-4.8");
      expect(isCacheStale(TEST_REGION)).toBe(false);
      expect(isCacheStale("other-region")).toBe(true);
    });

    it("repairs stale Luna image metadata in memory without rewriting the cache", () => {
      const serialized = JSON.stringify({
        version: KIRO_MANAGEMENT_CACHE_VERSION,
        source: KIRO_MANAGEMENT_CACHE_SOURCE,
        regions: {
          [TEST_REGION]: {
            region: TEST_REGION,
            fetchedAt: Date.now(),
            models: [cachedModel("gpt-5.6-luna", { input: ["text"] })],
          },
        },
      });
      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, serialized, "utf-8");

      expect(getCachedModels(TEST_REGION)[0]?.input).toEqual(["text", "image"]);
      expect(readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf-8")).toBe(serialized);
    });

    it("ignores both the old Q cache path and an unversioned cache at the management path", () => {
      const legacyModels = [{ ...kiroModels[0], id: "legacy-only", kiroModelId: "legacy-only" }];
      const legacyCache = JSON.stringify({ [TEST_REGION]: legacyModels });
      writeFileSync(LEGACY_CACHE_PATH, legacyCache, "utf-8");

      expect(getCachedModels(TEST_REGION)).toBe(kiroModels);
      expect(getCachedModels(TEST_REGION).some((model) => model.id === "legacy-only")).toBe(false);

      writeFileSync(KIRO_MANAGEMENT_CACHE_PATH, legacyCache, "utf-8");
      expect(getCachedModels(TEST_REGION)).toBe(kiroModels);
      expect(isCacheStale(TEST_REGION)).toBe(true);
    });
  });

  describe("bootstrap model catalog", () => {
    it("keeps conservative, zero-cost bootstrap metadata", () => {
      expect(kiroModels).toHaveLength(20);
      expect(kiroModels.every((model) => model.cost.input === 0 && model.cost.output === 0)).toBe(true);
      expect(kiroModels.find((model) => model.id === "claude-haiku-4-5")?.reasoning).toBe(false);
      expect(kiroModels.find((model) => model.id === "minimax-m2-1")?.reasoning).toBe(false);
    });

    it("uses image input for Claude and for the GPT variant that supports it", () => {
      const claudeModels = kiroModels.filter((model) => model.id.startsWith("claude-"));
      // `gpt-5-6-luna` is the one non-Claude bootstrap model with verified
      // vision support; its `sol`/`terra` siblings are text-only.
      const textOnlyModels = kiroModels.filter(
        (model) => !model.id.startsWith("claude-") && model.id !== "auto" && model.id !== "gpt-5-6-luna",
      );
      expect(claudeModels.every((model) => model.input.includes("text") && model.input.includes("image"))).toBe(true);
      expect(kiroModels.find((model) => model.id === "gpt-5-6-luna")?.input).toEqual(["text", "image"]);
      expect(textOnlyModels.every((model) => model.input.length === 1 && model.input[0] === "text")).toBe(true);
    });

    it("disables text tool-call recovery only for Claude bootstrap models", () => {
      const claudeModels = kiroModels.filter((model) => model.id.startsWith("claude-"));
      const nonClaudeModels = kiroModels.filter((model) => !model.id.startsWith("claude-"));

      expect(claudeModels.length).toBeGreaterThan(0);
      expect(claudeModels.every((model) => model.recoverTextToolCalls === false)).toBe(true);
      expect(nonClaudeModels.every((model) => model.recoverTextToolCalls === undefined)).toBe(true);
    });
  });

  describe("bootstrap effort ladders", () => {
    const THROUGH_HIGH = ["low", "medium", "high"] satisfies KiroEffort[];
    const THROUGH_XHIGH_AND_MAX = [...THROUGH_HIGH, "xhigh", "max"] satisfies KiroEffort[];
    const THROUGH_HIGH_AND_MAX = [...THROUGH_HIGH, "max"] satisfies KiroEffort[];
    const XHIGH_AND_MAX_MODELS = [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5",
      "claude-fable-5",
      // GPT variants advertise the same ladder through the `reasoning` field.
      "gpt-5-6-luna",
      "gpt-5-6-sol",
      "gpt-5-6-terra",
    ];
    const MAX_WITHOUT_XHIGH_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];

    it("advertises xhigh and max independently when both are supported", () => {
      for (const model of kiroModels.filter((candidate) => XHIGH_AND_MAX_MODELS.includes(candidate.id))) {
        expect(model.efforts, `${model.id} efforts`).toEqual(THROUGH_XHIGH_AND_MAX);
      }
    });

    it("preserves a max-without-xhigh capability hole", () => {
      for (const model of kiroModels.filter((candidate) => MAX_WITHOUT_XHIGH_MODELS.includes(candidate.id))) {
        expect(model.efforts, `${model.id} efforts`).toEqual(THROUGH_HIGH_AND_MAX);
      }
    });

    it("leaves other reasoning models without an explicit ladder", () => {
      for (const model of kiroModels.filter(
        (candidate) =>
          candidate.reasoning &&
          !XHIGH_AND_MAX_MODELS.includes(candidate.id) &&
          !MAX_WITHOUT_XHIGH_MODELS.includes(candidate.id),
      )) {
        expect(model.efforts, `${model.id} efforts`).toBeUndefined();
      }
    });

    it("declares no ladder for non-reasoning models", () => {
      for (const model of kiroModels.filter((candidate) => !candidate.reasoning)) {
        expect(model.efforts, `${model.id} efforts`).toBeUndefined();
      }
    });

    // Kiro renamed its GPT family from `openai-gpt-5.6` to bare `gpt-5.6-<variant>`.
    // A prefix test on `openai-gpt` matched only the old spelling, leaving every
    // current GPT model with no fallback ladder.
    it.each(["gpt-5.6-luna", "gpt-5.6-sol", "openai-gpt-5.6"])(
      "derives the GPT reasoning ladder for %s without catalog schema",
      (kiroModelId) => {
        expect(fallbackKiroEffort(kiroModelId)).toEqual({
          field: "reasoning",
          values: ["low", "medium", "high", "xhigh", "max"],
          summarizedThinking: false,
        });
      },
    );

    it("does not mistake a non-GPT model for the GPT family", () => {
      expect(fallbackKiroEffort("claude-haiku-4.5")).toBeUndefined();
      expect(fallbackKiroEffort("glm-5")).toBeUndefined();
    });
  });

  describe("effort ladder and cache validation", () => {
    const OPUS_SCHEMA = effortSchema("output_config", ["low", "medium", "high", "xhigh", "max"], true);

    it("returns the full ladder and display capability from a catalog schema", () => {
      expect(applyEffortLadder(deriveKiroEffort(OPUS_SCHEMA))).toEqual({
        efforts: ["low", "medium", "high", "xhigh", "max"],
        supportsSummarizedThinking: true,
      });
    });

    it("returns undefined when no supported effort enum is present", () => {
      expect(applyEffortLadder(deriveKiroEffort({ type: "object", properties: {} }))).toEqual({});
      expect(applyEffortLadder({ field: "reasoning", values: [], summarizedThinking: false })).toEqual({});
    });

    it("filters values outside omp's effort enum", () => {
      expect(
        applyEffortLadder({
          field: "reasoning",
          values: ["none", "low", "turbo", "max"],
          summarizedThinking: false,
        }),
      ).toEqual({ efforts: ["low", "max"] });
    });

    it("orders efforts lowest-first regardless of schema order", () => {
      expect(
        applyEffortLadder({
          field: "reasoning",
          values: ["max", "low", "high"],
          summarizedThinking: false,
        })?.efforts,
      ).toEqual(["low", "high", "max"]);
    });
  });
});
