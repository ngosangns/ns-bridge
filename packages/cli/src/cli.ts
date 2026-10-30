/**
 * `ns-bridge` command dispatcher.
 *
 * Mutating commands apply by default. `--dry-run` prints the host argv and
 * exits 0 without spawning. A write is the default; a preview is the explicit
 * flag.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type ArnictIo, runArnict } from "./arnict.js";
import { type CatalogPaths, catalogPaths, formatCatalog, parseVendors, readCatalogs, type Vendor } from "./catalog.js";
import {
  dshDesktopRunning,
  defaultHostPaths,
  formatCommand,
  type HostAction,
  type HostPaths,
  type HostPlan,
  missingHostBundles,
  parseHosts,
  planHostCommands,
} from "./hosts.js";
import { defaultKiroProfiles, findKiroProfile, formatKiroProfiles, type KiroProfileOps } from "./kiro-profile.js";
import { formatProviderPlan, type ProviderPaths, planProviders, providerPaths } from "./providers.js";
import { defaultModelRefresh, type ModelRefresh, refreshLine } from "./refresh.js";
import { currentVersion, PACKAGE_NAME, parseNpmVersion, planSelfUpdate } from "./self.js";
import { runServe, type ServeBundle } from "./serve.js";
import { formatSession, formatSummary, localDay, readUsage, summarize, usageRoot } from "./usage.js";
import { runZcode } from "./zcode.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[]) => Promise<CommandResult>;

export interface RunOptions {
  log?: (line: string) => void;
  err?: (line: string) => void;
  runner?: Runner;
  refreshers?: ModelRefresh;
  /** Kiro profile listing and pinning. Tests pass fakes; production loads the refresh bundle. */
  kiroProfiles?: KiroProfileOps;
  /** Arnict key login/logout/status I/O. Tests inject env, home, stdin, and fetch. */
  arnictIo?: Partial<ArnictIo>;
  paths?: CatalogPaths;
  now?: number;
  providerPaths?: ProviderPaths;
  /** Usage ledger root. Tests pass a temp dir; production reads ~/.ns-bridge/usage. */
  usageDir?: string;
  /** Serve bundle loader. Tests inject a fake so no vendor core loads. */
  serveBundleLoader?: () => Promise<ServeBundle>;
  /** Serve config path. Tests pass a temp dir; production reads ~/.ns-bridge/zcode.json. */
  serveConfigPath?: string;
  /** ZCode personal provider config path. Tests pass a temp file; production honours ZCODE_PERSONAL_PROVIDER_CONFIG_FILE. */
  zcodeProviderConfigPath?: string;
  /** ns-bridge provider selection file. Tests pass a temp path; production reads ~/.ns-bridge/providers.json. */
  selectionFilePath?: string;
  /** HOME for the ZCode launch agent and its logs. Tests pass a temp dir. */
  home?: string;
  /** Platform override so tests can exercise the darwin-only launch agent. */
  platform?: NodeJS.Platform;
  /** Installed CLI version. Tests pass this so they do not read package.json. */
  version?: string;
  /** Where host bundles, Pi settings, and DSH profiles live. Tests pass a temp tree. */
  hostPaths?: HostPaths;
  /** Whether the DSH desktop app is running. Tests inject; production probes pgrep. */
  desktopRunning?: () => boolean;
}

