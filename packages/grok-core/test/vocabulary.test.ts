// Compile-time guarantee that this core speaks the neutral bridge vocabulary:
// if grok-core drifts from ns-bridge-core, `pnpm -r check` fails here.
import type { BridgeMessage, BridgeStreamEvent, BridgeTool, BridgeUsage } from "ns-bridge-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { GrokMessage, GrokStreamEvent, GrokTool, GrokUsage } from "../src/index.js";

describe("grok-core speaks the bridge vocabulary", () => {
  it("emits bridge events and usage", () => {
    expectTypeOf<GrokStreamEvent>().toMatchTypeOf<BridgeStreamEvent>();
    expectTypeOf<GrokUsage>().toMatchTypeOf<BridgeUsage>();
  });

  it("reads bridge messages and tools", () => {
    expectTypeOf<BridgeMessage>().toMatchTypeOf<GrokMessage>();
    expectTypeOf<BridgeTool>().toMatchTypeOf<GrokTool>();
    expect(true).toBe(true);
  });
});
