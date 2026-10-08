/**
 * ns-omp-provider — OMP (oh-my-pi) extension exposing the Kiro, Devin, and Grok
 * providers from @ngosangns/ns-pi-provider.
 *
 * The ns-pi-provider sources are bundled into dist/index.js at build time with
 * their `@earendil-works/pi-ai*` imports redirected to ./compat (OMP's pi-ai +
 * Pi 1.0 transcript helpers). At runtime the OMP ExtensionAPI is wrapped so
 * Pi-shaped provider configs, contexts, and events map onto OMP's.
 */
import { registerAllProviders } from "@ngosangns/ns-pi-provider";

import { wrapExtensionApi } from "./adapter.js";
import { resolveProviderSelection } from "./config.js";

export { adaptProviderConfig, toPiContext, toOmpApiKey, toFetchDynamicModels, wrapExtensionApi } from "./adapter.js";
export { resolveProviderSelection } from "./config.js";

export default async function nsOmpProvider(pi: object): Promise<void> {
  const selection = resolveProviderSelection();
  if (!selection.kiro && !selection.devin && !selection.grok) return;
  await registerAllProviders(wrapExtensionApi(pi), selection);
}
