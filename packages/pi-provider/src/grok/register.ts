/**
 * Grok provider registration for Pi (provider id: "grok").
 * Auth: Grok CLI login in ~/.grok/auth.json. The Responses client refreshes that session.
 * A console API key is not a session and is not read.
 * Models: `grok models` CLI discovery with TTL disk cache + static fallback.
 * Streaming: the Responses API. The Grok CLI login is the session, and the host runs the tools.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GROK_DEFAULT_CONTEXT_WINDOW, GROK_DEFAULT_MAX_TOKENS, grokAuthCandidates } from "ns-grok-core";

import { ensureCacheCost, getDefaultCatalogCache, type CatalogModel } from "../shared/index.js";
import { getGrokVersion, probeGrokAuth, resolveGrokBinary } from "ns-grok-core/cli";
import { CLIENT_NAME, CLIENT_VERSION } from "./config.js";
import { discoverModels, fallbackModels, toProviderModels } from "./models.js";
import { streamGrokForPi } from "./provider.js";
import type { GrokModelDescriptor } from "ns-grok-core/cli";

/** Unified provider id requested by ns-pi-provider. */
export const GROK_PROVIDER_ID = "grok";
export const GROK_API = "grok-cli";

function descriptorsToCatalog(descriptors: GrokModelDescriptor[]): CatalogModel[] {
  return descriptors.map((d) => ({
    id: d.id,
    name: d.name ?? d.id,
    api: GROK_API,
    provider: GROK_PROVIDER_ID,
    baseUrl: "grok-cli://local",
    reasoning: d.supportsReasoningEffort ?? true,
    input: ["text"] as Array<"text" | "image">,
    cost: ensureCacheCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: d.contextWindow ?? GROK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: d.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
  }));
}

function catalogToProviderModels(models: CatalogModel[]): ProviderModelConfig[] {
  const thinking = toProviderModels(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      supportsReasoningEffort: m.reasoning ?? true,
    })),
  );
  // Override api field to our unified id while keeping cost.cache*
  return thinking.map((m, i) => ({
    ...m,
    cost: ensureCacheCost(models[i]?.cost ?? m.cost),
  }));
}

function sessionFileHasAccessToken(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.values(parsed).some((value) => {
      if (!value || typeof value !== "object") return false;
      const key = (value as { key?: unknown }).key;
      return typeof key === "string" && key.trim().length > 0;
    });
  } catch {
    return false;
  }
}

/** True when a Grok CLI login session is on disk. An API key does not count. */
export function grokAuthPresent(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  return grokAuthCandidates(env, home).some((path) => sessionFileHasAccessToken(path));
}

export async function refreshGrokModels(options: {
  force?: boolean;
  /** When false, a cache miss returns the static fallback and does not spawn `grok models`. */
  allowCli?: boolean;
  binary?: string;
  cache?: ReturnType<typeof getDefaultCatalogCache>;
} = {}): Promise<{ models: ProviderModelConfig[]; fromCache: boolean; source: "live" | "fallback" | "cache" }> {
  const cache = options.cache ?? getDefaultCatalogCache();

  if (!options.force) {
    const lookup = cache.lookup<CatalogModel>(GROK_PROVIDER_ID);
    if (lookup.hit && lookup.snapshot.models.length > 0) {
      return {
        models: catalogToProviderModels(lookup.snapshot.models),
        fromCache: true,
        source: "cache",
      };
    }
    if (options.allowCli === false) {
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
      return {
        models: catalogToProviderModels(descriptorsToCatalog(fallbackModels())),
        fromCache: false,
        source: "fallback",
      };
    }
  } else if (options.allowCli === false) {
    return {
      models: catalogToProviderModels(descriptorsToCatalog(fallbackModels())),
      fromCache: false,
      source: "fallback",
    };
  }

  let binary: string | undefined = options.binary;
  try {
    binary ??= await resolveGrokBinary();
  } catch {
    binary = undefined;
  }

  // The CLI writes each model's real window here and never prints it. A missing
  // file leaves every model on the default, which is what a cold install had.
  let contextCache: string | undefined;
  try {
    contextCache = readFileSync(join(homedir(), ".grok", "models_cache.json"), "utf8");
  } catch {
    contextCache = undefined;
  }
  const discovered = await discoverModels(binary, contextCache);
  const catalog = descriptorsToCatalog(discovered.models);
  cache.store(GROK_PROVIDER_ID, catalog, { version: "grok-cli-v1" });
  return {
    models: catalogToProviderModels(catalog),
    fromCache: false,
    source: discovered.source,
  };
}

