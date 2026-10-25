// Compile-time guarantee that this core speaks the neutral bridge vocabulary:
// if arnict-core drifts from ns-bridge-core, `pnpm -r check` fails here.
import type { BridgeMessage, BridgeStreamEvent, BridgeTool, BridgeUsage } from "ns-bridge-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ArnictMessage, ArnictStreamEvent, ArnictTool, ArnictUsage } from "../src/index.js";

describe("arnict-core speaks the bridge vocabulary", () => {
  it("emits bridge events and usage", () => {
    expectTypeOf<ArnictStreamEvent>().toMatchTypeOf<BridgeStreamEvent>();
    expectTypeOf<ArnictUsage>().toMatchTypeOf<BridgeUsage>();
  });

  it("reads bridge messages and tools", () => {
    expectTypeOf<BridgeMessage>().toMatchTypeOf<ArnictMessage>();
    expectTypeOf<BridgeTool>().toMatchTypeOf<ArnictTool>();
    expect(true).toBe(true);
  });
});
