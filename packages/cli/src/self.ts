/**
 * Update this CLI itself. Host plugins stay on `ns-bridge update`.
 * Like every other mutating command, the default is a preview; `--apply` runs it.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@ngosangns/ns-bridge";

export interface SelfPlan {
  /** `npm install -g @ngosangns/ns-bridge@<latest>` */
  command: string[];
  current: string;
  latest: string;
  /** True when npm already has this version. */
  currentIsLatest: boolean;
}

export function currentVersion(): string {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "package.json"), join(here, "package.json")];
  for (const path of candidates) {
    try {
      const pkg = require(path) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // The next candidate is the one next to a bundled entry.
    }
  }
  return "0.0.0";
}

/** Parse the version out of `npm view <name> version` stdout. */
export function parseNpmVersion(stdout: string): string | { error: string } {
  const version = stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return { error: `npm did not return a version (got ${JSON.stringify(stdout.trim() || "(empty)")})` };
  }
  return version;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10));
  const b = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function planSelfUpdate(current: string, latest: string): SelfPlan | { error: string } {
  if (!/^\d+\.\d+\.\d+/.test(latest)) return { error: `not a version: ${latest}` };
  return {
    command: ["npm", "install", "-g", `${PACKAGE_NAME}@${latest}`],
    current,
    latest,
    currentIsLatest: compareVersions(current, latest) >= 0,
  };
}
