/**
 * `ns-bridge plugin install` command.
 *
 * Installs a DSH plugin bundle into coding agent profiles (Pi, OMP, DSH).
 * The bundle must have a package.json with a name field.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultHostPaths,
  dshDesktopRunning,
  dshPatchPath,
  dshProfiles,
  formatCommand,
  type Host,
  type HostPaths,
  type HostStep,
} from "./hosts.js";

export interface PluginInstallOptions {
  bundlePath: string;
  host: Host | "all";
  profile?: string;
  apply: boolean;
  log: (line: string) => void;
  err: (line: string) => void;
  hostPaths?: HostPaths;
  desktopRunning?: () => boolean;
}

export interface PluginInstallResult {
  code: number;
}

/**
 * Install a plugin bundle into one or more hosts.
 */
export async function runPluginInstall(options: PluginInstallOptions): Promise<PluginInstallResult> {
  const { bundlePath, host, profile, apply, log, err } = options;
  const paths = options.hostPaths ?? defaultHostPaths();
  const desktopRunning = options.desktopRunning ?? dshDesktopRunning;

  // Validate bundle path
  if (!existsSync(bundlePath)) {
    err(`bundle not found: ${bundlePath}`);
    return { code: 1 };
  }

  const packageJsonPath = join(bundlePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    err(`bundle missing package.json: ${packageJsonPath}`);
    return { code: 1 };
  }

  // Read plugin name from package.json
  let pluginName: string;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    pluginName = pkg.name;
    if (!pluginName) {
      err(`package.json missing name field: ${packageJsonPath}`);
      return { code: 1 };
    }
  } catch (error) {
    err(`could not read ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1 };
  }

  // Determine which hosts to install to
  const hosts: Host[] = host === "all" ? ["pi", "omp", "dsh"] : [host];

  // Build installation steps
  const steps: HostStep[] = [];
  const notes: string[] = [];

  for (const targetHost of hosts) {
    if (targetHost === "pi") {
      steps.push({
        host: "pi",
        argv: ["pi", "plugin", "install", bundlePath],
      });
    } else if (targetHost === "omp") {
      steps.push({
        host: "omp",
        argv: ["omp", "plugin", "install", bundlePath],
      });
    } else if (targetHost === "dsh") {
      // DSH can target a specific profile or all profiles
      const dshHome = paths.env.DSH_HOME ?? join(paths.home, ".dsh");
      const profiles = profile ? [profile] : dshProfiles(dshHome);

      if (profile && profile.toLowerCase() === "desktop" && desktopRunning()) {
        notes.push(`# dsh ${profile} skipped: quit the DeepSeek Harness app to edit it`);
        continue;
      }

      if (profiles.length === 0) {
        notes.push(`# dsh skipped: no DSH profiles found`);
        continue;
      }

      for (const profileName of profiles) {
        if (isDesktop(profileName) && desktopRunning()) {
          notes.push(`# dsh ${profileName} skipped: quit the DeepSeek Harness app to edit it`);
          continue;
        }

        // For desktop profile, we would need to edit package.json dependencies
        // For now, document this as not yet supported
        if (isDesktop(profileName)) {
          notes.push(`# dsh ${profileName}: desktop profile plugin install not yet supported`);
          continue;
        }

        const patchPath = dshPatchPath(paths, profileName);
        steps.push({
          host: "dsh",
          label: `add ${pluginName} to ${patchPath}`,
          apply: () => addPluginToPatch(patchPath, pluginName),
        });
      }
    }
  }

  // Execute or preview
  if (!apply) {
    log("# dry-run (run without --dry-run to apply)");
    for (const step of steps) {
      if (step.argv) {
        log(formatCommand(step.argv));
      } else if (step.label) {
        log(step.label);
      }
    }
    for (const note of notes) {
      log(note);
    }
    return { code: 0 };
  }

  // Execute steps
  const runner = (argv: string[]) => {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  for (const step of steps) {
    if (step.argv) {
      log(formatCommand(step.argv));
      const result = await runner(step.argv);
      if (result.stdout.trim()) log(result.stdout.trimEnd());
      if (result.code !== 0) {
        if (step.tolerate) {
          log(`# ignored: ${formatCommand(step.argv)} exited ${result.code}`);
          continue;
        }
        if (result.stderr.trim()) err(result.stderr.trimEnd());
        err(`${formatCommand(step.argv)} exited ${result.code}`);
        return { code: 2 };
      }
    } else if (step.apply) {
      const result = step.apply();
      if (typeof result !== "string") {
        err(result.error);
        return { code: 1 };
      }
      log(result);
    }
  }

  for (const note of notes) {
    log(note);
  }

  return { code: 0 };
}

function isDesktop(profile: string): boolean {
  return profile.toLowerCase() === "desktop";
}

function addPluginToPatch(patchPath: string, pluginName: string): string | { error: string } {
  let raw = "";
  try {
    raw = readFileSync(patchPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `could not read ${patchPath}: ${message}` };
    }
  }

  // Check if plugin is already present
  if (raw.includes(`name: '${pluginName}'`) || raw.includes(`name: "${pluginName}"`)) {
    return `${patchPath}: ${pluginName} already present`;
  }

  // Add the plugin block
  const block = `- insert:\n    - id: ${pluginName.replace(/^ns-dsh-/, "")}\n      name: '${pluginName}'`;

  let next: string;
  if (raw.trim() === "") {
    next = `# ns-bridge plugin\n${block}\n`;
  } else if (raw.trim() === "[]") {
    next = `# ns-bridge plugin\n${block}\n`;
  } else {
    next = `${raw.replace(/\s+$/, "")}\n\n${block}\n`;
  }

  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, next, "utf8");
  return `${patchPath}: added ${pluginName}`;
}
