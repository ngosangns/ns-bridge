/**
 * `ns-bridge providers` — turn kiro, devin, grok, arnict, or qoder on or off.
 *
 * Pi and OMP register from one file, `~/.ns-bridge/providers.json`. The
 * extensions read it at launch; this command writes it. DSH has no such
 * file: the profile patch carries a `- id: llm-<vendor>` entry with
 * `disabled: true` (a key beside `- insert:` is dropped by the composer).
 * DSH sweeps every profile unless `--profile` names one; the Electron-owned
 * desktop profile is skipped while the DSH app runs.
 *
 * OMP ships `devin`, `xai`, and `xai-oauth` itself and takes `kiro`, `arnict`,
 * and `qoder` from this project, so devin and grok are not a choice for `omp`.
 * Their keys in the shared file stay for Pi and are ignored by the OMP plugin.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DSH_ID, DSH_PLUGIN, dshPluginState, setDshPluginEnabled } from "./dsh-patch.js";
import { type Host, dshDesktopRunning, dshProfiles, isPiBundleSource, PI_SOURCE, parseHosts } from "./hosts.js";
import {
  PROVIDERS,
  type ProviderName,
  type ProviderSelection,
  parseProvider,
  readSelectionFile,
  resolveSelection,
  selectionPath,
  writeProvider,
} from "./selection.js";

export type ProviderAction = "enable" | "disable" | "status";

/** Why `omp` has no devin or grok here, and what to use in OMP instead. Arnict and qoder are choices: the bundled ns-omp-provider registers them. */
const OMP_NATIVE: Partial<Record<ProviderName, string>> = {
  devin: "OMP has its own devin provider; use /login devin or DEVIN_API_KEY",
  grok: "OMP has its own xai and xai-oauth providers; use /login xai-oauth or XAI_API_KEY",
};

export interface ProviderStep {
  host: Host;
  /** What a dry-run prints. Apply runs the write this line describes. */
  line: string;
  apply: () => string | { error: string };
}

export interface ProviderPlan {
  steps: ProviderStep[];
  /** Skip notes a run prints after its steps: profiles left untouched and why. */
  notes: string[];
  error?: string;
}

export interface ProviderPaths {
  selection: string;
  piSettings: string;
  dshHome: string;
}

export function providerPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): ProviderPaths {
  const piDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  return {
    selection: selectionPath(env, home),
    piSettings: join(piDir, "settings.json"),
    dshHome: env.DSH_HOME ?? join(home, ".dsh"),
  };
}

/**
 * Every DSH profile is swept when no `--profile` is given. The Electron-owned
 * `desktop` profile is skipped while the DSH app runs, since it holds the
 * patch file in memory.
 */
export function planProviders(
  action: ProviderAction,
  hostTarget: string | undefined,
  providerTarget: string | undefined,
  profile: string | undefined,
  paths: ProviderPaths,
  desktopRunning: () => boolean = dshDesktopRunning,
): ProviderPlan {
  const hosts = parseHosts(hostTarget);
  if ("error" in hosts) return { steps: [], notes: [], error: hosts.error };
  if (action !== "status" && hosts.length !== 1) {
    return { steps: [], notes: [], error: "enable and disable need one host: pi, omp, or dsh" };
  }

  let provider: ProviderName | undefined;
  if (providerTarget) {
    const parsed = parseProvider(providerTarget);
    if (typeof parsed !== "string") return { steps: [], notes: [], error: parsed.error };
    provider = parsed;
  } else if (action !== "status") {
    return {
      steps: [],
      notes: [],
      error: "enable and disable need a provider: kiro, devin, grok, arnict, or qoder",
    };
  }

  if (action === "enable" && provider && hosts.includes("omp") && OMP_NATIVE[provider]) {
    return {
      steps: [],
      notes: [],
      error: `omp does not use ns-bridge for ${provider}: ${OMP_NATIVE[provider]}`,
    };
  }

  const wantsDsh = hosts.includes("dsh");
  const profiles = wantsDsh ? (profile ? [profile] : dshProfiles(paths.dshHome)) : [];
  const notes: string[] = [];
  if (wantsDsh && profile && isDesktop(profile) && action !== "status" && desktopRunning()) {
    return { steps: [], notes, error: 'quit the DeepSeek Harness app to edit the "desktop" profile' };
  }
  if (wantsDsh && !profile && profiles.length === 0) {
    return { steps: [], notes: [`# dsh skipped: no DSH profiles under ${join(paths.dshHome, "profiles")}`] };
  }

  const steps: ProviderStep[] = [];
  for (const host of hosts) {
    if (host !== "dsh") {
      if (action === "status") steps.push(statusStep(host, provider, undefined, paths));
      else {
        const step = mutateStep(action, host, provider as ProviderName, paths);
        if (step) steps.push(step);
      }
      continue;
    }
    for (const name of profiles) {
      if (action !== "status" && isDesktop(name) && desktopRunning()) {
        notes.push(`# dsh ${name} skipped: quit the DeepSeek Harness app to edit it`);
        continue;
      }
      if (action === "status") steps.push(dshStatusStep(name, provider, paths));
      else steps.push(dshMutateStep(action, provider as ProviderName, name, paths));
    }
  }
  return { steps, notes };
}

