// Compile-time guarantee that both vendor cores speak the neutral vocabulary:
// if kiro-core or devin-core drift, `pnpm -r check` fails here.
import type { DevinMessage, DevinStreamEvent, DevinTool, DevinUsage } from "ns-devin-core";
import type { KiroMessage, KiroStreamEvent, KiroTool, KiroUsage } from "ns-kiro-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { BridgeMessage, BridgeStreamEvent, BridgeTool, BridgeUsage } from "../src/types.js";

describe("vendor cores speak the bridge vocabulary", () => {
  it("emits bridge events and usage", () => {
    expectTypeOf<KiroStreamEvent>().toMatchTypeOf<BridgeStreamEvent>();
    expectTypeOf<DevinStreamEvent>().toMatchTypeOf<BridgeStreamEvent>();
    expectTypeOf<KiroUsage>().toMatchTypeOf<BridgeUsage>();
    expectTypeOf<DevinUsage>().toMatchTypeOf<BridgeUsage>();
  });

  it("reads bridge messages and tools", () => {
    expectTypeOf<BridgeMessage>().toMatchTypeOf<KiroMessage>();
    expectTypeOf<BridgeMessage>().toMatchTypeOf<DevinMessage>();
    expectTypeOf<BridgeTool>().toMatchTypeOf<KiroTool>();
    expectTypeOf<BridgeTool>().toMatchTypeOf<DevinTool>();
    expect(true).toBe(true);
  });
});
