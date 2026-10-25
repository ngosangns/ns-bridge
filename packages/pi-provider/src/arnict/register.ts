/**
 * Arnict provider registration for Pi (provider id: "arnict").
 * Auth: ARNICT_API_KEY or the key file `ns-bridge arnict login` writes. The
 * key rides with each stream via the core; it never lands in provider config.
 * Models: /v1/models discovery with TTL disk cache + bootstrap fallback.
 * Streaming: chat-completions. The key is the session, and the host runs the tools.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  ARNICT_DEFAULT_BASE_URL,
  ARNICT_DEFAULT_CONTEXT_WINDOW,
  ARNICT_DEFAULT_MAX_TOKENS,
  type ArnictModelSpec,
  arnictBootstrapModels,
  arnictModelsFromModelIds,
  fetchArnictModelIds,
  maskArnictKey,
  resolveArnictApiKey,
} from "ns-arnict-core";
import { type CatalogModel, ensureCacheCost, getDefaultCatalogCache } from "../shared/index.js";
import { streamArnictForPi } from "./provider.js";

/** Unified provider id requested by ns-pi-provider. */
export const ARNICT_PROVIDER_ID = "arnict";
export const ARNICT_API = "arnict-chat";

function specsToCatalog(specs: readonly ArnictModelSpec[]): CatalogModel[] {
  return specs.map((spec) => ({
    id: spec.id,
    name: spec.name || spec.id,
    api: ARNICT_API,
    provider: ARNICT_PROVIDER_ID,
    baseUrl: ARNICT_DEFAULT_BASE_URL,
    reasoning: spec.reasoning ?? false,
    input: [...spec.input],
    // Pi costs are USD per 1M tokens, same unit Arnict publishes. No published
    // rates stays 0 rather than a guess, and Arnict bills no cache write.
    cost: ensureCacheCost({
      input: spec.rates?.input ?? 0,
      output: spec.rates?.output ?? 0,
      cacheRead: spec.rates?.cachedInput ?? 0,
      cacheWrite: 0,
    }),
    contextWindow: spec.contextWindow ?? ARNICT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens ?? ARNICT_DEFAULT_MAX_TOKENS,
    ...(spec.compaction ? { compaction: spec.compaction } : {}),
    // Keep the native window on the catalog row (and so in the disk snapshot)
    // when it exceeds the standard window hosts compact inside.
    ...(spec.nativeContextWindow > (spec.contextWindow ?? ARNICT_DEFAULT_CONTEXT_WINDOW)
      ? { nativeContextWindow: spec.nativeContextWindow }
      : {}),
  }));
}

function catalogToProviderModels(models: CatalogModel[]): ProviderModelConfig[] {
  return models.map((m) => {
    // Pi has no maxContextWindow and ignores the extra field; OMP reads it to
    // widen the window only when extended context is on.
    const native = m.nativeContextWindow;
    return {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning ?? false,
      input: [...m.input],
      cost: ensureCacheCost(m.cost),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      ...(typeof native === "number" && native > m.contextWindow ? { maxContextWindow: native } : {}),
    };
  });
}

function bootstrapFallback(): { models: ProviderModelConfig[]; fromCache: false; source: "fallback" } {
  return {
    models: catalogToProviderModels(specsToCatalog(arnictBootstrapModels())),
    fromCache: false,
    source: "fallback",
  };
}