const HELP = `ns-bridge — install ns-bridge providers into Pi, OMP, and DSH from prebuilt local bundles.

Mutating commands apply by default. Pass --dry-run to preview them without
spawning.

Usage:
  ns-bridge install [pi|omp|dsh|all] [--dry-run] [--profile <name>]
  ns-bridge update [--dry-run]
  ns-bridge update <pi|omp|dsh|all> [--dry-run] [--profile <name>]
  ns-bridge uninstall [pi|omp|dsh|all] [--dry-run] [--profile <name>]
  ns-bridge providers status [pi|omp|dsh|all] [kiro|devin|grok|arnict|qoder] [--profile <name>]
  ns-bridge providers enable|disable <pi|omp|dsh> <kiro|devin|grok|arnict|qoder> [--dry-run] [--profile <name>]
  ns-bridge usage [--vendor <kiro|devin|grok|arnict|qoder>] [--day YYYY-MM-DD] [--days <n>] [--json]
  ns-bridge usage --session <id> [--vendor <name>] [--json]
  ns-bridge models list [kiro|devin|grok|arnict|qoder|all]
  ns-bridge models refresh [kiro|devin|grok|arnict|qoder|all] [--dry-run]
  ns-bridge kiro profile [list]
  ns-bridge kiro profile use <name|region|arn> [--dry-run]
  ns-bridge kiro profile reset [--dry-run]
  ns-bridge serve [--port N] [--host H] [--allow-remote]
  ns-bridge zcode setup [--dry-run] [--vendors <list>] [--default <vendor>/<model>]
           [--force] [--no-service]
  ns-bridge zcode status
  ns-bridge zcode remove [--dry-run] [--force]
  ns-bridge arnict login [--stdin]
  ns-bridge arnict logout
  ns-bridge arnict status [--json]
  ns-bridge status
  ns-bridge help

Hosts:
  The CLI ships prebuilt extensions under its own dist/hosts and registers
  those directories in place; no provider package is fetched from npm.
  pi   pi install <ns-bridge>/dist/hosts/pi
       removes npm:@ngosangns/ns-pi-provider and stale local copies first
  omp  omp plugin install <ns-bridge>/dist/hosts/omp
       removes ns-omp-provider-kiro first and replaces an npm ns-omp-provider.
       OMP has its own devin, xai, and xai-oauth providers (/login devin, /login xai-oauth)
  dsh  scans every profile under ~/.dsh/profiles (directories with a
       package.json) and installs into each; --profile <name> targets one.
       then keeps one insert per provider in the profile's cordis.patch.yml

providers enable/disable writes the host's own switch:
  pi        ~/.ns-bridge/providers.json (the extension reads it at launch)
  omp       the same file, kiro, arnict, and qoder; devin and grok are OMP's own, so they are not offered
  dsh       a "- id: llm-<vendor>" entry with "disabled: true" in the profile's cordis.patch.yml

DSH without --profile applies to every profile. The Electron-owned "desktop"
profile installs through its package.json and pnpm (the app refuses
"dsh plugin" there) and is skipped while the DeepSeek Harness app runs —
quit it first, then re-run.
Install and update are the same command; re-running repairs a moved CLI.

usage reads the ledger the plugins write under ~/.ns-bridge/usage/<day>/<vendor>/<session>.jsonl.
It never calls the network. Hit is cacheRead over prompt tokens, summed, not an average of
per-step ratios. NS_BRIDGE_USAGE=0 stops the plugins from recording.

update with no host updates this CLI. It looks up the latest @ngosangns/ns-bridge
on npm and runs npm install -g @ngosangns/ns-bridge@<latest>.
It does not touch host plugins. A host argument updates those plugins instead.

kiro profile lists the Kiro profiles your login can use and marks the active one.
use pins one in ~/.ns-bridge/kiro-profile.json and fetches its catalog if it has
none yet; reset drops the pin so the login's own profile (kiro-cli's pick) applies.
Hosts read the pin on every request. KIRO_PROFILE_ARN outranks it.

Model catalogs are files the hosts read. Providers do not refresh them.
This command writes those files:
  ns-bridge models refresh

serve runs a local Anthropic-Messages server ZCode can point an Anthropic
client at: http://127.0.0.1:<port>/<vendor>/v1/messages with vendor in
kiro, devin, grok, and GET /<vendor>/v1/models. Port and token live in
~/.ns-bridge/zcode.json, created on first run (NS_BRIDGE_ZCODE_CONFIG moves
the file; NS_BRIDGE_SERVE_TOKEN overrides the token). It binds loopback only;
--host with a non-loopback address needs --allow-remote.

zcode registers those endpoints as personal providers in the ZCode app
(~/.zcode/v2/provider_config.json; ZCODE_PERSONAL_PROVIDER_CONFIG_FILE moves
it). setup writes that file — quit ZCode first, because the app keeps it in
memory and rewrites it when it saves or quits, and restart ZCode afterwards.
setup also installs a launch agent
(dev.ngosangns.ns-bridge.serve) that keeps ns-bridge serve running;
--no-service skips it. remove strips the providers and the agent but leaves
~/.ns-bridge/zcode.json alone. Vendors switched off in
~/.ns-bridge/providers.json are not registered; --vendors kiro,devin narrows
further. --default <vendor>/<model> also makes that model ZCode's default.

arnict stores the Arnict API key in ~/.ns-bridge/arnict.json (NS_BRIDGE_ARNICT_CONFIG
moves it), a 0600 file in a 0700 directory. login reads the key from stdin when it is
piped or --stdin is passed, else prompts hidden. ARNICT_API_KEY outranks the file.
status probes https://api.arnict.com/v1/models (ARNICT_BASE_URL moves it) and redacts
the key from anything it prints.
`;

