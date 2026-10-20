/**
 * Kiro provider for Pi — a thin host adapter over ns-kiro-core.
 *
 * Protocol (AWS event-stream, history repair, tool-call recovery, retries,
 * credentials, catalog) lives in ns-kiro-core and is shared with
 * ns-omp-provider-kiro and ns-dsh-llm-kiro. Message projection and stream
 * assembly are the shared Pi-family bridge in ns-bridge-core/pi. What remains
 * here is Pi's registration surface.
 *
 * Auth: the machine's kiro-cli / Kiro IDE session (Builder ID, IAM Identity
 * Center, Google, GitHub), or a `ksk_` API key via KIRO_API_KEY or /login kiro.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withDeclaredToolNames } from "ns-bridge-core";
import { streamToPi, toBridgeContext, toBridgeEffort, toPiThinkingLevelMap } from "ns-bridge-core/pi";
import {
  formatSafeError,
  getCachedModels,
  getKiroEndpoints,
  getKiroRegionFromEndpoint,
  isCacheStale,
  type KiroCredentials,
  type KiroModel,
  kiroModels,
  loginKiroFromSession,
  refreshKiroToken,
  resolveApiRegion,
  readKiroSession,
  resolveKiroCredentials,
  resolveKiroRequestCredentials,
  streamKiro,
  toKiroModelForHost,
  updateKiroModelsCache,
} from "ns-kiro-core";

export const KIRO_PROVIDER_ID = "kiro";
/** Pi's api id for this provider; kept from ns-pi-provider < 0.3 so stored sessions keep matching. */
export const KIRO_API = "kiro";
const DEFAULT_REGION = "us-east-1";

/** A Pi provider model config projected from a kiro-core catalog entry. */
export interface PiKiroModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
  /** Exact wire id; carried so a request needs no second guess at it. */
  kiroModelId?: string;
}

export function toPiKiroModel(model: KiroModel): PiKiroModelConfig {
  const thinkingLevelMap = toPiThinkingLevelMap(model.efforts);
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    kiroModelId: model.kiroModelId,
  };
}

function hasEnvKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KIRO_API_KEY?.trim());
}


async function storedSession(): Promise<KiroCredentials | undefined> {
  try {
    return await resolveKiroCredentials();
  } catch {
    return undefined;
  }
}

/** Disk catalog for the local session. Empty when this machine has no Kiro credential at all. */
function localKiroCatalog(): { models: PiKiroModelConfig[]; region: string } {
  const session = readKiroSession();
  const token = session?.access || (hasEnvKey() ? process.env.KIRO_API_KEY?.trim() : undefined);
  if (!token) return { models: [], region: DEFAULT_REGION };
  const region = resolveApiRegion(session?.region);
  return { models: getCachedModels(region).map(toPiKiroModel), region };
}

/**
 * The Kiro catalog for Pi. Without any credential (no kiro-cli / IDE session,
 * no KIRO_API_KEY) Kiro registers no models, so Pi does not list a provider
 * that cannot serve a request. With one, the region's cached catalog is served
 * and refreshed from Kiro when stale (or forced); a failed refresh keeps the
 * cached / bootstrap list rather than emptying it.
 */
export async function refreshKiroModels(
  options: { force?: boolean; token?: string; allowNetwork?: boolean } = {},
): Promise<{ models: PiKiroModelConfig[]; fromCache: boolean; region: string }> {
  const session = await storedSession();
  const token = options.token || session?.access || (hasEnvKey() ? process.env.KIRO_API_KEY?.trim() : undefined);
  if (!token) return { models: [], fromCache: false, region: DEFAULT_REGION };

  let credentials: Awaited<ReturnType<typeof resolveKiroRequestCredentials>>;
  try {
    credentials = await resolveKiroRequestCredentials(token);
  } catch {
    return { models: getCachedModels(DEFAULT_REGION).map(toPiKiroModel), fromCache: true, region: DEFAULT_REGION };
  }
  const region = credentials.region;
  let fromCache = true;
  if (options.allowNetwork !== false && (options.force || isCacheStale(region))) {
    try {
      await updateKiroModelsCache(credentials.accessToken, region, credentials.profileArn);
      fromCache = false;
    } catch (error) {
      console.warn(`[ns-pi-provider] kiro: catalog refresh failed: ${formatSafeError(error)}`);
    }
  }
  return { models: getCachedModels(region).map(toPiKiroModel), fromCache, region };
}

