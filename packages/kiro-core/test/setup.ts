import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Unit tests exercise the in-process TypeScript cores (many stub global fetch);
// the differential tests pick the Go engine per vendor explicitly.
process.env.NS_BRIDGE_ENGINE = "ts";

const testHome = mkdtempSync(join(tmpdir(), "kiro-core-test-"));

// Source modules resolve cache and credential paths from the home directory at
// import time. Keep tests independent from a developer's live Kiro state.
// The differential tests build the Go sidecar with the real toolchain.
process.env.NS_BRIDGE_TEST_REAL_HOME ??= process.env.HOME;
process.env.NS_BRIDGE_TEST_REAL_PATH ??= process.env.PATH;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = join(testHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(testHome, "AppData", "Local");
process.env.PATH = testHome;

// Each test file gets its own setup context and temporary home.
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
