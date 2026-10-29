/**
 * What `ns-bridge install|update|uninstall <host>` runs.
 *
 * The CLI ships prebuilt extensions under `dist/hosts/**`, and each host
 * registers that directory in place. Nothing comes from npm any more, so
 * install and update also migrate a host off the plugins the CLI used to
 * fetch: the Pi npm extension, the OMP kiro plugin, and the DSH registry
 * packages.
 *
 * Mutating commands apply unless `--dry-run`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_PLUGIN, ensureDshPlugin, removeDshPlugin } from "./dsh-patch.js";
import { PROVIDERS, type ProviderName } from "./selection.js";

export const CLI_PACKAGE = "@ngosangns/ns-bridge";
export const PI_SOURCE = "npm:@ngosangns/ns-pi-provider";
/** npm plugins the CLI used to install. Install/update migrates off them; uninstall removes them. */
export const OMP_LEGACY_PACKAGES = ["ns-omp-provider-kiro", "ns-omp-provider"] as const;
export const DSH_PACKAGES: readonly string[] = PROVIDERS.map((provider) => DSH_PLUGIN[provider]);

export type Host = "pi" | "omp" | "dsh";
export type HostAction = "install" | "update" | "uninstall";

export interface HostPaths {
  /** Package root of the running CLI: the directory that contains `dist/`. */
  cliRoot: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

export interface HostStep {
  host: Host;
  /** What a dry run prints for a step that has no argv. */
  label?: string;
  /** A host CLI command. A local step has neither argv nor command output. */
  argv?: string[];
  /** A non-zero exit is reported and skipped instead of aborting the plan. */
  tolerate?: boolean;
  /** Local edit, run after every command in the plan has succeeded. */
  apply?: () => string | { error: string };
}

export interface HostPlan {
  steps: HostStep[];
  /** `install all` has no profile, so DSH is left out of the preview. */
  skipDsh: boolean;
  error?: string;
}

const HOSTS: readonly Host[] = ["pi", "omp", "dsh"];

export function parseHosts(target: string | undefined): Host[] | { error: string } {
  if (!target || target === "all") return [...HOSTS];
  if (target === "pi" || target === "omp" || target === "dsh") return [target];
  return { error: `unknown host ${target} (expected pi, omp, dsh, or all)` };
}

export function defaultHostPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): HostPaths {
  return { cliRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."), env, home };
}

/** The prebuilt Pi or OMP extension directory. */
export function hostBundleDir(paths: HostPaths, host: Exclude<Host, "dsh">): string {
  return join(paths.cliRoot, "dist", "hosts", host);
}

/** The prebuilt extension directory for one DSH provider. */
export function dshBundleDir(paths: HostPaths, provider: ProviderName): string {
  return join(paths.cliRoot, "dist", "hosts", "dsh", provider);
}

/**
 * Bundle directories this CLI ships, labelled for `status`. A host that was
 * installed from this CLI points into them, so a missing one means the host is
 * broken until `install` runs again from the new location.
 */
export function missingHostBundles(paths: HostPaths): string[] {
  const dirs: Array<[string, string]> = [
    ["pi", hostBundleDir(paths, "pi")],
    ["omp", hostBundleDir(paths, "omp")],
    ...PROVIDERS.map((provider): [string, string] => [`dsh/${provider}`, dshBundleDir(paths, provider)]),
  ];
  return dirs.filter(([, dir]) => !hasBundle(dir)).map(([label]) => label);
}

function hasBundle(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "dist", "index.js"));
}

export function piSettingsPath(paths: HostPaths): string {
  return join(paths.env.PI_CODING_AGENT_DIR ?? join(paths.home, ".pi", "agent"), "settings.json");
}

export function dshPatchPath(paths: HostPaths, profile: string): string {
  return join(paths.env.DSH_HOME ?? join(paths.home, ".dsh"), "profiles", profile, "cordis.patch.yml");
}