export function spawnRunner(): Runner {
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({ code: 127, stdout: "", stderr: "empty command" });
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        finish({ code: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code) => {
        finish({ code: code ?? 1, stdout, stderr });
      });
    });
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    err(parsed.error);
    err("run ns-bridge help");
    return 1;
  }
  if (parsed.help || parsed.positionals.length === 0) {
    log(HELP.trimEnd());
    return 0;
  }

  const [command, target, extra] = parsed.positionals;
  if (command === "help") {
    log(HELP.trimEnd());
    return 0;
  }
  if (command === "status") {
    if (target) {
      err(`status takes no arguments (got ${target})`);
      return 1;
    }
    const code = printCatalogs(log, options, ["kiro", "devin", "grok", "arnict", "qoder"], "status");
    const missing = missingHostBundles(options.hostPaths ?? defaultHostPaths());
    if (missing.length > 0) {
      log(`# host bundles missing (${missing.join(", ")}); re-run ns-bridge install`);
    }
    return code;
  }
  if (command === "models") {
    if (target !== "list" && target !== "refresh") {
      err("usage: ns-bridge models list|refresh [kiro|devin|grok|arnict|all]");
      return 1;
    }
    const vendors = parseVendors(extra);
    if ("error" in vendors) {
      err(vendors.error);
      return 1;
    }
    if (parsed.positionals.length > 3) {
      err(`unexpected argument ${parsed.positionals[3]}`);
      return 1;
    }
    if (target === "list") return printCatalogs(log, options, vendors, "list");
    return refreshModels(log, err, parsed.apply, vendors, options);
  }
  if (command === "usage") {
    if (target) {
      err(`usage takes flags, not arguments (got ${target})`);
      return 1;
    }
    return runUsage(parsed, log, err, options);
  }
  if (command === "update" && !target) {
    return runSelfUpdate(parsed, log, err, options);
  }
  if (command === "install" || command === "update" || command === "uninstall") {
    if (parsed.positionals.length > 2) {
      err(`unexpected argument ${extra}`);
      return 1;
    }
    return runHost(command, target, parsed, log, err, options);
  }
  if (command === "providers") {
    return runProviders(parsed, log, err, options);
  }
  if (command === "kiro") {
    return runKiroProfile(parsed, log, err, options);
  }
  if (command === "arnict") {
    if (target !== "login" && target !== "logout" && target !== "status") {
      err("usage: ns-bridge arnict login|logout|status");
      return 1;
    }
    if (parsed.positionals.length > 2) {
      err(`unexpected argument ${parsed.positionals[2]}`);
      return 1;
    }
    return runArnict(target, { stdin: parsed.stdin, json: parsed.json }, options.arnictIo, log, err);
  }
  if (command === "serve") {
    if (parsed.positionals.length > 1) {
      err(`unexpected argument ${parsed.positionals[1]}`);
      return 1;
    }
    return runServe({
      ...(parsed.port !== undefined ? { port: parsed.port } : {}),
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      ...(parsed.token !== undefined ? { token: parsed.token } : {}),
      allowRemote: parsed.allowRemote,
      log,
      err,
      ...(options.serveBundleLoader ? { loadBundle: options.serveBundleLoader } : {}),
      ...(options.serveConfigPath ? { configPath: options.serveConfigPath } : {}),
    });
  }
  if (command === "zcode") {
    if (target !== "setup" && target !== "status" && target !== "remove") {
      err("usage: ns-bridge zcode setup|status|remove");
      return 1;
    }
    if (parsed.positionals.length > 2) {
      err(`unexpected argument ${parsed.positionals[2]}`);
      return 1;
    }
    return runZcode({
      action: target,
      apply: parsed.apply,
      force: parsed.force,
      noService: parsed.noService,
      runner: options.runner ?? spawnRunner(),
      log,
      err,
      ...(parsed.vendors !== undefined ? { vendors: parsed.vendors } : {}),
      ...(parsed.default !== undefined ? { default: parsed.default } : {}),
      ...(options.home ? { home: options.home } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.paths ? { catalogPaths: options.paths } : {}),
      ...(options.zcodeProviderConfigPath ? { providerConfigPath: options.zcodeProviderConfigPath } : {}),
      ...(options.serveConfigPath ? { serveConfigPath: options.serveConfigPath } : {}),
      ...(options.selectionFilePath ? { selectionFilePath: options.selectionFilePath } : {}),
      ...(options.now !== undefined ? { now: new Date(options.now) } : {}),
    });
  }
  err(`unknown command ${command}`);
  err("run ns-bridge help");
  return 1;
}

