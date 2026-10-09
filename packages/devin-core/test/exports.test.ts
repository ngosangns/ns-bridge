// ABOUTME: The public surface must keep exporting what adapters consume.

import { describe, expect, it } from "vitest";
import {
  DevinApiError,
  DevinProtocolError,
  DevinStreamError,
  fetchDevinModels,
  fetchDevinUsage,
  getCachedModels,
  loginDevinWithPkce,
  normalizeDevinSessionToken,
  refreshDevinToken,
  resolveDevinCredentials,
  resolveDevinModel,
  resolveDevinSession,
  saveDevinCredentials,
  streamDevin,
  streamDevinWithCapacityRetry,
  updateDevinModelsCache,
} from "../src/index.js";

describe("devin-core exports", () => {
  it("publishes the stream, discovery, credentials, and error surface", () => {
    for (const value of [
      streamDevin,
      streamDevinWithCapacityRetry,
      fetchDevinModels,
      fetchDevinUsage,
      resolveDevinCredentials,
      resolveDevinSession,
      saveDevinCredentials,
      loginDevinWithPkce,
      refreshDevinToken,
      getCachedModels,
      updateDevinModelsCache,
      resolveDevinModel,
      DevinApiError,
      DevinStreamError,
      DevinProtocolError,
      normalizeDevinSessionToken,
    ]) {
      expect(value).toBeDefined();
    }
  });
});