/** One-line catalog status for `/ns-pi status`. */
export function kiroCatalogStatus(region = DEFAULT_REGION): string {
  const models = getCachedModels(region);
  const bootstrap = models.length === kiroModels.length && models.every((model, i) => model.id === kiroModels[i]?.id);
  return `${KIRO_PROVIDER_ID}: ${models.length} model(s) for ${region}${bootstrap ? " (bootstrap list)" : ""}${isCacheStale(region) ? ", stale" : ""}`;
}

type KiroBackedPiModel = Model<Api> & { kiroModelId?: string; kiroProfileArn?: string };

export function streamKiroForPi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamToPi({
    model,
    createStream: createAssistantMessageEventStream,
    signal: options?.signal,
    formatError: formatSafeError,
    // Pi renders from `partial`, so a core retry can drop what it showed.
    discardOnReset: true,
    events: async () => {
      const hostKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
      const credentials = await resolveKiroRequestCredentials(hostKey);
      const region = getKiroRegionFromEndpoint(model.baseUrl) ?? credentials.region;
      const neutral = toBridgeContext(context as never);
      const events = streamKiro({
        model: toKiroModelForHost(model as KiroBackedPiModel, region),
        messages: neutral.messages,
        systemPrompt: neutral.systemPrompt,
        tools: neutral.tools,
        effort: toBridgeEffort(options?.reasoning),
        accessToken: credentials.accessToken,
        sessionId: options?.sessionId,
        signal: options?.signal,
        profileArn: (model as KiroBackedPiModel).kiroProfileArn ?? credentials.profileArn,
        canDiscardEmittedBlocks: true,
      });
      return withDeclaredToolNames(events, neutral.tools);
    },
  });
}

export async function registerKiroProvider(pi: ExtensionAPI): Promise<void> {
  // Disk only. `refreshKiroModels` may refresh an expired token before it
  // reads the catalog, and Pi awaits this factory.
  let current = { ...localKiroCatalog(), fromCache: true };

  const signature = () => `${current.region}\n${current.models.map((model) => model.id).join("\n")}`;

  const buildConfig = () => ({
    name: "Kiro",
    baseUrl: getKiroEndpoints(resolveApiRegion(current.region)).runtime,
    apiKey: "$KIRO_API_KEY",
    api: KIRO_API,
    authHeader: false,
    streamSimple: streamKiroForPi,
    models: current.models,
    // OMP awaits this during startup and then treats a list as authoritative
    // for 24h. Read the disk cache at call time so a refresh that finished
    // after this config was built is what gets stored. Null leaves `models`
    // in place and does not lock a stale catalog.
    fetchDynamicModels: async () => {
      const latest = localKiroCatalog();
      if (latest.models.length === 0 || isCacheStale(latest.region)) return null;
      return latest.models;
    },
    async refreshModels() {
      // Pi may ask for a network refresh while opening a session. The catalog
      // file is updated only by `ns-bridge models refresh`.
      return current.models;
    },
    oauth: {
      // The name reflects every method that lands a session kiro-cli can hold.
      name: "Kiro (Builder ID / IAM Identity Center / Google / GitHub)",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        return (await loginKiroFromSession(callbacks)) as unknown as OAuthCredentials;
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return (await refreshKiroToken(credentials as unknown as KiroCredentials)) as unknown as OAuthCredentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
  });

  const publish = () => {
    pi.registerProvider(KIRO_PROVIDER_ID, buildConfig() as never);
  };
  publish();

  // Republish the catalog file when a session starts. `ns-bridge models refresh`
  // is what writes that file.
  pi.on("session_start", () => {
    const before = signature();
    const latest = localKiroCatalog();
    if (latest.models.length) current = { ...latest, fromCache: true };
    if (signature() !== before) publish();
  });
}

export default registerKiroProvider;