function runUsage(
  parsed: Parsed,
  log: (line: string) => void,
  err: (line: string) => void,
  options: RunOptions,
): number {
  if (parsed.vendor && !["kiro", "devin", "grok", "arnict", "qoder"].includes(parsed.vendor)) {
    err(`unknown vendor ${parsed.vendor} (kiro, devin, grok, arnict, qoder)`);
    return 1;
  }
  if (parsed.day && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.day)) {
    err("--day needs YYYY-MM-DD");
    return 1;
  }
  const root = options.usageDir ?? usageRoot();
  const { records, skipped } = readUsage(root, {
    day: parsed.day,
    days: parsed.days,
    vendor: parsed.vendor,
    session: parsed.session,
  });
  if (parsed.json) {
    for (const record of records) log(JSON.stringify(record));
  } else if (parsed.session) {
    for (const line of formatSession(records)) log(line);
  } else {
    for (const line of formatSummary(summarize(records, localDay))) log(line);
    if (records.length === 0) log(`# nothing under ${root}; plugins write there unless NS_BRIDGE_USAGE=0`);
  }
  if (skipped > 0) err(`# skipped ${skipped} unreadable line${skipped === 1 ? "" : "s"}`);
  return 0;
}

function printCatalogs(
  log: (line: string) => void,
  options: RunOptions,
  vendors: readonly Vendor[],
  mode: "list" | "status",
): number {
  const paths = options.paths ?? catalogPaths();
  const now = options.now ?? Date.now();
  for (const report of readCatalogs(paths, vendors)) {
    for (const line of formatCatalog(report, mode, now)) log(line);
  }
  return 0;
}

