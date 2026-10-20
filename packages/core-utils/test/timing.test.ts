// ABOUTME: Tests for the abort-aware delay.
// ABOUTME: A retry delay that ignores abort keeps a cancelled turn alive.

import { describe, expect, it } from "vitest";
import { abortableDelay } from "../src/timing.js";

describe("abortableDelay", () => {
  it("resolves after the delay", async () => {
    const started = Date.now();
    await abortableDelay(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(abortableDelay(10_000, controller.signal)).rejects.toBe(reason);
  });

  it("rejects early when the signal fires mid-delay", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const started = Date.now();
    const pending = abortableDelay(10_000, controller.signal);
    setTimeout(() => controller.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not reject after a completed delay when the signal fires later", async () => {
    const controller = new AbortController();
    await abortableDelay(5, controller.signal);
    controller.abort(new Error("too late"));
    // Reaching here without an unhandled rejection is the assertion.
    expect(controller.signal.aborted).toBe(true);
  });
});
