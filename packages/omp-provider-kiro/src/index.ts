// Extension entry point: registers the Kiro provider with OMP.

import type { Api, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  formatSafeError,
  getCachedModels,
  getKiroCliCredentials,
  getKiroCliCredentialsAllowExpired,
  getKiroIdeCredentials,
  getKiroIdeCredentialsAllowExpired,
  isCacheStale,
  type KiroCredentials,
  kiroModels,
  resolveApiRegion,
  resolveKiroAuthSource,
  updateKiroModelsCache,
} from "ns-kiro-core";
import { getKiroApiKey, loginKiro, refreshKiroCredentials, resolveRequestCredentials } from "./auth.js";
import { kiroBaseUrl, toOmpModelConfig } from "./models.js";
import { streamKiroForOmp } from "./stream.js";
import { kiroUsageProvider } from "./usage.js";

export { toKiroMessages, toKiroTools } from "./messages.js";
export { toOmpModelConfig } from "./models.js";
export { streamKiroForOmp } from "./stream.js";
export { kiroUsageProvider, toUsageReport } from "./usage.js";

const DEFAULT_REGION = "us-east-1";

/** Preferred store, including an expired access token. No network. */
function localKiroSession(): KiroCredentials | undefined {
  try {
    const preferIde = resolveKiroAuthSource() === "ide";
    const preferred = preferIde
      ? (getKiroIdeCredentials() ?? getKiroIdeCredentialsAllowExpired())
      : (getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired());
    if (preferred) return preferred;
    return preferIde
      ? (getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired())
      : (getKiroIdeCredentials() ?? getKiroIdeCredentialsAllowExpired());
  } catch {
    return undefined;
  }
}

type Catalog = {
  region: string;
  profileArn?: string;
  models: ReturnType<typeof toOmpModelConfig>[];
};

function localCatalog(): Catalog {
  const session = localKiroSession();
  const region = resolveApiRegion(session?.region ?? DEFAULT_REGION);
  const signedIn = Boolean(session || process.env.KIRO_API_KEY?.trim());
  const models = (signedIn ? getCachedModels(region) : kiroModels).map(toOmpModelConfig);
  return { region, ...(session?.profileArn ? { profileArn: session.profileArn } : {}), models };
}

/** Disk catalog for a credential OMP just stored. No network. */
function catalogForCredentials(credentials: KiroCredentials): Catalog {
  const region = resolveApiRegion(credentials.region ?? DEFAULT_REGION);
  return {
    region,
    ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}),
    models: getCachedModels(region).map(toOmpModelConfig),
  };
}

/** One catalog refresh. OMP awaits fetchDynamicModels, so the HTTP work stays here. */
let catalogRefresh: Promise<void> | undefined;

export default function (pi: ExtensionAPI) {
  let current = localCatalog();

  const publish = (next: Catalog) => {
    current = next;
    pi.registerProvider("kiro", providerConfig());
  };

  const scheduleRefresh = (apiKey: string | undefined) => {
    if (catalogRefresh || !isCacheStale(current.region)) return;
    if (!apiKey?.trim() && !localKiroSession() && !process.env.KIRO_API_KEY?.trim()) return;
    const before = `${current.region}\n${current.models.map((model) => model.id).join("\n")}`;
    catalogRefresh = (async () => {
      try {
        const credentials = await resolveRequestCredentials(apiKey);
        const region = credentials.region;
        if (isCacheStale(region)) {
          await updateKiroModelsCache(credentials.accessToken, region, credentials.profileArn);
        }
        const models = getCachedModels(region).map(toOmpModelConfig);
        const after = `${region}\n${models.map((model) => model.id).join("\n")}`;
        if (after !== before) {
          publish({
            region,
            ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}),
            models,
          });
        }
      } catch (error) {
        console.warn(`[omp-provider-kiro] Failed to refresh the Kiro model catalog: ${formatSafeError(error)}`);
      } finally {
        catalogRefresh = undefined;
      }
    })();
  };

  // OMP rebinds registerProvider onto the live registry just before this
  // event, and awaits the handler. Republish a catalog that landed during
  // extension load. The handler itself does not wait on the network.
  pi.on("session_start", () => {
    const latest = localCatalog();
    const signature = (catalog: Catalog) =>
      `${catalog.region}\n${catalog.profileArn ?? ""}\n${catalog.models.map((model) => model.id).join("\n")}`;
    const before = signature(current);
    const after = signature(latest);
    if (after !== before) publish(latest);
    scheduleRefresh(undefined);
  });

  /**
   * OMP awaits this while starting and then caches a non-null list as the
   * authoritative catalog for 24h. A stale disk cache returns null so startup
   * keeps `models`; {@link scheduleRefresh} re-registers when discovery finishes.
   */
  async function fetchDynamicKiroModels(apiKey: string | undefined) {
    // OMP's type wants a list. A null result is what its resolver treats as
    // "keep the models already registered" instead of an authoritative catalog.
    // An empty list would replace those models, so it is null too.
    if (isCacheStale(current.region)) {
      scheduleRefresh(apiKey);
      return null as unknown as ReturnType<typeof toOmpModelConfig>[];
    }
    const latest = decorate(getCachedModels(current.region).map(toOmpModelConfig));
    if (latest.length === 0) return null as unknown as ReturnType<typeof toOmpModelConfig>[];
    return latest;
  }

  // OMP's first `oauth.modifyModels` synchronously rebuilds every cached
  // provider (`modelRegistry:materializeModifier`) before the session exists.
  // Region and profile are stamped onto the rows instead. Login and token
  // refresh republish from the credential just stored. A request with no
  // stamp still uses `resolveRequestCredentials`.
  function decorate(models: ReturnType<typeof toOmpModelConfig>[]): ReturnType<typeof toOmpModelConfig>[] {
    const baseUrl = kiroBaseUrl(current.region);
    return models.map((model) => ({
      ...model,
      baseUrl,
      kiroRegion: current.region,
      ...(current.profileArn ? { kiroProfileArn: current.profileArn } : {}),
    }));
  }

  function providerConfig() {
    return {
      baseUrl: kiroBaseUrl(current.region),
      api: "kiro-api" as Api,
      apiKey: "$KIRO_API_KEY",
      models: decorate(current.models),
      fetchDynamicModels: fetchDynamicKiroModels,
      streamSimple: streamKiroForOmp,
      usage: kiroUsageProvider,
      oauth: {
        // The name reflects every method that lands a session kiro-cli can hold.
        name: "Kiro (Builder ID / IAM Identity Center / Google / GitHub)",
        login: async (callbacks: Parameters<typeof loginKiro>[0]): Promise<OAuthCredentials> => {
          const credentials = await loginKiro(callbacks);
          publish(catalogForCredentials(credentials as unknown as KiroCredentials));
          return credentials;
        },
        refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => {
          const next = await refreshKiroCredentials(credentials);
          publish(catalogForCredentials(next as unknown as KiroCredentials));
          return next;
        },
        getApiKey: getKiroApiKey,
      },
    };
  }

  pi.registerProvider("kiro", providerConfig());
}