async function refreshModels(
  log: (line: string) => void,
  err: (line: string) => void,
  apply: boolean,
  vendors: readonly Vendor[],
  options: RunOptions,
): Promise<number> {
  if (!apply) {
    log("# dry-run (run without --dry-run to apply)");
    for (const vendor of vendors) log(`refresh ${vendor}`);
    return 0;
  }
  const refreshers = options.refreshers ?? (await defaultModelRefresh());
  for (const vendor of vendors) {
    try {
      log(refreshLine(vendor, await refreshers[vendor]()));
    } catch (error) {
      err(`${vendor}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  return 0;
}

async function runSelfUpdate(
  parsed: Parsed,
  log: (line: string) => void,
  err: (line: string) => void,
  options: RunOptions,
): Promise<number> {
  const runner = options.runner ?? spawnRunner();
  const lookup = await runner(["npm", "view", PACKAGE_NAME, "version"]);
  if (lookup.code !== 0) {
    const detail = lookup.stderr.trim() || lookup.stdout.trim() || `exited ${lookup.code}`;
    err(`could not read the latest version from npm: ${detail}`);
    return 2;
  }
  const latest = parseNpmVersion(lookup.stdout);
  if (typeof latest !== "string") {
    err(latest.error);
    return 2;
  }
  const current = options.version ?? currentVersion();
  const plan = planSelfUpdate(current, latest);
  if ("error" in plan) {
    err(plan.error);
    return 1;
  }
  if (plan.currentIsLatest) {
    log(`${PACKAGE_NAME} ${current} is already the latest`);
    return 0;
  }
  if (!parsed.apply) {
    log("# dry-run (run without --dry-run to apply)");
    log(`${PACKAGE_NAME} ${current} → ${latest}`);
    log(formatCommand(plan.command));
    return 0;
  }
  log(formatCommand(plan.command));
  const result = await runner(plan.command);
  if (result.stdout.trim()) log(result.stdout.trimEnd());
  if (result.code !== 0) {
    if (result.stderr.trim()) err(result.stderr.trimEnd());
    err(`${formatCommand(plan.command)} exited ${result.code}`);
    return 2;
  }
  log(`${PACKAGE_NAME} updated ${current} → ${latest}`);
  return 0;
}

async function runHost(
  action: HostAction,
  target: string | undefined,
  parsed: Parsed,
  log: (line: string) => void,
  err: (line: string) => void,
  options: RunOptions,
): Promise<number> {
  const hosts = parseHosts(target);
  if ("error" in hosts) {
    err(hosts.error);
    return 1;
  }
  const plan = planHostCommands(action, hosts, parsed.profile, options.hostPaths ?? defaultHostPaths(), () =>
    options.desktopRunning ? options.desktopRunning() : dshDesktopRunning(),
  );
  if (plan.error) {
    err(plan.error);
    return 1;
  }
  if (!parsed.apply) {
    log("# dry-run (run without --dry-run to apply)");
    for (const line of planLines(plan)) log(line);
    return 0;
  }
  const runner = options.runner ?? spawnRunner();
  for (const step of plan.steps) {
    if (!step.argv) continue;
    log(formatCommand(step.argv));
    const result = await runner(step.argv);
    if (result.stdout.trim()) log(result.stdout.trimEnd());
    if (result.code === 0) continue;
    if (step.tolerate) {
      log(`# ignored: ${formatCommand(step.argv)} exited ${result.code}`);
      continue;
    }
    if (result.stderr.trim()) err(result.stderr.trimEnd());
    err(`${formatCommand(step.argv)} exited ${result.code}`);
    return 2;
  }
  for (const step of plan.steps) {
    if (!step.apply) continue;
    const result = step.apply();
    if (typeof result !== "string") {
      err(result.error);
      return 1;
    }
    log(result);
  }
  for (const note of plan.notes) log(note);
  return 0;
}

function planLines(plan: HostPlan): string[] {
  const lines = plan.steps.map((step) => (step.argv ? formatCommand(step.argv) : (step.label ?? step.host)));
  lines.push(...plan.notes);
  return lines;
}

async function runKiroProfile(
  parsed: Parsed,
  log: (line: string) => void,
  err: (line: string) => void,
  options: RunOptions,
): Promise<number> {
  const [, area, action = "list", query] = parsed.positionals;
  const usage = "usage: ns-bridge kiro profile [list] | use <name|region|arn> | reset";
  if (area !== "profile" || (action !== "list" && action !== "use" && action !== "reset")) {
    err(usage);
    return 1;
  }
  const allowed = action === "use" ? 4 : 3;
  if (parsed.positionals.length > allowed) {
    err(`unexpected argument ${parsed.positionals[allowed]}`);
    return 1;
  }
  if (action === "use" && !query) {
    err("kiro profile use needs a profile name, region, or ARN");
    return 1;
  }
  if (parsed.profile) {
    err("--profile names a DSH profile; pass the Kiro profile as an argument");
    return 1;
  }

  const ops = options.kiroProfiles ?? (await defaultKiroProfiles());
  if (action === "reset") {
    const pinned = existsSync(ops.selectionPath);
    const noPin = `no pin at ${ops.selectionPath}; Kiro already follows the login's profile`;
    if (!parsed.apply) {
      log("# dry-run (run without --dry-run to apply)");
      log(pinned ? `remove ${ops.selectionPath}` : noPin);
      return 0;
    }
    if (!pinned) {
      log(noPin);
      return 0;
    }
    ops.select(undefined);
    log(`removed ${ops.selectionPath}; Kiro follows the login's profile again`);
    warnProfileEnv(err);
    return 0;
  }

  let listing: Awaited<ReturnType<KiroProfileOps["list"]>>;
  try {
    listing = await ops.list();
  } catch (error) {
    err(`kiro: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (action === "list") {
    for (const line of formatKiroProfiles(listing)) log(line);
    return 0;
  }

  const match = findKiroProfile(listing.profiles, query ?? "");
  if ("error" in match) {
    err(match.error);
    return 1;
  }
  const label = `${match.name ?? match.arn} (${match.region})`;
  if (match.unlisted) {
    err(`# ${match.arn} is not in this login's listing; Kiro rejects requests if the login cannot use it`);
  }
  if (!parsed.apply) {
    log("# dry-run (run without --dry-run to apply)");
    log(`pin ${label} in ${ops.selectionPath}`);
    return 0;
  }
  ops.select({ arn: match.arn, ...(match.name ? { name: match.name } : {}) });
  log(`pinned ${label} in ${ops.selectionPath}`);
  warnProfileEnv(err);
  // A fetch would catalog whichever profile the env var names, not this pin.
  if (process.env.KIRO_PROFILE_ARN?.trim()) {
    log("# the pin takes effect once KIRO_PROFILE_ARN is unset");
    return 0;
  }
  // A profile seen before switches with no fetch; a new one needs its catalog once.
  if (!ops.hasCatalog(match.arn)) {
    const refreshers = options.refreshers ?? (await defaultModelRefresh());
    try {
      log(refreshLine("kiro", await refreshers.kiro()));
    } catch (error) {
      err(`kiro: ${error instanceof Error ? error.message : String(error)}`);
      err("the pin is saved; run ns-bridge models refresh kiro to fetch its catalog");
      return 2;
    }
  }
  log("# requests use it from the next turn; restart the host to reload its model list");
  return 0;
}

function warnProfileEnv(err: (line: string) => void): void {
  if (process.env.KIRO_PROFILE_ARN?.trim()) err("# KIRO_PROFILE_ARN is set and outranks the pin");
}

async function runProviders(
  parsed: Parsed,
  log: (line: string) => void,
  err: (line: string) => void,
  options: RunOptions,
): Promise<number> {
  const action = parsed.positionals[1];
  const host = parsed.positionals[2];
  const name = parsed.positionals[3];
  if (action !== "enable" && action !== "disable" && action !== "status") {
    err("usage: ns-bridge providers enable|disable|status …");
    return 1;
  }
  if (parsed.positionals.length > 4) {
    err(`unexpected argument ${parsed.positionals[4]}`);
    return 1;
  }
  const plan = planProviders(action, host, name, parsed.profile, options.providerPaths ?? providerPaths(), () =>
    options.desktopRunning ? options.desktopRunning() : dshDesktopRunning(),
  );
  if (plan.error) {
    err(plan.error);
    return 1;
  }
  if (!parsed.apply && action !== "status") {
    for (const line of formatProviderPlan(plan, false)) log(line);
    return 0;
  }
  const code = applySteps(plan.steps, log, err);
  for (const note of plan.notes) log(note);
  return code;
}

function applySteps(
  steps: readonly { apply: () => string | { error: string } }[],
  log: (line: string) => void,
  err: (line: string) => void,
): number {
  for (const step of steps) {
    const result = step.apply();
    if (typeof result !== "string") {
      err(result.error);
      return 1;
    }
    log(result);
  }
  return 0;
}

interface Parsed {
  positionals: string[];
  apply: boolean;
  profile?: string;
  help: boolean;
  stdin: boolean;
  vendor?: string;
  day?: string;
  days?: number;
  session?: string;
  json: boolean;
  port?: number;
  host?: string;
  token?: string;
  allowRemote: boolean;
  vendors?: string;
  default?: string;
  force: boolean;
  noService: boolean;
}

function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const positionals: string[] = [];
  let apply = true;
  let profile: string | undefined;
  let help = false;
  let stdin = false;
  let vendor: string | undefined;
  let day: string | undefined;
  let days: number | undefined;
  let session: string | undefined;
  let json = false;
  let port: number | undefined;
  let host: string | undefined;
  let token: string | undefined;
  let allowRemote = false;
  let vendors: string | undefined;
  let defaultModel: string | undefined;
  let force = false;
  let noService = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--apply") {
      return { error: "--apply was removed; mutating commands apply by default. Pass --dry-run to preview." };
    }
    if (arg === "--dry-run") {
      apply = false;
      continue;
    }
    if (arg === "--allow-remote") {
      allowRemote = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--no-service") {
      noService = true;
      continue;
    }
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) return { error: "--profile needs a name" };
      profile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (!value) return { error: "--profile needs a name" };
      profile = value;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--stdin") {
      stdin = true;
      continue;
    }
    const valued = [
      "--vendor",
      "--day",
      "--days",
      "--session",
      "--host",
      "--port",
      "--token",
      "--vendors",
      "--default",
    ].find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (valued) {
      const value = arg === valued ? argv[index + 1] : arg.slice(valued.length + 1);
      if (!value || (arg === valued && value.startsWith("-"))) return { error: `${valued} needs a value` };
      if (arg === valued) index += 1;
      if (valued === "--vendor") vendor = value;
      else if (valued === "--day") day = value;
      else if (valued === "--session") session = value;
      else if (valued === "--host") host = value;
      else if (valued === "--token") token = value;
      else if (valued === "--vendors") vendors = value;
      else if (valued === "--default") defaultModel = value;
      else if (valued === "--port") {
        const parsedPort = Number(value);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
          return { error: "--port needs a whole number between 1 and 65535" };
        port = parsedPort;
      } else {
        const parsedDays = Number(value);
        if (!Number.isInteger(parsedDays) || parsedDays < 1)
          return { error: "--days needs a whole number of at least 1" };
        days = parsedDays;
      }
      continue;
    }
    if (arg.startsWith("-")) return { error: `unknown flag ${arg}` };
    positionals.push(arg);
  }
  return {
    positionals,
    apply,
    profile,
    help,
    stdin,
    vendor,
    day,
    days,
    session,
    json,
    port,
    host,
    token,
    allowRemote,
    vendors,
    default: defaultModel,
    force,
    noService,
  };
}