export async function refreshArnictModels(
  options: {
    force?: boolean;
    /** When false (the default), a cache miss returns the bootstrap list and does not hit the network. */
    allowNetwork?: boolean;
    cache?: ReturnType<typeof getDefaultCatalogCache>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{
  models: ProviderModelConfig[];
  fromCache: boolean;
  source: "live" | "fallback" | "cache";
  error?: string;
}> {
  const cache = options.cache ?? getDefaultCatalogCache();

  if (!options.force) {
    const lookup = cache.lookup<CatalogModel>(ARNICT_PROVIDER_ID);
    if (lookup.hit && lookup.snapshot.models.length > 0) {
      return {
        models: catalogToProviderModels(lookup.snapshot.models),
        fromCache: true,
        source: "cache",
      };
    }
    if (options.allowNetwork !== true) {
      // A file past the 15-minute TTL is still the list the picker should show.
      // fromCache stays false so OMP does not lock that snapshot, or the
      // bootstrap below, as its 24-hour catalog.
      const stale = lookup.snapshot;
      if (stale && stale.models.length > 0) {
        return {
          models: catalogToProviderModels(stale.models),
          fromCache: false,
          source: "cache",
        };
      }
      return bootstrapFallback();
    }
  } else if (options.allowNetwork !== true) {
    return bootstrapFallback();
  }

  try {
    const key = await resolveArnictApiKey();
    if (!key) {
      return { ...bootstrapFallback(), error: "no Arnict API key: run `ns-bridge arnict login`" };
    }
    const ids = await fetchArnictModelIds({
      apiKey: key.apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const catalog = specsToCatalog(arnictModelsFromModelIds(ids));
    cache.store(ARNICT_PROVIDER_ID, catalog, { version: "arnict-v1" });
    return {
      models: catalogToProviderModels(catalog),
      fromCache: false,
      source: "live",
    };
  } catch (err) {
    // Core error messages are already redacted; a failed probe must not
    // overwrite a catalog on disk, so nothing is stored here.
    return {
      ...bootstrapFallback(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function createProviderConfig(models: ProviderModelConfig[]) {
  return {
    name: "Arnict",
    baseUrl: ARNICT_DEFAULT_BASE_URL,
    // Placeholder so Pi marks the provider configured. The real key resolves
    // in the core from the env or the key file and must never sit in config.
    apiKey: "arnict",
    api: ARNICT_API,
    models,
    streamSimple: streamArnictForPi,
    // OMP awaits this at startup and caches a non-null list for 24h. Only a
    // TTL hit is returned. An expired disk snapshot is already on `models`
    // for the picker, and the bootstrap fallback is not stored, so both stay
    // null here and do not become that authoritative list.
    fetchDynamicModels: async () => {
      const latest = await refreshArnictModels({ allowNetwork: false });
      if (!latest.fromCache || latest.models.length === 0) return null;
      return latest.models;
    },
    async refreshModels() {
      // Pi may ask for a network refresh while opening a session. The /v1/models
      // probe runs only from `ns-bridge models refresh`.
      return models;
    },
  };
}

export async function registerArnictProvider(pi: ExtensionAPI): Promise<void> {
  // Serves the disk cache or the bootstrap list; registration never touches
  // the network.
  let refreshed = await refreshArnictModels({ allowNetwork: false });
  let models = refreshed.models;

  const commandHandler = async (
    args: string,
    ctx: {
      hasUI: boolean;
      ui: { notify: (msg: string, level: "info" | "warning" | "error") => void };
    },
  ) => {
    const action = (args.trim().split(/\s+/)[0] || "status").toLowerCase();
    const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
      if (ctx.hasUI) ctx.ui.notify(msg, level);
    };

    if (action === "status") {
      const key = await resolveArnictApiKey();
      notify(
        [
          `provider: ${ARNICT_PROVIDER_ID}`,
          key ? `key: yes (${key.source}) ${maskArnictKey(key.apiKey)}` : "no key: run ns-bridge arnict login",
          `models: ${models.length} (${refreshed.source})`,
        ].join("\n"),
        key ? "info" : "warning",
      );
      return;
    }

    if (action === "models") {
      notify(`Arnict models (${refreshed.source}):\n${models.map((m) => `• ${m.id}`).join("\n") || "(none)"}`);
      return;
    }

    if (action === "refresh" || action === "refresh-models") {
      notify("Refresh Arnict models with `ns-bridge models refresh arnict --apply`.", "info");
      return;
    }

    notify(`Unknown action "${action}". Try: status, models, refresh`, "warning");
  };

  pi.registerCommand("arnict", {
    description: "Arnict provider: /arnict status | models | refresh",
    handler: commandHandler,
  });

  // Without a key there is nothing to stream with: the command above is the
  // signpost, and no provider is registered.
  const key = await resolveArnictApiKey();
  if (!key) return;

  const sameIds = (next: ProviderModelConfig[]) =>
    models.length === next.length && models.every((model, index) => model.id === next[index]?.id);
  const publish = (next: Awaited<ReturnType<typeof refreshArnictModels>>, force = false) => {
    if (!force && sameIds(next.models)) {
      refreshed = next;
      return;
    }
    models = next.models;
    refreshed = next;
    const config = createProviderConfig(models);
    pi.registerProvider(ARNICT_PROVIDER_ID, config as never);
  };
  publish(refreshed, true);

  // A catalog written while extensions were loading (or after startup, by
  // `ns-bridge models refresh arnict --apply`) is republished here.
  pi.on("session_start", () => {
    void refreshArnictModels({ allowNetwork: false }).then((next) => publish(next));
  });
}

export default registerArnictProvider;
