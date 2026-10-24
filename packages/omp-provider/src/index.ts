/**
 * ns-omp-provider — OMP (oh-my-pi) extension exposing the Kiro provider from
 * @ngosangns/ns-pi-provider.
 *
 * OMP ships `devin`, `xai`, and `xai-oauth` itself, so this plugin no longer
 * registers `devin` or `grok` (`/login devin`, `/login xai-oauth`). Only the
 * Kiro registration is bundled into dist/index.js at build time, with its
 * `@earendil-works/pi-ai*` imports redirected to ./compat (OMP's pi-ai + Pi 1.0
 * transcript helpers). At runtime the OMP ExtensionAPI is wrapped so Pi-shaped
 * provider configs, contexts, and events map onto OMP's.
 */
import { registerKiroProvider } from "@ngosangns/ns-pi-provider/kiro";
import { setUsageHost } from "ns-bridge-core";

import { wrapExtensionApi } from "./adapter.js";
import { shouldRegisterKiro } from "./config.js";

export { adaptProviderConfig, toFetchDynamicModels, toOmpApiKey, toPiContext, wrapExtensionApi } from "./adapter.js";
export {
  dedicatedKiroInstalled,
  OMP_NATIVE_PROVIDERS,
  resolveProviderSelection,
  shouldRegisterKiro,
} from "./config.js";

export default async function nsOmpProvider(pi: object): Promise<void> {
  setUsageHost("omp");
  // ns-omp-provider-kiro owns the kiro id while it is installed.
  if (!shouldRegisterKiro()) return;
  try {
    await registerKiroProvider(wrapExtensionApi(pi));
  } catch (err) {
    console.warn(`[ns-omp-provider] kiro registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
