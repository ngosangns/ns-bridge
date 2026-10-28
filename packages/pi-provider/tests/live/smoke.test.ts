/**
 * Optional live smoke — gated on NS_PI_LIVE=1 and cred files present.
 * Never prints secret material.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshDevinModels, resolveDevinToken } from "../../src/devin/register.js";
import { grokAuthPresent, refreshGrokModels } from "../../src/grok/register.js";
import { refreshKiroModels } from "../../src/kiro/register.js";
import { qoderAuthPresent, refreshQoderModels } from "../../src/qoder/register.js";

const LIVE = process.env.NS_PI_LIVE === "1";

function has(path: string): boolean {
  return existsSync(path);
}

describe.runIf(LIVE)("live smoke (creds)", () => {
  it("kiro catalog when a session is present", async () => {
    const result = await refreshKiroModels({ force: true });
    if (result.models.length === 0) {
      console.info("[live] kiro: skip (no kiro-cli / IDE session, no KIRO_API_KEY)");
      return;
    }
    expect(result.models[0].cost).toHaveProperty("cacheRead");
    console.info(`[live] kiro: ${result.models.length} models (${result.region})`);
  });

  it("devin discovery when token present", async () => {
    const token = resolveDevinToken();
    if (!token) {
      console.info("[live] devin: skip (no token)");
      return;
    }
    const result = await refreshDevinModels({ force: true, token });
    expect(result.models.length).toBeGreaterThan(0);
    console.info(`[live] devin: ${result.models.length} models`);
  });

  it("grok models when auth present", async () => {
    if (!grokAuthPresent() && !has(join(homedir(), ".grok", "auth.json"))) {
      console.info("[live] grok: skip (no auth)");
      return;
    }
    const result = await refreshGrokModels({ force: true });
    expect(result.models.length).toBeGreaterThan(0);
    console.info(`[live] grok: ${result.models.length} models [${result.source}]`);
  });

  it("qoder models when auth present", async () => {
    if (!qoderAuthPresent() && !has(join(homedir(), ".qoder", ".auth"))) {
      console.info("[live] qoder: skip (no qodercli session / PAT)");
      return;
    }
    const result = await refreshQoderModels({ force: true, allowNetwork: true });
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.source).toBe("live");
    console.info(`[live] qoder: ${result.models.length} models [${result.source}]`);
  }, 120_000);
});
