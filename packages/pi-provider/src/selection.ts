/**
 * Which providers this install registers. `ns-bridge providers enable|disable`
 * writes the file. Environment lists still win, matching the OMP adapter:
 * `NS_OMP_PROVIDERS` replaces the file, `NS_OMP_PROVIDER_ENABLE` adds,
 * `NS_OMP_PROVIDER_DISABLE` removes.
 *
 * No file: kiro, devin, grok, arnict, and qoder on.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_KEYS = ["kiro", "devin", "grok", "arnict", "qoder"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export type ProviderSelection = Record<ProviderKey, boolean>;

const DEFAULT_SELECTION: ProviderSelection = {
  kiro: true,
  devin: true,
  grok: true,
  arnict: true,
  qoder: true,
};

export function selectionFilePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.NS_BRIDGE_PROVIDERS ?? join(home, ".ns-bridge", "providers.json");
}

export function resolveProviderSelection(
  env: NodeJS.ProcessEnv = process.env,
  file: Partial<ProviderSelection> = readProviderFile(selectionFilePath(env)),
): ProviderSelection {
  const allow = listed(env.NS_OMP_PROVIDERS);
  const enable = listed(env.NS_OMP_PROVIDER_ENABLE) ?? {};
  const deny = listed(env.NS_OMP_PROVIDER_DISABLE) ?? {};
  const selection = {} as ProviderSelection;
  for (const key of PROVIDER_KEYS) {
    const base = allow ? allow[key] === true : (file[key] ?? DEFAULT_SELECTION[key]);
    selection[key] = (base || enable?.[key] === true) && deny?.[key] !== true;
  }
  return selection;
}

export function readProviderFile(path: string): Partial<ProviderSelection> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) record[key] = value;
  const selection: Partial<ProviderSelection> = {};
  for (const key of PROVIDER_KEYS) {
    if (typeof record[key] === "boolean") selection[key] = record[key];
  }
  return selection;
}

function listed(value: string | undefined): Partial<Record<ProviderKey, true>> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const found: Partial<Record<ProviderKey, true>> = {};
  for (const item of value.split(/[\s,]+/)) {
    const name = item.trim().toLowerCase();
    if (name === "kiro" || name === "devin" || name === "grok" || name === "arnict" || name === "qoder")
      found[name] = true;
  }
  return found;
}
