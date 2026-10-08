// Builds go/cmd/ns-bridge once per test file for the differential tests.
// The test setup points HOME and PATH at a temp dir, so the build uses the
// real ones the setup saved. Callers skip when Go is not installed.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const realEnv = (): NodeJS.ProcessEnv => {
  const home = process.env.NS_BRIDGE_TEST_REAL_HOME;
  const path = process.env.NS_BRIDGE_TEST_REAL_PATH;
  return { ...process.env, ...(home ? { HOME: home } : {}), ...(path ? { PATH: path } : {}) };
};

export const hasGo = spawnSync("go", ["version"], { stdio: "ignore", env: realEnv() }).status === 0;

const goModule = fileURLToPath(new URL("../../../../go", import.meta.url));

/** Build the binary into a fresh temp dir; returns its path and a cleanup. */
export function buildSidecar(): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ns-bridge-diff-"));
  const bin = join(dir, process.platform === "win32" ? "ns-bridge.exe" : "ns-bridge");
  execFileSync("go", ["build", "-o", bin, "./cmd/ns-bridge"], { cwd: goModule, stdio: "inherit", env: realEnv() });
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
