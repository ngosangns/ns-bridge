// Extension entry point: registers the Kiro provider with OMP.

import type { Api, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { setUsageHost } from "ns-bridge-core";
import {
  getCachedModels,
  isCacheStale,
  type KiroCredentials,
  kiroModels,
  readKiroSession,
  resolveApiRegion,
} from "ns-kiro-core";
import { getKiroApiKey, loginKiro, refreshKiroCredentials } from "./auth.js";
import { kiroBaseUrl, toOmpModelConfig } from "./models.js";
import { streamKiroForOmp } from "./stream.js";
import { kiroUsageProvider } from "./usage.js";

export { toKiroMessages, toKiroTools } from "./messages.js";
export { toOmpModelConfig } from "./models.js";
export { streamKiroForOmp } from "./stream.js";
export { kiroUsageProvider, toUsageReport } from "./usage.js";

const DEFAULT_REGION = "us-east-1";

type Catalog = {
  region: string;
  profileArn?: string;
  models: ReturnType<typeof toOmpModelConfig>[];
};

function localCatalog(): Catalog {
  const session = readKiroSession();
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

export default function (pi: ExtensionAPI) {
  setUsageHost("omp");
  let current = localCatalog();

  const publish = (next: Catalog) => {
    current = next;
    pi.registerProvider("kiro", providerConfig());
  };

  // OMP rebinds registerProvider onto the live registry just before this
  // event, and awaits the handler. Republish the catalog file. The handler
  // does not refresh it.
  pi.on("session_start", () => {
    const latest = localCatalog();
    const signature = (catalog: Catalog) =>
      `${catalog.region}\n${catalog.profileArn ?? ""}\n${catalog.models.map((model) => model.id).join("\n")}`;
    const before = signature(current);
    const after = signature(latest);
    if (after !== before) publish(latest);
  });

  /**
   * OMP awaits this while starting and then caches a non-null list as the
   * authoritative catalog for 24h. A stale or empty disk cache returns null
   * so the registered models stay. `ns-bridge models refresh` writes the file.
   */
  async function fetchDynamicKiroModels(_apiKey: string | undefined) {
    // OMP's type wants a list. A null result is what its resolver treats as
    // "keep the models already registered" instead of an authoritative catalog.
    // An empty list would replace those models, so it is null too.
    if (isCacheStale(current.region)) {
      return null as unknown as ReturnType<typeof toOmpModelConfig>[];
    }
    const latest = decorate(getCachedModels(current.region).map(toOmpModelConfig));
    if (latest.length === 0) return null as unknown as ReturnType<typeof toOmpModelConfig>[];
    return latest;
  }

  // OMP's first `oauth.modifyModels` synchronously rebuilds every cached
  // provider (`modelRegistry:materializeModifier`) before the session exists.
  // Region and profile are stamped onto the rows instead. Login and token
  // refresh republish the models already on disk.
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
