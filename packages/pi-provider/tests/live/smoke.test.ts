/**
 * Optional live smoke — gated on NS_PI_LIVE=1 and cred files present.
 * Never prints secret material.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { refreshKiroModels } from "../../src/kiro/register.js";
import { refreshDevinModels, resolveDevinToken } from "../../src/devin/register.js";
import { refreshGrokModels, grokAuthPresent } from "../../src/grok/register.js";

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

  it("grok models when auth present", () => {
    if (!grokAuthPresent() && !has(join(homedir(), ".grok", "auth.json"))) {
      console.info("[live] grok: skip (no auth)");
      return;
    }
    const result = refreshGrokModels({ force: true });
    expect(result.models.length).toBeGreaterThan(0);
    console.info(`[live] grok: ${result.models.length} models [${result.source}]`);
  });
});
