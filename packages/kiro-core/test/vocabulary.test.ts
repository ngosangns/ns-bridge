// Compile-time guarantee that this core speaks the neutral bridge vocabulary:
// if kiro-core drifts from ns-bridge-core, `pnpm -r check` fails here.
import type { BridgeMessage, BridgeStreamEvent, BridgeTool, BridgeUsage } from "ns-bridge-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { KiroMessage, KiroStreamEvent, KiroTool, KiroUsage } from "../src/index.js";

describe("kiro-core speaks the bridge vocabulary", () => {
  it("emits bridge events and usage", () => {
    expectTypeOf<KiroStreamEvent>().toMatchTypeOf<BridgeStreamEvent>();
    expectTypeOf<KiroUsage>().toMatchTypeOf<BridgeUsage>();
  });

  it("reads bridge messages and tools", () => {
    expectTypeOf<BridgeMessage>().toMatchTypeOf<KiroMessage>();
    expectTypeOf<BridgeTool>().toMatchTypeOf<KiroTool>();
    expect(true).toBe(true);
  });
});
