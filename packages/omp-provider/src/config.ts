/**
 * Which providers this plugin registers. OMP ships `devin`, `xai`, and
 * `xai-oauth` itself, so the plugin carries `kiro`, `arnict`, and `qoder`. The Pi reader
 * is shared with the Pi adapter, which still offers all four; devin and grok
 * in the file or in an env list are ignored here.
 */

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
