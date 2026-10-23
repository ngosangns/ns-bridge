/**
 * Which providers this plugin registers. OMP ships `devin`, `xai`, and
 * `xai-oauth` itself, so the only provider left is `kiro`. The Pi reader is
 * shared with the Pi adapter, which still offers all three; devin and grok in
 * the file or in an env list are ignored here.
 */

import {
  type ProviderSelection as PiProviderSelection,
  readProviderFile,
  resolveProviderSelection as resolvePiProviderSelection,
  selectionFilePath,
} from "@ngosangns/ns-pi-provider/selection";

export interface ProviderSelection {
  kiro: boolean;
}

/** Providers OMP provides on its own. Naming one of these is a no-op. */
export const OMP_NATIVE_PROVIDERS = ["devin", "grok"] as const;

export function resolveProviderSelection(
  env: NodeJS.ProcessEnv = process.env,
  file: Partial<PiProviderSelection> = readProviderFile(selectionFilePath(env)),
): ProviderSelection {
  return { kiro: resolvePiProviderSelection(env, file).kiro };
}

export { readProviderFile };
