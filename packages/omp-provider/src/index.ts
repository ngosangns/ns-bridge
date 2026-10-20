/**
 * ns-omp-provider — OMP (oh-my-pi) extension exposing the Kiro, Devin, and Grok
 * providers from @ngosangns/ns-pi-provider.
 *
 * The ns-pi-provider sources are bundled into dist/index.js at build time with
 * their `@earendil-works/pi-ai*` imports redirected to ./compat (OMP's pi-ai +
 * Pi 1.0 transcript helpers). At runtime the OMP ExtensionAPI is wrapped so
 * Pi-shaped provider configs, contexts, and events map onto OMP's.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerAllProviders } from "@ngosangns/ns-pi-provider";
import { readProviderFile } from "@ngosangns/ns-pi-provider/selection";

import { wrapExtensionApi } from "./adapter.js";
import { resolveProviderSelection } from "./config.js";

export { adaptProviderConfig, toPiContext, toOmpApiKey, toFetchDynamicModels, wrapExtensionApi } from "./adapter.js";
export { resolveProviderSelection } from "./config.js";

export default async function nsOmpProvider(pi: object): Promise<void> {
  const selection = resolveProviderSelection();
  // ns-omp-provider-kiro owns the kiro id while it is installed. A file or
  // env list that names kiro is an explicit choice, so this plugin registers it.
  if (selection.kiro && !kiroChosen() && dedicatedKiroInstalled()) selection.kiro = false;
  if (!selection.kiro && !selection.devin && !selection.grok) return;
  await registerAllProviders(wrapExtensionApi(pi), selection);
}

function kiroChosen(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = readProviderFile(env.NS_BRIDGE_PROVIDERS ?? join(homedir(), ".ns-bridge", "providers.json"));
  if (file.kiro !== undefined) return true;
  return [env.NS_OMP_PROVIDERS, env.NS_OMP_PROVIDER_ENABLE, env.NS_OMP_PROVIDER_DISABLE].some((value) =>
    value?.split(/[\s,]+/).some((item) => item.trim().toLowerCase() === "kiro"),
  );
}

/** The plugin dir OMP keeps at ~/.omp/plugins, or under the active profile. */
function dedicatedKiroInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = env.OMP_PROFILE ?? env.PI_PROFILE;
  const root = profile ? join(homedir(), ".omp", "profiles", profile) : join(homedir(), ".omp");
  return existsSync(join(root, "plugins", "node_modules", "ns-omp-provider-kiro"));
}
