import { describe, expect, it } from "vitest";
import { createArnictAdapter } from "../src/adapter.js";

const FLASH = "zai/glm-5.3-flash-uncensored";
const FULL = "zai/glm-5.3-uncensored";

describe("arnict adapter model info", () => {
  it("takes input modalities from the catalog spec", async () => {
    const adapter = createArnictAdapter({ provider: "arnict", displayName: "Arnict" });
    const models = await adapter.listModels("arnict");
    expect(models.length).toBeGreaterThan(0);
    expect(models.find((model) => model.id === FLASH)?.inputModalities).toEqual(["text", "image"]);
    expect(models.find((model) => model.id === FULL)?.inputModalities).toEqual(["text"]);
    expect(await adapter.resolveModel("arnict", FLASH)).toMatchObject({ inputModalities: ["text", "image"] });
  });

  it("compacts GLM 5.3 in the 400,000-token standard window", async () => {
    const adapter = createArnictAdapter({ provider: "arnict", displayName: "Arnict" });
    const resolved = await adapter.resolveModel("arnict", FLASH);
    // The standard window hosts compact inside, not the 1,048,576-token window
    // Arnict actually serves; 400,000 with the 16,384 reserve triggers at 383,616.
    expect(resolved.context?.contextWindow).toBe(400_000);
    expect(resolved.defaultMaxTokens).toBe(16_384);
  });

  it("exposes the reasoning ladder for a reasoning model", async () => {
    const adapter = createArnictAdapter({ provider: "arnict", displayName: "Arnict" });
    const resolved = await adapter.resolveModel("arnict", FLASH);
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
