import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Unit tests exercise the in-process TypeScript cores (many stub global fetch);
// the differential tests pick the Go engine per vendor explicitly.
process.env.NS_BRIDGE_ENGINE = "ts";

// kiro-core and devin-core resolve their caches and credential stores from the
// home directory, some at import time. Keep tests off the developer's live
// Kiro / Devin / Grok state.
const testHome = mkdtempSync(join(tmpdir(), "ns-pi-provider-test-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.PATH = "/usr/bin:/bin";
for (const key of [
  "XDG_DATA_HOME",
  "KIRO_API_KEY",
  "KIRO_ACCESS_TOKEN",
  "AMAZON_Q_TOKEN",
  "DEVIN_API_KEY",
  "DEVIN_SESSION_TOKEN",
  "WINDSURF_API_KEY",
  "DEVIN_CREDENTIALS_PATH",
  "NS_DEVIN_MODEL_CACHE",
]) {
  delete process.env[key];
}

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
