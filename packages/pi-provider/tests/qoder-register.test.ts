import { describe, expect, it, vi } from "vitest";
import { registerQoderProvider } from "../src/qoder/register.js";

describe("registerQoderProvider", () => {
  it("registers qoder without crashing", async () => {
    const providers = new Map<string, unknown>();
    const api = {
      registerProvider: (id: string, config: unknown) => providers.set(id, config),
      registerCommand: vi.fn(),
    };
    await registerQoderProvider(api as never);
    expect(providers.has("qoder")).toBe(true);
    const config = providers.get("qoder") as { models: unknown[]; streamSimple: unknown };
    expect(config.models.length).toBeGreaterThan(0);
    expect(typeof config.streamSimple).toBe("function");
  });
});
