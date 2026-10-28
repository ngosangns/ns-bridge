/**
 * Which providers this plugin registers. OMP ships `devin`, `xai`, and
 * `xai-oauth` itself, so the plugin carries `kiro`, `arnict`, and `qoder`. The Pi reader
 * is shared with the Pi adapter, which still offers all four; devin and grok
 * in the file or in an env list are ignored here.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ProviderSelection as PiProviderSelection,
  readProviderFile,
  resolveProviderSelection as resolvePiProviderSelection,
  selectionFilePath,
} from "@ngosangns/ns-pi-provider/selection";

export interface ProviderSelection {
  kiro: boolean;
  arnict: boolean;
  qoder: boolean;
}

/** Providers OMP provides on its own. Naming one of these is a no-op. */
export const OMP_NATIVE_PROVIDERS = ["devin", "grok"] as const;

export function resolveProviderSelection(
  env: NodeJS.ProcessEnv = process.env,
  file: Partial<PiProviderSelection> = readProviderFile(selectionFilePath(env)),
): ProviderSelection {
  const selection = resolvePiProviderSelection(env, file);
  return { kiro: selection.kiro, arnict: selection.arnict, qoder: selection.qoder };
}

export { readProviderFile };

/** Whether ns-omp-provider-kiro sits in the plugin dir OMP uses, ~/.omp/plugins or the active profile's. */
export function dedicatedKiroInstalled(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const profile = env.OMP_PROFILE ?? env.PI_PROFILE;
  const root = profile ? join(home, ".omp", "profiles", profile) : join(home, ".omp");
  return existsSync(join(root, "plugins", "node_modules", "ns-omp-provider-kiro"));
}

/**
 * Whether this plugin registers `kiro`. ns-omp-provider-kiro owns the id whenever
 * it is installed, whatever the selection file or env says: two plugins
 * registering one provider id leave the winner to plugin load order.
 */
export function shouldRegisterKiro(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (dedicatedKiroInstalled(env, home)) return false;
  return resolveProviderSelection(env).kiro;
}