/** Quote one argv element the way a shell would show it. */
export function formatCommand(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The steps `ns-bridge` would run. DSH always needs `--profile`.
 * Profile `desktop` is refused: the Electron app owns that profile.
 */
export function planHostCommands(
  action: HostAction,
  hosts: readonly Host[],
  profile: string | undefined,
  paths: HostPaths = defaultHostPaths(),
): HostPlan {
  const wantsDsh = hosts.includes("dsh");
  if (wantsDsh && profile?.toLowerCase() === "desktop") {
    return {
      steps: [],
      skipDsh: false,
      error: 'profile "desktop" is managed by the DSH Electron app; pass another profile name',
    };
  }
  if (wantsDsh && !profile && hosts.length === 1) {
    return { steps: [], skipDsh: false, error: "dsh needs --profile <name>" };
  }
  if (action !== "uninstall") {
    if (isNpxCache(paths.cliRoot)) {
      return {
        steps: [],
        skipDsh: false,
        error:
          "the CLI is running from an npx cache; host plugins would point at a temporary path. " +
          `Run it from a global install: npm install -g ${CLI_PACKAGE}`,
      };
    }
    const missing = missingBundles(hosts, profile, paths);
    if (missing) return { steps: [], skipDsh: false, error: missing };
  }

  const steps: HostStep[] = [];
  for (const host of hosts) {
    if (host === "dsh" && !profile) continue;
    if (host === "pi") steps.push(...piSteps(action, paths));
    else if (host === "omp") steps.push(...ompSteps(action, paths));
    else steps.push(...dshSteps(action, profile as string, paths));
  }
  return { steps, skipDsh: wantsDsh && !profile };
}

function piSteps(action: HostAction, paths: HostPaths): HostStep[] {
  const bundle = hostBundleDir(paths, "pi");
  const settings = piSettingsPath(paths);
  if (action === "uninstall") {
    return [
      { host: "pi", argv: ["pi", "uninstall", bundle], tolerate: true },
      { host: "pi", argv: ["pi", "uninstall", PI_SOURCE], tolerate: true },
    ];
  }
  return [
    // A Pi entry from the old npm package would register the same providers twice.
    { host: "pi", argv: ["pi", "uninstall", PI_SOURCE], tolerate: true },
    { host: "pi", argv: ["pi", "install", bundle] },
    { host: "pi", label: `prune stale local entries in ${settings}`, apply: () => prunePiSettings(settings, bundle) },
  ];
}

function ompSteps(action: HostAction, paths: HostPaths): HostStep[] {
  if (action === "uninstall") {
    return [{ host: "omp", argv: ["omp", "plugin", "uninstall", ...OMP_LEGACY_PACKAGES] }];
  }
  return [
    // The bundle carries kiro now, so the separate kiro plugin must go first.
    { host: "omp", argv: ["omp", "plugin", "uninstall", "ns-omp-provider-kiro"], tolerate: true },
    { host: "omp", argv: ["omp", "plugin", "install", hostBundleDir(paths, "omp")] },
  ];
}

function dshSteps(action: HostAction, profile: string, paths: HostPaths): HostStep[] {
  const patch = dshPatchPath(paths, profile);
  if (action === "uninstall") {
    return [
      { host: "dsh", argv: ["dsh", "plugin", "--profile", profile, "remove", ...DSH_PACKAGES] },
      { host: "dsh", label: `remove provider blocks from ${patch}`, apply: () => removeDshPatch(patch) },
    ];
  }
  const links = PROVIDERS.map((provider) => `link:${dshBundleDir(paths, provider)}`);
  return [
    { host: "dsh", argv: ["dsh", "plugin", "--profile", profile, "add", ...links] },
    { host: "dsh", label: `ensure provider blocks in ${patch}`, apply: () => ensureDshPatch(patch) },
  ];
}

function missingBundles(hosts: readonly Host[], profile: string | undefined, paths: HostPaths): string | undefined {
  const dirs: string[] = [];
  if (hosts.includes("pi")) dirs.push(hostBundleDir(paths, "pi"));
  if (hosts.includes("omp")) dirs.push(hostBundleDir(paths, "omp"));
  if (hosts.includes("dsh") && profile) {
    for (const provider of PROVIDERS) dirs.push(dshBundleDir(paths, provider));
  }
  const missing = dirs.filter((dir) => !hasBundle(dir));
  if (missing.length === 0) return undefined;
  return `host bundles are missing under ${missing.join(", ")}; reinstall ${CLI_PACKAGE}`;
}

function isNpxCache(cliRoot: string): boolean {
  return cliRoot.split(sep).includes("_npx");
}

/**
 * Drops Pi entries that point at another copy of the prebuilt extension (an
 * older CLI, or an npx cache) so Pi does not register the providers twice.
 * The entry the plan just installed stays.
 */
function prunePiSettings(settingsPath: string, current: string): string | { error: string } {
  const raw = readOrEmpty(settingsPath);
  if (typeof raw !== "string") return raw;
  if (raw.trim() === "") return `${settingsPath}: no local entries to prune`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${settingsPath} is not valid JSON: ${describe(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${settingsPath} is not a settings object` };
  }
  const record = parsed as Record<string, unknown>;
  const packages = record.packages;
  if (!Array.isArray(packages)) return `${settingsPath}: no packages to prune`;
  const base = dirname(settingsPath);
  const kept = packages.filter((entry) => !isStalePiBundle(entry, base, current));
  const removed = packages.length - kept.length;
  if (removed === 0) return `${settingsPath}: no stale local entries`;
  record.packages = kept;
  writeFileSync(settingsPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return `${settingsPath}: removed ${removed} stale local entr${removed === 1 ? "y" : "ies"}`;
}

function isStalePiBundle(entry: unknown, baseDir: string, current: string): boolean {
  const source = typeof entry === "string" ? entry : piEntrySource(entry);
  if (!source) return false;
  const resolved = resolvePiSource(source, baseDir);
  if (resolved === undefined || !isPiBundlePath(resolved)) return false;
  return normalize(resolved) !== normalize(current);
}

/** Whether a Pi `packages` source points at a prebuilt ns-bridge extension. */
export function isPiBundleSource(source: string, baseDir: string): boolean {
  const resolved = resolvePiSource(source, baseDir);
  return resolved !== undefined && isPiBundlePath(resolved);
}

function piEntrySource(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("source" in entry)) return undefined;
  return typeof entry.source === "string" ? entry.source : undefined;
}

/** A local path Pi could have recorded; npm and git sources are not local. */
function resolvePiSource(source: string, baseDir: string): string | undefined {
  if (source.startsWith("file:")) return resolve(baseDir, source.slice("file:".length));
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[A-Za-z]:[\\/]/.test(source)) return undefined;
  return resolve(baseDir, source);
}

function isPiBundlePath(path: string): boolean {
  return normalize(path)
    .replace(/[\\/]+$/, "")
    .endsWith(join("dist", "hosts", "pi"));
}

function ensureDshPatch(patch: string): string | { error: string } {
  const raw = readOrEmpty(patch);
  if (typeof raw !== "string") return raw;
  let next = raw;
  for (const provider of PROVIDERS) next = ensureDshPlugin(next, provider);
  if (next === raw) return `${patch}: provider blocks already present`;
  mkdirSync(dirname(patch), { recursive: true });
  writeFileSync(patch, next, "utf8");
  return `${patch}: provider blocks written`;
}

function removeDshPatch(patch: string): string | { error: string } {
  const raw = readOrEmpty(patch);
  if (typeof raw !== "string") return raw;
  if (raw.trim() === "") return `${patch}: not found`;
  let next = raw;
  for (const provider of PROVIDERS) next = removeDshPlugin(next, provider);
  if (next === raw) return `${patch}: no ns-bridge provider blocks`;
  writeFileSync(patch, next, "utf8");
  return `${patch}: ns-bridge provider blocks removed`;
}

function readOrEmpty(path: string): string | { error: string } {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    return { error: `could not read ${path}: ${describe(error)}` };
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
