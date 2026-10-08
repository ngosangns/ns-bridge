// Compile-time guarantee that this core speaks the neutral bridge vocabulary:
// if devin-core drifts from ns-bridge-core, `pnpm -r check` fails here.
import type { BridgeMessage, BridgeStreamEvent, BridgeTool, BridgeUsage } from "ns-bridge-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { DevinMessage, DevinStreamEvent, DevinTool, DevinUsage } from "../src/index.js";

describe("devin-core speaks the bridge vocabulary", () => {
  it("emits bridge events and usage", () => {
    expectTypeOf<DevinStreamEvent>().toMatchTypeOf<BridgeStreamEvent>();
    expectTypeOf<DevinUsage>().toMatchTypeOf<BridgeUsage>();
  });

  it("reads bridge messages and tools", () => {
    expectTypeOf<BridgeMessage>().toMatchTypeOf<DevinMessage>();
    expectTypeOf<BridgeTool>().toMatchTypeOf<DevinTool>();
    expect(true).toBe(true);
  });
});
