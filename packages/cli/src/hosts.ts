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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
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
  /** Skip notes a run prints after its steps: profiles left untouched and why. */
  notes: string[];
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
  return join(dshHome(paths), "profiles", profile, "cordis.patch.yml");
}

function dshHome(paths: HostPaths): string {
  return paths.env.DSH_HOME ?? join(paths.home, ".dsh");
}

/** Profile directory names DSH would boot: profile dirs with a package.json. */
const PROFILE_BACKUP = /\.bak/i;

/**
 * Live profiles under `<dsh>/profiles`: directories with a package.json, so
 * backup copies (named `*.bak*`) and pnpm's `node_modules` are not swept.
 */
export function dshProfiles(dshHome: string): string[] {
  const root = join(dshHome, "profiles");
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => !PROFILE_BACKUP.test(name) && existsSync(join(root, name, "package.json")))
    .sort();
}

/**
 * Whether the DSH Electron app is running. It holds the desktop profile's
 * patch file in memory and rewrites it, so an edit while it runs can be lost.
 */
export function dshDesktopRunning(): boolean {
  const probe = spawnSync("pgrep", ["-f", "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"], {
    encoding: "utf8",
  });
  return !probe.error && probe.status === 0;
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
 * The steps `ns-bridge` would run. DSH sweeps every profile when no
 * `--profile` is given. The Electron-owned `desktop` profile installs through
 * its package.json and pnpm (the app refuses `dsh plugin` there) and is
 * skipped while the app runs, since it holds the patch file in memory.
 */
export function planHostCommands(
  action: HostAction,
  hosts: readonly Host[],
  profile: string | undefined,
  paths: HostPaths = defaultHostPaths(),
  desktopRunning: () => boolean = dshDesktopRunning,
): HostPlan {
  const wantsDsh = hosts.includes("dsh");
  const profiles = wantsDsh ? (profile ? [profile] : dshProfiles(dshHome(paths))) : [];
  const notes: string[] = [];
  if (wantsDsh && profile && profile.toLowerCase() === "desktop" && desktopRunning()) {
    return { steps: [], notes, error: 'quit the DeepSeek Harness app to edit the "desktop" profile' };
  }
  if (wantsDsh && !profile && profiles.length === 0) {
    notes.push(`# dsh skipped: no DSH profiles under ${join(dshHome(paths), "profiles")}`);
  }
  if (action !== "uninstall") {
    if (isNpxCache(paths.cliRoot)) {
      return {
        steps: [],
        notes,
        error:
          "the CLI is running from an npx cache; host plugins would point at a temporary path. " +
          `Run it from a global install: npm install -g ${CLI_PACKAGE}`,
      };
    }
    const missing = missingBundles(hosts, profiles, paths);
    if (missing) return { steps: [], notes, error: missing };
  }

  const steps: HostStep[] = [];
  for (const host of hosts) {
    if (host === "pi") steps.push(...piSteps(action, paths));
    else if (host === "omp") steps.push(...ompSteps(action, paths));
    else
      for (const name of profiles) {
        if (isDesktop(name) && desktopRunning()) {
          notes.push(`# dsh ${name} skipped: quit the DeepSeek Harness app to edit it`);
          continue;
        }
        steps.push(...dshSteps(action, name, paths, isDesktop(name)));
      }
  }
  return { steps, notes };
}

/** The profile the DSH Electron app boots and manages on its own. */
function isDesktop(profile: string): boolean {
  return profile.toLowerCase() === "desktop";
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
    // Both npm plugins must go before the bundle registers: ns-omp-provider-kiro
    // would register the same providers twice, and the npm ns-omp-provider shares
    // the bundle's manifest name. On an already-migrated host this drops the
    // linked bundle and the install below registers it again.
    { host: "omp", argv: ["omp", "plugin", "uninstall", ...OMP_LEGACY_PACKAGES], tolerate: true },
    { host: "omp", argv: ["omp", "plugin", "install", hostBundleDir(paths, "omp")] },
  ];
}

function dshSteps(action: HostAction, profile: string, paths: HostPaths, desktop: boolean): HostStep[] {
  const patch = dshPatchPath(paths, profile);
  if (desktop) {
    // The Electron app refuses `dsh plugin` for its own profile: rewrite the
    // profile's dependencies directly and let pnpm resolve them.
    const dir = join(dshHome(paths), "profiles", profile);
    const deps = action === "uninstall" ? "drop" : "sync";
    return [
      { host: "dsh", label: `${deps} ns-dsh-llm-* deps in ${join(dir, "package.json")}`, apply: () => syncDshDeps(dir, action, paths) },
      { host: "dsh", argv: ["pnpm", "install", "--dir", dir] },
      action === "uninstall"
        ? { host: "dsh", label: `remove provider blocks from ${patch}`, apply: () => removeDshPatch(patch) }
        : { host: "dsh", label: `ensure provider blocks in ${patch}`, apply: () => ensureDshPatch(patch) },
    ];
  }
  if (action === "uninstall") {
    return [
      { host: "dsh", argv: ["dsh", "plugin", "--profile", profile, "remove", ...DSH_PACKAGES] },
      { host: "dsh", label: `remove provider blocks from ${patch}`, apply: () => removeDshPatch(patch) },
    ];
  }
  const links = PROVIDERS.map((provider) => `link:${dshBundleDir(paths, provider)}`);
  return [
    // The npm registry packages the CLI used to ship go first: a profile holding
    // both ns-dsh-llm-kiro and the link would load the same plugin twice.
    { host: "dsh", argv: ["dsh", "plugin", "--profile", profile, "remove", ...DSH_PACKAGES], tolerate: true },
    { host: "dsh", argv: ["dsh", "plugin", "--profile", profile, "add", ...links] },
    { host: "dsh", label: `ensure provider blocks in ${patch}`, apply: () => ensureDshPatch(patch) },
  ];
}

/** Rewrite the desktop profile's ns-dsh-llm-* dependencies for this action. */
function syncDshDeps(dir: string, action: HostAction, paths: HostPaths): string | { error: string } {
  const file = join(dir, "package.json");
  const raw = readOrEmpty(file);
  if (typeof raw !== "string") return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${file} is not valid JSON: ${describe(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${file} is not a package object` };
  }
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    return { error: `${file} has no dependencies object` };
  }
  const packages = dependencies as Record<string, unknown>;
  let changed = 0;
  for (const provider of PROVIDERS) {
    const name = DSH_PLUGIN[provider];
    if (action === "uninstall") {
      if (name in packages) {
        delete packages[name];
        changed += 1;
      }
      continue;
    }
    const link = `link:${dshBundleDir(paths, provider)}`;
    if (packages[name] !== link) {
      packages[name] = link;
      changed += 1;
    }
  }
  if (changed === 0) return `${file}: deps already current`;
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return `${file}: ${action === "uninstall" ? "dropped" : "synced"} ${changed} ns-dsh-llm-* dep${changed === 1 ? "" : "s"}`;
}

function missingBundles(hosts: readonly Host[], profiles: readonly string[], paths: HostPaths): string | undefined {
  const dirs: string[] = [];
  if (hosts.includes("pi")) dirs.push(hostBundleDir(paths, "pi"));
  if (hosts.includes("omp")) dirs.push(hostBundleDir(paths, "omp"));
  // With no profile to touch, missing DSH bundles must not block Pi and OMP.
  if (hosts.includes("dsh") && profiles.length > 0) {
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
