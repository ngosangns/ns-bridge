/**
 * ns-omp-provider — OMP (oh-my-pi) extension exposing the Kiro and Arnict
 * providers from @ngosangns/ns-pi-provider.
 *
 * OMP ships `devin`, `xai`, and `xai-oauth` itself, so this plugin no longer
 * registers `devin` or `grok` (`/login devin`, `/login xai-oauth`). The Kiro
 * and Arnict registrations are bundled into dist/index.js at build time, with
 * their `@earendil-works/pi-ai*` imports redirected to ./compat (OMP's pi-ai +
 * Pi 1.0 transcript helpers). At runtime the OMP ExtensionAPI is wrapped so
 * Pi-shaped provider configs, contexts, and events map onto OMP's. Arnict
 * registers only its /arnict command until an Arnict API key (env or key file)
 * is present.
 */
import { registerArnictProvider } from "@ngosangns/ns-pi-provider/arnict";
import { registerKiroProvider } from "@ngosangns/ns-pi-provider/kiro";
import { registerQoderProvider } from "@ngosangns/ns-pi-provider/qoder";
import { setUsageHost } from "ns-bridge-core";

import { wrapExtensionApi } from "./adapter.js";
import { resolveProviderSelection, shouldRegisterKiro } from "./config.js";

export {
  ARNICT_PROVIDER_ID,
  adaptProviderConfig,
  mapArnictModelsForOmp,
  ompWindowForThreshold,
  toFetchDynamicModels,
  toOmpApiKey,
  toPiContext,
  wrapExtensionApi,
} from "./adapter.js";
export {
  dedicatedKiroInstalled,
  OMP_NATIVE_PROVIDERS,
  resolveProviderSelection,
  shouldRegisterKiro,
} from "./config.js";

export default async function nsOmpProvider(pi: object): Promise<void> {
  setUsageHost("omp");
  // ns-omp-provider-kiro owns the kiro id while it is installed.
  if (shouldRegisterKiro()) {
    try {
      await registerKiroProvider(wrapExtensionApi(pi));
    } catch (err) {
      console.warn(`[ns-omp-provider] kiro registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (resolveProviderSelection().arnict) {
    try {
      await registerArnictProvider(wrapExtensionApi(pi));
    } catch (err) {
      console.warn(`[ns-omp-provider] arnict registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (resolveProviderSelection().qoder) {
    try {
      await registerQoderProvider(wrapExtensionApi(pi));
    } catch (err) {
      console.warn(`[ns-omp-provider] qoder registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
