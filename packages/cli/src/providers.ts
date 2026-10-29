/**
 * `ns-bridge providers` — turn kiro, devin, grok, arnict, or qoder on or off.
 *
 * Pi and OMP register from one file, `~/.ns-bridge/providers.json`. The
 * extensions read it at launch; this command writes it. DSH has no such
 * file: the profile patch carries `disabled: true` on the plugin id.
 *
 * OMP ships `devin`, `xai`, and `xai-oauth` itself and takes `kiro`, `arnict`,
 * and `qoder` from this project, so devin and grok are not a choice for `omp`.
 * Their keys in the shared file stay for Pi and are ignored by the OMP plugin.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DSH_ID, DSH_PLUGIN, dshPluginState, setDshPluginEnabled } from "./dsh-patch.js";
import { type Host, isPiBundleSource, PI_SOURCE, parseHosts } from "./hosts.js";
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
  skipDsh: boolean;
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

export function planProviders(
  action: ProviderAction,
  hostTarget: string | undefined,
  providerTarget: string | undefined,
  profile: string | undefined,
  paths: ProviderPaths,
): ProviderPlan {
  const hosts = parseHosts(hostTarget);
  if ("error" in hosts) return { steps: [], skipDsh: false, error: hosts.error };
  if (action !== "status" && hosts.length !== 1) {
    return { steps: [], skipDsh: false, error: "enable and disable need one host: pi, omp, or dsh" };
  }

  let provider: ProviderName | undefined;
  if (providerTarget) {
    const parsed = parseProvider(providerTarget);
    if (typeof parsed !== "string") return { steps: [], skipDsh: false, error: parsed.error };
    provider = parsed;
  } else if (action !== "status") {
    return {
      steps: [],
      skipDsh: false,
      error: "enable and disable need a provider: kiro, devin, grok, arnict, or qoder",
    };
  }

  if (action === "enable" && provider && hosts.includes("omp") && OMP_NATIVE[provider]) {
    return {
      steps: [],
      skipDsh: false,
      error: `omp does not use ns-bridge for ${provider}: ${OMP_NATIVE[provider]}`,
    };
  }

  const wantsDsh = hosts.includes("dsh");
  if (wantsDsh && profile?.toLowerCase() === "desktop") {
    return {
      steps: [],
      skipDsh: false,
      error: 'profile "desktop" is managed by the DSH Electron app; pass another profile name',
    };
  }
  if (wantsDsh && !profile && hosts.length === 1 && action !== "status") {
    return { steps: [], skipDsh: false, error: "dsh needs --profile <name>" };
  }

  const steps: ProviderStep[] = [];
  for (const host of hosts) {
    if (host === "dsh" && !profile) continue;
    if (action === "status") {
      steps.push(statusStep(host, provider, profile, paths));
      continue;
    }
    const step = mutateStep(action, host, provider as ProviderName, profile, paths);
    if (step) steps.push(step);
  }
  return { steps, skipDsh: wantsDsh && !profile && action !== "status" };
}

function statusStep(
  host: Host,
  provider: ProviderName | undefined,
  profile: string | undefined,
  paths: ProviderPaths,
): ProviderStep {
  return {
    host,
    line: `${host} providers`,
    apply: () => {
      const names = provider ? [provider] : PROVIDERS;
      return names
        .map((name) => {
          const state = readHostProvider(host, name, profile, paths);
          const note = state.note ? ` (${state.note})` : "";
          return `${host} ${name} ${state.on ? "on" : "off"}${note}`;
        })
        .join("\n");
    },
  };
}

function readHostProvider(
  host: Host,
  provider: ProviderName,
  profile: string | undefined,
  paths: ProviderPaths,
): { on: boolean; note?: string } {
  if (host === "dsh") return readDshProvider(provider, profile, paths.dshHome);
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
    return source === PI_SOURCE || source.endsWith("/pi-provider") || isPiBundleSource(source, base);
  });
}

function sourceOf(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("source" in entry)) return "";
  return typeof entry.source === "string" ? entry.source : "";
}

function mutateStep(
  action: Exclude<ProviderAction, "status">,
  host: Host,
  provider: ProviderName,
  profile: string | undefined,
  paths: ProviderPaths,
): ProviderStep | undefined {
  const enabled = action === "enable";
  const native = host === "omp" ? OMP_NATIVE[provider] : undefined;
  if (native) {
    const line = `omp ${provider} off (nothing to change: ${native})`;
    return { host, line, apply: () => line };
  }
  if (host === "dsh") {
    if (!profile) return undefined;
    const patch = join(paths.dshHome, "profiles", profile, "cordis.patch.yml");
    return {
      host,
      line: `dsh ${profile} ${DSH_ID[provider]} ${enabled ? "on" : "off"} (${patch})`,
      apply: () => writeDshProvider(patch, provider, enabled),
    };
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

function readDshProvider(
  provider: ProviderName,
  profile: string | undefined,
  dshHome: string,
): { on: boolean; note?: string } {
  if (!profile) return { on: false, note: "needs --profile" };
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
  if (plan.skipDsh) lines.push("# dsh skipped: pass --profile <name>");
  return lines;
}

export type { ProviderSelection };
