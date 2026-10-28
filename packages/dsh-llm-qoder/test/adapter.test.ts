import { describe, expect, it, vi } from "vitest";
import { createQoderAdapter } from "../src/adapter.js";

vi.mock("ns-qoder-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ns-qoder-core")>();
  return {
    ...actual,
    requireQoderAuth: () => ({ mode: "pat", options: actual.resolveQoderAuth()!.options }),
    streamQoder: vi.fn(async function* () {
      yield { type: "start" };
      yield { type: "text_start", index: 0 };
      yield { type: "text_delta", index: 0, delta: "ok" };
      yield { type: "text_end", index: 0, text: "ok" };
      yield { type: "done", stopReason: "stop" };
    }),
  };
});

describe("createQoderAdapter", () => {
  it("builds a harness adapter", () => {
    const adapter = createQoderAdapter({ provider: "qoder", displayName: "Qoder" });
    expect(adapter).toBeTruthy();
    expect(typeof adapter.listModels).toBe("function");
  });
});
