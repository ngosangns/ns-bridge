import { describe, expect, it } from "vitest";
import { createGrokAdapter } from "../src/adapter.js";

describe("grok adapter model info", () => {
  it("advertises image input even when the catalog file is text only", async () => {
    const adapter = createGrokAdapter({ provider: "grok", displayName: "Grok" });
    const models = await adapter.listModels("grok");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.inputModalities?.includes("text"))).toBe(true);
    expect(models.every((model) => model.inputModalities?.includes("image"))).toBe(true);
    const resolved = await adapter.resolveModel("grok", models[0]?.id ?? "grok-4.7");
    expect(resolved.inputModalities).toEqual(["text", "image"]);
  });

  it("reserves Pi's 16,384 for compaction instead of the 128k completion ceiling", async () => {
    const adapter = createGrokAdapter({ provider: "grok", displayName: "Grok" });
    const models = await adapter.listModels("grok");
    const grok = models.find((model) => model.id === "grok-4.7") ?? models[0];
    expect(grok).toBeDefined();

    const resolved = await adapter.resolveModel("grok", grok?.id ?? "grok-4.7");
    // The catalog ceiling stays 128k. Only the reservation the Harness reads
    // drops, so compaction no longer triggers near 62k of a 256k window.
    expect(resolved.context?.contextWindow).toBeGreaterThan(128_000);
    expect(resolved.defaultMaxTokens).toBe(16_384);
  });
});
