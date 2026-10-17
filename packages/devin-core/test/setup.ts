import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Unit tests exercise the in-process TypeScript cores (many stub global fetch);
// the differential tests pick the Go engine per vendor explicitly.
process.env.NS_BRIDGE_ENGINE = "ts";

// The Go toolchain keeps its build cache under the real home; the differential
// tests build the sidecar with it.
process.env.NS_BRIDGE_TEST_REAL_HOME ??= process.env.HOME;

const testHome = mkdtempSync(join(tmpdir(), "devin-core-test-"));

// Source modules resolve cache and credential paths from the home directory at
// call time. Keep tests independent from a developer's live Devin state.
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = join(testHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(testHome, "AppData", "Local");
delete process.env.XDG_DATA_HOME;
delete process.env.DEVIN_CREDENTIALS_PATH;
delete process.env.NS_DEVIN_MODEL_CACHE;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