/** The profile the DSH Electron app boots and manages on its own. */
function isDesktop(profile: string): boolean {
  return profile.toLowerCase() === "desktop";
}

function statusStep(
  host: Exclude<Host, "dsh">,
  provider: ProviderName | undefined,
  _profile: undefined,
  paths: ProviderPaths,
): ProviderStep {
  return {
    host,
    line: `${host} providers`,
    apply: () => {
      const names = provider ? [provider] : PROVIDERS;
      return names
        .map((name) => {
          const state = readHostProvider(host, name, paths);
          const note = state.note ? ` (${state.note})` : "";
          return `${host} ${name} ${state.on ? "on" : "off"}${note}`;
        })
        .join("\n");
    },
  };
}

function dshStatusStep(profile: string, provider: ProviderName | undefined, paths: ProviderPaths): ProviderStep {
  return {
    host: "dsh",
    line: `dsh ${profile} providers`,
    apply: () => {
      const names = provider ? [provider] : PROVIDERS;
      return names
        .map((name) => {
          const state = readDshProvider(name, profile, paths.dshHome);
          const note = state.note ? ` (${state.note})` : "";
          return `dsh ${profile} ${name} ${state.on ? "on" : "off"}${note}`;
        })
        .join("\n");
    },
  };
}

function readHostProvider(
  host: Exclude<Host, "dsh">,
  provider: ProviderName,
  paths: ProviderPaths,
): { on: boolean; note?: string } {
  if (host === "omp" && OMP_NATIVE[provider]) return { on: false, note: `not provided: ${OMP_NATIVE[provider]}` };
  if (host === "pi" && !piPackageInstalled(paths.piSettings)) {
    return { on: false, note: "package not installed" };
  }
  const on = resolveSelection(readSelectionFile(paths.selection))[provider];
  return { on, note: on ? undefined : "not registered" };
}

function piPackageInstalled(settingsPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("packages" in parsed)) {
    return false;
  }
  const packages = parsed.packages;
  if (!Array.isArray(packages)) return false;
  const base = dirname(settingsPath);
  return packages.some((entry) => {
    const source = typeof entry === "string" ? entry : sourceOf(entry);
    return source === PI_SOURCE || isPiBundleSource(source, base);
  });
}

function sourceOf(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("source" in entry)) return "";
  return typeof entry.source === "string" ? entry.source : "";
}

function mutateStep(
  action: Exclude<ProviderAction, "status">,
  host: Exclude<Host, "dsh">,
  provider: ProviderName,
  paths: ProviderPaths,
): ProviderStep | undefined {
  const enabled = action === "enable";
  const native = host === "omp" ? OMP_NATIVE[provider] : undefined;
  if (native) {
    const line = `omp ${provider} off (nothing to change: ${native})`;
    return { host, line, apply: () => line };
  }
  if (host === "pi" && !piPackageInstalled(paths.piSettings)) {
    return {
      host,
      line: `pi ${provider} ${enabled ? "on" : "off"}`,
      apply: () => ({ error: "pi package @ngosangns/ns-pi-provider is not installed" }),
    };
  }
  return {
    host,
    line: `${host} ${paths.selection}: ${provider} ${enabled ? "on" : "off"}`,
    apply: () => {
      const next = writeProvider(paths.selection, provider, enabled);
      return `${provider} ${next[provider] ? "on" : "off"}`;
    },
  };
}

function dshMutateStep(
  action: Exclude<ProviderAction, "status">,
  provider: ProviderName,
  profile: string,
  paths: ProviderPaths,
): ProviderStep {
  const enabled = action === "enable";
  const patch = join(paths.dshHome, "profiles", profile, "cordis.patch.yml");
  return {
    host: "dsh",
    line: `dsh ${profile} ${DSH_ID[provider]} ${enabled ? "on" : "off"} (${patch})`,
    apply: () => writeDshProvider(patch, provider, enabled),
  };
}

function readDshProvider(
  provider: ProviderName,
  profile: string,
  dshHome: string,
): { on: boolean; note?: string } {
  const patch = join(dshHome, "profiles", profile, "cordis.patch.yml");
  let raw: string;
  try {
    raw = readFileSync(patch, "utf8");
  } catch {
    return { on: false, note: "patch missing" };
  }
  const state = dshPluginState(raw, provider);
  if (state === "missing") return { on: false, note: "not installed" };
  return { on: state === "on" };
}

function writeDshProvider(patch: string, provider: ProviderName, enabled: boolean): string | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(patch, "utf8");
  } catch {
    return { error: `dsh patch not found: ${patch}` };
  }
  const id = DSH_ID[provider];
  const state = dshPluginState(raw, provider);
  if (state === "missing") return { error: `${DSH_PLUGIN[provider]} is not in ${patch}` };
  if (enabled === (state === "on")) return `${id} already ${enabled ? "on" : "off"}`;
  writeFileSync(patch, setDshPluginEnabled(raw, provider, enabled), "utf8");
  return `${id} ${enabled ? "on" : "off"}`;
}

export function formatProviderPlan(plan: ProviderPlan, apply: boolean): string[] {
  const lines = apply ? [] : ["# dry-run (run without --dry-run to apply)"];
  for (const step of plan.steps) lines.push(step.line);
  lines.push(...plan.notes);
  return lines;
}

export type { ProviderSelection };
