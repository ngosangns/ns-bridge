/** Host package commands. Mutating commands apply unless `--dry-run`. */

export const PI_SOURCE = "npm:@ngosangns/ns-pi-provider";
/**
 * OMP ships `devin`, `xai`, and `xai-oauth` itself, so only Kiro comes from a
 * plugin. `ns-omp-provider` (the old plugin that also registered `devin` and
 * `grok`) is no longer installed or upgraded; uninstall still removes it.
 */
export const OMP_PACKAGES = ["ns-omp-provider-kiro"] as const;
export const OMP_LEGACY_PACKAGES = ["ns-omp-provider"] as const;
export const DSH_PACKAGES = ["ns-dsh-llm-kiro", "ns-dsh-llm-devin", "ns-dsh-llm-grok"] as const;

export type Host = "pi" | "omp" | "dsh";
export type HostAction = "install" | "update" | "uninstall";

export interface HostPlan {
  commands: string[][];
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
 * The commands `ns-bridge` would run. DSH always needs `--profile`.
 * Profile `desktop` is refused: the Electron app owns that profile.
 */
export function planHostCommands(action: HostAction, hosts: readonly Host[], profile: string | undefined): HostPlan {
  const wantsDsh = hosts.includes("dsh");
  if (wantsDsh && profile?.toLowerCase() === "desktop") {
    return {
      commands: [],
      skipDsh: false,
      error: 'profile "desktop" is managed by the DSH Electron app; pass another profile name',
    };
  }
  if (wantsDsh && !profile) {
    if (hosts.length === 1) {
      return { commands: [], skipDsh: false, error: "dsh needs --profile <name>" };
    }
  }

  const commands: string[][] = [];
  for (const host of hosts) {
    if (host === "dsh" && !profile) continue;
    commands.push(commandFor(action, host, profile));
  }
  return { commands, skipDsh: wantsDsh && !profile };
}

function commandFor(action: HostAction, host: Host, profile: string | undefined): string[] {
  if (host === "pi") {
    if (action === "install") return ["pi", "install", PI_SOURCE];
    if (action === "update") return ["pi", "update", "--extension", PI_SOURCE];
    return ["pi", "uninstall", PI_SOURCE];
  }
  if (host === "omp") {
    const verb = action === "update" ? "upgrade" : action === "uninstall" ? "uninstall" : "install";
    return [
      "omp",
      "plugin",
      verb,
      ...(action === "uninstall" ? [...OMP_PACKAGES, ...OMP_LEGACY_PACKAGES] : OMP_PACKAGES),
    ];
  }
  const verb = action === "update" ? "update" : action === "uninstall" ? "remove" : "add";
  return ["dsh", "plugin", "--profile", profile ?? "", verb, ...DSH_PACKAGES];
}
