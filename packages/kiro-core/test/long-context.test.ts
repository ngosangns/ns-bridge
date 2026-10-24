// ABOUTME: Tests for the standard-price window a Kiro model runs in and the compaction budget it implies.
// ABOUTME: Windows match the live Kiro catalog on 2026-10-24: luna 922K, Claude 1M or 200K.

import { describe, expect, it } from "vitest";
import { toKiroModelForHost } from "../src/host-model.js";
import { kiroStandardContextWindow } from "../src/long-context.js";
import { kiroModels } from "../src/models.js";

describe("kiroStandardContextWindow", () => {
  it("stops luna at OpenAI's 272K long-context threshold", () => {
    expect(kiroStandardContextWindow({ id: "gpt-5-6-luna", contextWindow: 922_000 })).toBe(272_000);
  });

  it("stops Sol and Terra at the same published threshold", () => {
    expect(kiroStandardContextWindow({ id: "gpt-5-6-sol", contextWindow: 922_000 })).toBe(272_000);
    expect(kiroStandardContextWindow({ id: "gpt-5-6-terra", contextWindow: 922_000 })).toBe(272_000);
  });

  it("keeps a window that already ends inside the standard tier", () => {
    expect(kiroStandardContextWindow({ id: "gpt-5-6-luna", contextWindow: 200_000 })).toBe(200_000);
  });

  it("keeps the full window for models billed flat across it", () => {
    expect(kiroStandardContextWindow({ id: "claude-sonnet-5-5", contextWindow: 1_000_000 })).toBe(1_000_000);
    expect(kiroStandardContextWindow({ id: "claude-haiku-4-5", contextWindow: 200_000 })).toBe(200_000);
  });

  it("does not read inherited keys as model ids", () => {
    expect(kiroStandardContextWindow({ id: "toString", contextWindow: 500_000 })).toBe(500_000);
  });
});

describe("Kiro compaction budget", () => {
  it("is taken inside the standard-price window", () => {
    const seedLuna = kiroModels.find((model) => model.id === "gpt-5-6-luna");
    expect(seedLuna?.compaction).toEqual({ reserveTokens: 16_384, thresholdTokens: 272_000 - 16_384 });
  });
});

describe("toKiroModelForHost", () => {
  it("rebuilds an uncached model with Kiro's full window, not the host's standard one", () => {
    const model = toKiroModelForHost(
      {
        id: "gpt-9-uncached",
        name: "GPT 9",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxContextWindow: 922_000,
        maxTokens: 128_000,
      },
      "us-east-1",
    );
    expect(model.contextWindow).toBe(922_000);
  });
});
