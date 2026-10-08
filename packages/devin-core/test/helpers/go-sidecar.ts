// Builds go/cmd/ns-bridge once per test file for the differential tests.
// Callers skip when Go is not installed.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const hasGo = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;

const goModule = fileURLToPath(new URL("../../../../go", import.meta.url));

/** Build the binary into a fresh temp dir; returns its path and a cleanup. */
export function buildSidecar(): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ns-bridge-diff-"));
  const bin = join(dir, process.platform === "win32" ? "ns-bridge.exe" : "ns-bridge");
  const home = process.env.NS_BRIDGE_TEST_REAL_HOME ?? process.env.HOME;
  execFileSync("go", ["build", "-o", bin, "./cmd/ns-bridge"], {
    cwd: goModule,
    stdio: "inherit",
    env: { ...process.env, ...(home ? { HOME: home } : {}) },
  });
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
