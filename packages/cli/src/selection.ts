/**
 * Which of kiro, devin, grok, and arnict a host registers.
 *
 * The file is the durable switch `ns-bridge providers` writes. Environment
 * lists still win, so a one-off shell override does not need a rewrite.
 * Absent file: kiro, devin, grok, and arnict on.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROVIDERS = ["kiro", "devin", "grok", "arnict"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type ProviderSelection = Record<ProviderName, boolean>;

export const DEFAULT_SELECTION: ProviderSelection = { kiro: true, devin: true, grok: true, arnict: true };

export interface SelectionEnv {
  /** Allow-list. Naming kiro opts it in. */
  NS_OMP_PROVIDERS?: string;
  /** Opt-in on top of the file (or the allow-list). */
  NS_OMP_PROVIDER_ENABLE?: string;
  /** Deny-list, applied last. */
  NS_OMP_PROVIDER_DISABLE?: string;
}

export function selectionPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.NS_BRIDGE_PROVIDERS ?? join(home, ".ns-bridge", "providers.json");
}

export function parseProvider(value: string | undefined): ProviderName | { error: string } {
  const name = value?.trim().toLowerCase();
  if (name === "kiro" || name === "devin" || name === "grok" || name === "arnict") return name;
  return { error: `unknown provider ${value ?? ""} (expected kiro, devin, grok, or arnict)` };
}

/** File values for known providers. Unknown keys and bad shapes are ignored. */
export function readSelectionFile(path: string): Partial<ProviderSelection> {
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
  for (const provider of PROVIDERS) {
    if (typeof record[provider] === "boolean") selection[provider] = record[provider];
  }
  return selection;
}

/**
 * File, then env. `NS_OMP_PROVIDERS` replaces the file. Enable adds.
 * Disable removes, and wins over both.
 */
export function resolveSelection(file: Partial<ProviderSelection>, env: SelectionEnv = {}): ProviderSelection {
  const allow = parseList(env.NS_OMP_PROVIDERS);
  const enable = parseList(env.NS_OMP_PROVIDER_ENABLE);
  const deny = parseList(env.NS_OMP_PROVIDER_DISABLE);
  const selection = {} as ProviderSelection;
  for (const provider of PROVIDERS) {
    const base = allow !== undefined ? allow[provider] === true : (file[provider] ?? DEFAULT_SELECTION[provider]);
    selection[provider] = (base || enable?.[provider] === true) && deny?.[provider] !== true;
  }
  return selection;
}

/**
 * Write one provider. Other keys already in the file stay, and defaults are not
 * written: a key in the file is a choice someone made, and readers act on that
 * (ns-omp-provider used to register `kiro` next to ns-omp-provider-kiro because
 * a disable of devin had written `kiro: true`). Returns the resolved selection.
 */
export function writeProvider(path: string, provider: ProviderName, enabled: boolean): ProviderSelection {
  const next: Partial<ProviderSelection> = { ...readSelectionFile(path), [provider]: enabled };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.providers.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return { ...DEFAULT_SELECTION, ...next };
}

/** `undefined` means the env var was absent, so the file decides. */
function parseList(value: string | undefined): Partial<Record<ProviderName, true>> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const found: Partial<Record<ProviderName, true>> = {};
  for (const item of value.split(/[\s,]+/)) {
    const name = item.trim().toLowerCase();
    if (name === "kiro" || name === "devin" || name === "grok" || name === "arnict") found[name] = true;
  }
  return found;
}
