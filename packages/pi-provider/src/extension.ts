/**
 * ns-pi-provider — unified Pi extension registering kiro, devin, and grok.
 * Loads gracefully when credentials are missing (fallback models + login hooks).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerKiroProvider, refreshKiroModels, kiroCatalogStatus, KIRO_PROVIDER_ID } from "./kiro/register.js";
import { registerDevinProvider, refreshDevinModels, devinCatalogStatus, DEVIN_PROVIDER_ID } from "./devin/register.js";
import { registerGrokProvider, refreshGrokModels, GROK_PROVIDER_ID } from "./grok/register.js";
import { getDefaultCatalogCache } from "./shared/index.js";
import { resolveProviderSelection } from "./selection.js";

export interface NsPiProviderOptions {
  /** Skip individual providers when false. Default: all enabled. */
  kiro?: boolean;
  devin?: boolean;
  grok?: boolean;
}

export async function registerAllProviders(
  pi: ExtensionAPI,
  options: NsPiProviderOptions = {},
): Promise<void> {
  const enableKiro = options.kiro !== false;
  const enableDevin = options.devin !== false;
  const enableGrok = options.grok !== false;

  if (enableKiro) {
    try {
      await registerKiroProvider(pi);
    } catch (err) {
      console.warn(
        `[ns-pi-provider] kiro registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (enableDevin) {
    try {
      await registerDevinProvider(pi);
    } catch (err) {
      console.warn(
        `[ns-pi-provider] devin registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (enableGrok) {
    try {
      await registerGrokProvider(pi);
    } catch (err) {
      console.warn(
        `[ns-pi-provider] grok registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  pi.registerCommand("ns-pi", {
    description: "ns-pi-provider: /ns-pi refresh | status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] || "status").toLowerCase();
      const target = (parts[1] || "all").toLowerCase();

      if (action === "status") {
        // Kiro and Devin catalogs live in their vendor cores (shared with the
        // OMP and DeepSeek Harness adapters); Grok's in this package's cache.
        const cache = getDefaultCatalogCache();
        const grok = cache.lookup(GROK_PROVIDER_ID);
        const lines = [
          kiroCatalogStatus(),
          devinCatalogStatus(),
          grok.hit
            ? `${GROK_PROVIDER_ID}: ${grok.snapshot.models.length} model(s) cached (age ${Math.round((Date.now() - grok.snapshot.fetchedAt) / 1000)}s)`
            : `${GROK_PROVIDER_ID}: no cache (${grok.reason})`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (action === "refresh") {
        const which = target === "all" ? "" : ` ${target}`;
        ctx.ui.notify(`Refresh model catalogs with \`ns-bridge models refresh${which} --apply\`.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /ns-pi status | refresh [all|kiro|devin|grok]", "warning");
    },
  });
}

export default async function nsPiProviderExtension(pi: ExtensionAPI): Promise<void> {
  await registerAllProviders(pi, resolveProviderSelection());
}

export {
  registerKiroProvider,
  registerDevinProvider,
  registerGrokProvider,
  refreshKiroModels,
  refreshDevinModels,
  refreshGrokModels,
  KIRO_PROVIDER_ID,
  DEVIN_PROVIDER_ID,
  GROK_PROVIDER_ID,
};
