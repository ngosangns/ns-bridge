/**
 * `ns-bridge` command dispatcher.
 *
 * Mutating commands print the host argv and exit 0. `--apply` runs them.
 * That matches the OKF tools in ns-docs: a preview is the default, and a write
 * is an explicit flag.
 */

import { spawn } from "node:child_process";
import { ompConfigPath, planAgents } from "./agents.js";
import { type CatalogPaths, catalogPaths, formatCatalog, parseVendors, readCatalogs, type Vendor } from "./catalog.js";
import { formatCommand, type HostAction, parseHosts, planHostCommands } from "./hosts.js";
import { formatProviderPlan, type ProviderPaths, planProviders, providerPaths } from "./providers.js";
import { defaultModelRefresh, type ModelRefresh, refreshLine } from "./refresh.js";
import { currentVersion, PACKAGE_NAME, parseNpmVersion, planSelfUpdate } from "./self.js";

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
  paths?: CatalogPaths;
  now?: number;
  providerPaths?: ProviderPaths;
  ompConfig?: string;
  /** Installed CLI version. Tests pass this so they do not read package.json. */
  version?: string;
}

const HELP = `ns-bridge — install, update, and refresh providers outside Pi, OMP, and DSH.

Mutating commands preview and do not spawn. Pass --apply to run them.
--dry-run is the default.

Usage:
  ns-bridge install [pi|omp|dsh|all] [--apply] [--profile <name>]
  ns-bridge update [--apply]
  ns-bridge update <pi|omp|dsh|all> [--apply] [--profile <name>]
  ns-bridge uninstall [pi|omp|dsh|all] [--apply] [--profile <name>]
  ns-bridge providers status [pi|omp|dsh|all] [kiro|devin|grok] [--profile <name>]
  ns-bridge providers enable|disable <pi|omp|dsh> <kiro|devin|grok> [--apply] [--profile <name>]
  ns-bridge agents status omp [name]
  ns-bridge agents enable|disable omp <name> [--apply]
  ns-bridge models list [kiro|devin|grok|all]
  ns-bridge models refresh [kiro|devin|grok|all] [--apply]
  ns-bridge status
  ns-bridge help

Hosts:
  pi   pi install npm:@ngosangns/ns-pi-provider
       pi update --extension npm:@ngosangns/ns-pi-provider
       pi uninstall npm:@ngosangns/ns-pi-provider
  omp  omp plugin install ns-omp-provider ns-omp-provider-kiro
       omp plugin upgrade ns-omp-provider ns-omp-provider-kiro
       omp plugin uninstall ns-omp-provider ns-omp-provider-kiro
  dsh  dsh plugin --profile <name> add ns-dsh-llm-kiro ns-dsh-llm-devin ns-dsh-llm-grok
       dsh plugin --profile <name> update …
       dsh plugin --profile <name> remove …

providers enable/disable writes the host's own switch:
  pi, omp   ~/.ns-bridge/providers.json (the extension reads it at launch)
  dsh       disabled: true on the plugin id in the profile's cordis.patch.yml
agents enable/disable edits omp's task.disabledAgents. Pi and dsh have no such list.

DSH requires --profile. Profile "desktop" is refused: the Electron app owns it.
install/update <host> without --profile skips DSH and still previews Pi and OMP.
These commands install the npm packages. A local Pi path stays until that install runs.

update with no host updates this CLI. It looks up the latest @ngosangns/ns-bridge
on npm and, with --apply, runs npm install -g @ngosangns/ns-bridge@<latest>.
It does not touch host plugins. A host argument updates those plugins instead.

Model catalogs are files the hosts read. Providers do not refresh them.
This command writes those files:
  ns-bridge models refresh --apply
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
    return printCatalogs(log, options, ["kiro", "devin", "grok"], "status");
  }
  if (command === "models") {
    if (target !== "list" && target !== "refresh") {
      err("usage: ns-bridge models list|refresh [kiro|devin|grok|all]");
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
  if (command === "providers" || command === "agents") {
    return runToggle(command, parsed, log, err, options);
  }
  err(`unknown command ${command}`);
  err("run ns-bridge help");
  return 1;
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
    log("# dry-run (pass --apply to run)");
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
    log("# dry-run (pass --apply to run)");
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
  const plan = planHostCommands(action, hosts, parsed.profile);
  if (plan.error) {
    err(plan.error);
    return 1;
  }
  if (!parsed.apply) {
    log("# dry-run (pass --apply to run)");
    for (const argv of plan.commands) log(formatCommand(argv));
    if (plan.skipDsh) log("# dsh skipped: pass --profile <name>");
    return 0;
  }
  const runner = options.runner ?? spawnRunner();
  for (const argv of plan.commands) {
    log(formatCommand(argv));
    const result = await runner(argv);
    if (result.stdout.trim()) log(result.stdout.trimEnd());
    if (result.code !== 0) {
      if (result.stderr.trim()) err(result.stderr.trimEnd());
      err(`${formatCommand(argv)} exited ${result.code}`);
      return 2;
    }
  }
  if (plan.skipDsh) log("# dsh skipped: pass --profile <name>");
  return 0;
}

async function runToggle(
  command: "providers" | "agents",
  parsed: Parsed,
  log: (line: string) => void,
  err: (line: string) => void,
  options: RunOptions,
): Promise<number> {
  const action = parsed.positionals[1];
  const host = parsed.positionals[2];
  const name = parsed.positionals[3];
  if (action !== "enable" && action !== "disable" && action !== "status") {
    err(`usage: ns-bridge ${command} enable|disable|status …`);
    return 1;
  }
  if (parsed.positionals.length > 4) {
    err(`unexpected argument ${parsed.positionals[4]}`);
    return 1;
  }
  if (command === "agents") {
    const plan = planAgents(action, host, name, options.ompConfig ?? ompConfigPath());
    if (plan.error) {
      err(plan.error);
      return 1;
    }
    if (!parsed.apply && action !== "status") {
      log("# dry-run (pass --apply to run)");
      for (const step of plan.steps) log(step.line);
      return 0;
    }
    return applySteps(plan.steps, log, err);
  }
  const plan = planProviders(action, host, name, parsed.profile, options.providerPaths ?? providerPaths());
  if (plan.error) {
    err(plan.error);
    return 1;
  }
  if (!parsed.apply && action !== "status") {
    for (const line of formatProviderPlan(plan, false)) log(line);
    return 0;
  }
  return applySteps(plan.steps, log, err);
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
}

function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const positionals: string[] = [];
  let apply = false;
  let profile: string | undefined;
  let help = false;
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
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      apply = false;
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
    if (arg.startsWith("-")) return { error: `unknown flag ${arg}` };
    positionals.push(arg);
  }
  return { positionals, apply, profile, help };
}