function createProviderConfig(models: ProviderModelConfig[]) {
  return {
    name: "Grok",
    baseUrl: "grok-cli://local",
    apiKey: "grok-cli",
    api: GROK_API,
    models,
    streamSimple: streamGrokForPi,
    // OMP awaits this at startup and caches a non-null list for 24h. Only a
    // TTL hit is returned. An expired disk snapshot is already on `models`
    // for the picker, and the bootstrap fallback is not stored, so both stay
    // null here and do not become that authoritative list.
    fetchDynamicModels: async () => {
      const latest = await refreshGrokModels({ allowCli: false });
      if (!latest.fromCache || latest.models.length === 0) return null;
      return latest.models;
    },
    async refreshModels() {
      // Pi may ask for a network refresh while opening a session. `grok models`
      // runs only from `ns-bridge models refresh`.
      return models;
    },
  };
}

export async function registerGrokProvider(pi: ExtensionAPI): Promise<void> {
  let binary: string | undefined;
  let binaryError: string | undefined;

  // Registration serves the disk cache or the static fallback, so it never
  // spawns the CLI. Resolving the binary still probes PATH, which is async so
  // it does not stall the host while extensions load.
  void resolveGrokBinary()
    .then((found) => {
      binary = found;
    })
    .catch((err: unknown) => {
      binaryError = err instanceof Error ? err.message : String(err);
    });

  // `grok models` can block for 20s. Registration serves the disk cache or the
  // static fallback. `ns-bridge models refresh` is what runs the CLI.
  let refreshed = await refreshGrokModels({ allowCli: false });
  let models = refreshed.models;
  const sameIds = (next: ProviderModelConfig[]) =>
    models.length === next.length && models.every((model, index) => model.id === next[index]?.id);
  const publish = (next: Awaited<ReturnType<typeof refreshGrokModels>>, force = false) => {
    if (!force && sameIds(next.models)) {
      refreshed = next;
      return;
    }
    models = next.models;
    refreshed = next;
    const config = createProviderConfig(models);
    pi.registerProvider(GROK_PROVIDER_ID, config as never);
  };
  publish(refreshed, true);

  // OMP rebinds registerProvider onto the live registry just before this event.
  // A probe that finished while extensions were loading is republished here,
  // still without spawning the CLI.
  pi.on("session_start", () => {
    void refreshGrokModels({ allowCli: false, binary }).then((next) => publish(next));
  });

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
      const version = binary ? await getGrokVersion(binary) : "unknown";
      const authed = binary ? await probeGrokAuth(binary) : grokAuthPresent();
      notify(
        [
          `${CLIENT_NAME} via ns-pi-provider v${CLIENT_VERSION}`,
          `provider: ${GROK_PROVIDER_ID}`,
          `binary: ${binary ?? "(missing)"}`,
          `version: ${version}`,
          `auth: ${authed ? "ok" : "missing/unknown"}`,
          `models: ${models.length} (${refreshed.source})`,
          binaryError ? `binary error: ${binaryError}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        authed ? "info" : "warning",
      );
      return;
    }

    if (action === "models") {
      notify(`Grok models (${refreshed.source}):\n${models.map((m) => `• ${m.id}`).join("\n") || "(none)"}`);
      return;
    }

    if (action === "refresh" || action === "refresh-models") {
      notify("Refresh Grok models with `ns-bridge models refresh grok --apply`.", "info");
      return;
    }

    notify(`Unknown action "${action}". Try: status, models, refresh`, "warning");
  };

  pi.registerCommand("grok", {
    description: "Grok provider: /grok status | models | refresh",
    handler: commandHandler,
  });
}

export default registerGrokProvider;
