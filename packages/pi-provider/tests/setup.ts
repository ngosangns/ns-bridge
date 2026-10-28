import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Live smokes (`NS_PI_LIVE=1`) need the developer's real HOME, PATH, and qodercli.
if (process.env.NS_PI_LIVE === "1") {
  // no isolation
} else {
  // kiro-core and devin-core resolve their caches and credential stores from the
  // home directory, some at import time. Keep tests off the developer's live
  // Kiro / Devin / Grok / Arnict / Qoder state.
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
    "ARNICT_API_KEY",
    "NS_BRIDGE_ARNICT_CONFIG",
  ]) {
    delete process.env[key];
  }

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });
}
