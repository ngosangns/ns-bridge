/**
 * Qoder provider registration for Pi (provider id: "qoder").
 * Auth: `qodercli login` or QODER_PERSONAL_ACCESS_TOKEN.
 * Models: SDK model list with TTL disk cache + bootstrap fallback.
 * Streaming: one agent-sdk query per host turn; the host runs the tools.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { BridgeEffort } from "ns-bridge-core";
import { toPiThinkingLevelMap } from "ns-bridge-core/pi";
import {
  fetchQoderModels,
  QODER_DEFAULT_CONTEXT_WINDOW,
  QODER_DEFAULT_MAX_TOKENS,
  type QoderModelSpec,
  qoderBootstrapModels,
  resolveQoderAuth,
} from "ns-qoder-core";
import { type CatalogModel, ensureCacheCost, getDefaultCatalogCache } from "../shared/index.js";
import { streamQoderForPi } from "./provider.js";

export const QODER_PROVIDER_ID = "qoder";
export const QODER_API = "qoder-cli";

function specsToCatalog(specs: readonly QoderModelSpec[]): CatalogModel[] {
  return specs.map((spec) => ({
    id: spec.id,
    name: spec.name || spec.id,
    api: QODER_API,
    provider: QODER_PROVIDER_ID,
    baseUrl: "qoder-cli://local",
    reasoning: spec.reasoning ?? false,
    input: [...spec.input],
    cost: ensureCacheCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: spec.contextWindow ?? QODER_DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens ?? QODER_DEFAULT_MAX_TOKENS,
    ...(spec.compaction ? { compaction: spec.compaction } : {}),
    ...(spec.efforts?.length ? { efforts: [...spec.efforts] } : {}),
  }));
}

/** Pi ignores `efforts` and `compaction`; the OMP wrapper reads them. */
type QoderProviderModel = ProviderModelConfig & {
  efforts?: readonly string[];
  compaction?: { thresholdTokens?: number };
};

function catalogToProviderModels(models: CatalogModel[]): ProviderModelConfig[] {
  return models.map((m) => {
    const efforts = m.efforts as readonly string[] | undefined;
    const compaction = m.compaction as { thresholdTokens?: number } | undefined;
    const thinkingLevelMap = toPiThinkingLevelMap(efforts as BridgeEffort[] | undefined);
    return {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning ?? false,
      input: [...m.input],
      cost: ensureCacheCost(m.cost),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(compaction ? { compaction } : {}),
      ...(efforts?.length ? { efforts: [...efforts] } : {}),
    } as QoderProviderModel;
  });
}

function bootstrapFallback(): { models: ProviderModelConfig[]; fromCache: false; source: "fallback" } {
  return {
    models: catalogToProviderModels(specsToCatalog(qoderBootstrapModels())),
    fromCache: false,
    source: "fallback",
  };
}

export function qoderAuthPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveQoderAuth(env));
}

export async function refreshQoderModels(
  options: { force?: boolean; allowNetwork?: boolean; cache?: ReturnType<typeof getDefaultCatalogCache> } = {},
): Promise<{
  models: ProviderModelConfig[];
  fromCache: boolean;
  source: "live" | "fallback" | "cache";
  error?: string;
}> {
  const cache = options.cache ?? getDefaultCatalogCache();

  if (!options.force) {
    const lookup = cache.lookup<CatalogModel>(QODER_PROVIDER_ID);
    if (lookup.hit && lookup.snapshot.models.length > 0) {
      return {
        models: catalogToProviderModels(lookup.snapshot.models),
        fromCache: true,
        source: "cache",
      };
    }
    if (options.allowNetwork !== true) {
      const stale = lookup.snapshot;
      if (stale && stale.models.length > 0) {
        return { models: catalogToProviderModels(stale.models), fromCache: false, source: "cache" };
      }
      return bootstrapFallback();
    }
  } else if (options.allowNetwork !== true) {
    return bootstrapFallback();
  }

  try {
    const auth = resolveQoderAuth();
    if (!auth) {
      return {
        ...bootstrapFallback(),
        error: "no Qoder auth: run `qodercli login` or set QODER_PERSONAL_ACCESS_TOKEN",
      };
    }
    const catalog = specsToCatalog(await fetchQoderModels({ auth }));
    cache.store(QODER_PROVIDER_ID, catalog, { version: "qoder-cli-v1" });
    return { models: catalogToProviderModels(catalog), fromCache: false, source: "live" };
  } catch (err) {
    return { ...bootstrapFallback(), error: err instanceof Error ? err.message : String(err) };
  }
}

function createProviderConfig(models: ProviderModelConfig[]) {
  return {
    name: "Qoder",
    baseUrl: "qoder-cli://local",
    apiKey: "qoder-cli",
    api: QODER_API,
    models,
    streamSimple: streamQoderForPi,
    fetchDynamicModels: async () => {
      const latest = await refreshQoderModels({ allowNetwork: false });
      if (!latest.fromCache || latest.models.length === 0) return null;
      return latest.models;
    },
    async refreshModels() {
      return models;
    },
  };
}

export async function registerQoderProvider(pi: ExtensionAPI): Promise<void> {
  const refreshed = await refreshQoderModels({ allowNetwork: false });
  let models = refreshed.models;

  pi.registerCommand("qoder", {
    description: "Qoder provider: /qoder status | refresh",
    handler: async (args, ctx) => {
      const action = (args.trim().split(/\s+/)[0] || "status").toLowerCase();
      if (action === "status") {
        const authed = qoderAuthPresent();
        const cache = getDefaultCatalogCache().lookup(QODER_PROVIDER_ID);
        ctx.ui.notify(
          [
            `provider: ${QODER_PROVIDER_ID}`,
            `auth: ${authed ? "present" : "missing (qodercli login or QODER_PERSONAL_ACCESS_TOKEN)"}`,
            cache.hit
              ? `models: ${cache.snapshot.models.length} cached`
              : `models: ${models.length} (${refreshed.source})`,
          ].join("\n"),
          "info",
        );
        return;
      }
      if (action === "refresh") {
        ctx.ui.notify("Refresh with `ns-bridge models refresh qoder`.", "info");
        return;
      }
      ctx.ui.notify("Usage: /qoder status | refresh", "warning");
    },
  });

  const publish = (next: ProviderModelConfig[]) => {
    models = next;
    pi.registerProvider(QODER_PROVIDER_ID, createProviderConfig(models) as never);
  };

  publish(models);
}

export default registerQoderProvider;
