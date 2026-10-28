// Compile-time guarantee that this core speaks the neutral bridge vocabulary.
import type { BridgeMessage, BridgeStreamEvent, BridgeTool, BridgeUsage } from "ns-bridge-core";
import { describe, expect, it } from "vitest";
import type { QoderMessage, QoderStreamEvent, QoderTool, QoderUsage } from "../src/index.js";

type AssertExtends<Sub, Super> = Sub extends Super ? true : never;

describe("qoder-core speaks the bridge vocabulary", () => {
  it("emits bridge events and usage", () => {
    const events: AssertExtends<QoderStreamEvent, BridgeStreamEvent> = true;
    const usage: AssertExtends<QoderUsage, BridgeUsage> = true;
    expect(events && usage).toBe(true);
  });

  it("reads bridge messages and tools", () => {
    const messages: AssertExtends<BridgeMessage, QoderMessage> = true;
    const tools: AssertExtends<BridgeTool, QoderTool> = true;
    expect(messages && tools).toBe(true);
  });
});
