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
});
