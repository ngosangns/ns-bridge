// ABOUTME: Guards the package's public surface against accidental omissions.
// ABOUTME: 0.2.0 shipped the split modules in dist but forgot to re-export them.

import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * Entry points a consumer is expected to reach for. Not the whole surface —
 * this is a floor, so adding an export never requires touching this list.
 */
const REQUIRED_EXPORTS = [
  // The one call most consumers need.
  "streamKiro",
  // Credentials, catalog, usage.
  "resolveKiroCredentials",
  "refreshKiroToken",
  "loginKiroWithApiKey",
  "loginKiroFromSession",
  "resolveKiroRequestCredentials",
  "getCachedModels",
  "updateKiroModelsCache",
  "getKiroCliModelRates",
  "fetchKiroUsage",
  // Error and retry classification adapters route on.
  "KiroApiError",
  "isCapacityError",
  "isNonRetryableBodyError",
  "KIRO_REASON_CODES",
] as const;

describe("public exports", () => {
  it.each(REQUIRED_EXPORTS)("exports %s", (name) => {
    expect(core).toHaveProperty(name);
    expect((core as Record<string, unknown>)[name]).toBeDefined();
  });
});
