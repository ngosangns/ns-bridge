import { QODER_CATALOG_CACHE_DIR_ENV, QODER_WIRE_CONTEXT_WINDOW } from "ns-qoder-core";
import { describe, expect, it, vi } from "vitest";
import { createQoderAdapter } from "../src/adapter.js";

vi.mock("ns-qoder-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ns-qoder-core")>();
  return {
    ...actual,
    requireQoderAuth: () => ({ mode: "pat", options: { type: "accessToken", accessToken: "token" } }),
    streamQoder: vi.fn(async function* () {
      yield { type: "start" };
      yield { type: "text_start", index: 0 };
      yield { type: "text_delta", index: 0, delta: "ok" };
      yield { type: "text_end", index: 0, text: "ok" };
      yield { type: "done", stopReason: "stop" };
    }),
  };
});

/** DSH compaction-basic's default headroom, subtracted again from the reported window. */
const DSH_COMPACTION_HEADROOM_TOKENS = 65_536;

describe("createQoderAdapter", () => {
  it("builds a harness adapter", () => {
    const adapter = createQoderAdapter({ provider: "qoder", displayName: "Qoder" });
    expect(adapter).toBeTruthy();
    expect(typeof adapter.listModels).toBe("function");
  });

  it("reports a window whose pressure budget stays positive after DSH headroom", async () => {
    const previous = process.env[QODER_CATALOG_CACHE_DIR_ENV];
    process.env[QODER_CATALOG_CACHE_DIR_ENV] = "/tmp/ns-qoder-catalog-missing";
    try {
      const adapter = createQoderAdapter({ provider: "qoder", displayName: "Qoder" });
      const resolved = await adapter.resolveModel("qoder", "efficient");
      const window = resolved.context?.contextWindow;
      const reserved = resolved.defaultMaxTokens;
      expect(window).toBe(QODER_WIRE_CONTEXT_WINDOW + DSH_COMPACTION_HEADROOM_TOKENS);
      expect(reserved).toBeDefined();
      // compaction-basic rejects the model when this difference is not positive,
      // then sends the turn whole.
      expect((window ?? 0) - (reserved ?? 0) - DSH_COMPACTION_HEADROOM_TOKENS).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env[QODER_CATALOG_CACHE_DIR_ENV];
      else process.env[QODER_CATALOG_CACHE_DIR_ENV] = previous;
    }
  });
});
