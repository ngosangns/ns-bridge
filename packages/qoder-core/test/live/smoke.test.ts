/**
 * Optional live smoke — gated on NS_QODER_LIVE=1 and qodercli / PAT auth.
 * Hits the real model server; never runs in CI.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchQoderModels, resolveQoderAuth, streamQoder } from "../../src/index.js";

const LIVE = process.env.NS_QODER_LIVE === "1";

function authLikelyPresent(): boolean {
  if (process.env.QODER_PERSONAL_ACCESS_TOKEN?.trim()) return true;
  return existsSync(join(homedir(), ".qoder", ".auth"));
}

describe.runIf(LIVE)("qoder live smoke", () => {
  it("returns the bootstrap model catalog", async () => {
    const auth = resolveQoderAuth();
    expect(auth).toBeDefined();
    const ids = await fetchQoderModels({ auth });
    expect(ids.length).toBeGreaterThan(0);
    console.info(`[live] qoder: ${ids.length} model id(s)`);
  });

  it("streams a one-line reply", async () => {
    if (!authLikelyPresent()) {
      console.info("[live] qoder: skip stream (no auth)");
      return;
    }
    const auth = resolveQoderAuth();
    // `auto` is the only id the server accepts without extra negotiation.
    const model = process.env.NS_QODER_LIVE_MODEL?.trim() || "auto";
    let text = "";
    let sawDone = false;
    for await (const event of streamQoder({
      model,
      auth,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: pong" }] }],
    })) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "done") sawDone = true;
    }
    expect(text.trim().length).toBeGreaterThan(0);
    expect(sawDone).toBe(true);
    console.info(`[live] qoder stream (${model}): ${text.trim().slice(0, 40)}`);
  }, 180_000);
});
