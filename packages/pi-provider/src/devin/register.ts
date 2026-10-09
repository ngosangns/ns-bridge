/**
 * Devin provider for Pi — a thin host adapter over ns-devin-core.
 *
 * Protocol (Cascade Connect/protobuf, request building, router models, tool
 * streaming, catalog discovery, PKCE login, usage) lives in ns-devin-core and
 * is shared with ns-dsh-llm-devin. Message projection and stream assembly are
 * the shared Pi-family bridge in ns-bridge-core/pi. What remains here is Pi's
 * registration surface plus Pi's `$`-escaping of literal API keys.
 *
 * Auth: /login devin (PKCE, same flow as `devin auth login`), the Devin CLI's
 * credentials.toml, or DEVIN_API_KEY / DEVIN_SESSION_TOKEN / WINDSURF_API_KEY.
 */

import { existsSync, readFileSync } from "node:fs";

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
import { streamToPi, toBridgeContext, toBridgeEffort, toPiThinkingLevelMap } from "ns-bridge-core/pi";
import {
  DEVIN_DEFAULT_BASE_URL,
  type DevinCredentials,
  type DevinModelSpec,
  type DevinProviderUsage,
  devinCredentialsPath,
  devinModels,
  fetchDevinModels,
  fetchDevinUsage,
  getCachedModels,
  isCacheStale,
  loginDevinWithPkce,
  refreshDevinToken,
  resolveDevinCredentials,
  streamDevinWithCapacityRetry,
  updateDevinModelsCache,
} from "ns-devin-core";

export const DEVIN_PROVIDER_ID = "devin";
/** Pi's api id for this provider; kept from ns-pi-provider < 0.3 so stored sessions keep matching. */
export const DEVIN_API = "devin-cloud";

/** A Pi model projected from a devin-core catalog entry. */
export type PiDevinModel = Model<Api>;

export function toPiDevinModel(spec: DevinModelSpec): PiDevinModel {
  const thinkingLevelMap = toPiThinkingLevelMap(spec.efforts);
  return {
    id: spec.id,
    name: spec.name,
    api: DEVIN_API,
    provider: DEVIN_PROVIDER_ID,
    baseUrl: spec.baseUrl ?? DEVIN_DEFAULT_BASE_URL,
    reasoning: spec.reasoning,
    input: [...spec.input],
    cost: { ...spec.cost },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  } as PiDevinModel;
}

/** Default Devin CLI credentials.toml locations. */
export function defaultDevinCredentialPaths(): string[] {
  return [devinCredentialsPath()];
}

const DEVIN_TOML_TOKEN_RE =
  /(?:windsurf_api_key|session_token|access_token|api_key|token)\s*=\s*(?:"([^"]+)"|'([^']+)')/i;

/** Parse a Devin credentials.toml (or TOML-ish) file for a session/API token. */
export function parseDevinCredentialsToml(text: string): string | undefined {
  const match = text.match(DEVIN_TOML_TOKEN_RE);
  return match?.[1] || match?.[2] || undefined;
}

export type ResolveDevinTokenOptions = {
  /** Override credential file paths (tests); default is devin-core's store. */
  paths?: string[];
  /** When false, skip reading credential files. Default true. */
  readFiles?: boolean;
};

/** Resolve a Devin session token from env, then the Devin CLI store. Never logs it. */
export function resolveDevinToken(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveDevinTokenOptions = {},
): string | undefined {
  const fromEnv = env.DEVIN_API_KEY?.trim() || env.DEVIN_SESSION_TOKEN?.trim() || env.WINDSURF_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (options.readFiles === false) return undefined;
  if (!options.paths) return resolveDevinCredentials()?.apiKey;
  for (const path of options.paths) {
    if (!existsSync(path)) continue;
    try {
      const token = parseDevinCredentialsToml(readFileSync(path, "utf8"));
      if (token) return token;
    } catch {
      // ignore unreadable / corrupt
    }
  }
  return undefined;
}

/**
 * Escape a literal API key for Pi config-value parsing.
 * Devin session tokens contain `$` (prefix `devin-session-token$…`); Pi treats
 * `$VAR` as env interpolation, so unescaped literals fail auth checks and
 * `--list-models` hides the provider. `$$` is the documented escape.
 */
export function escapeDevinApiKeyLiteral(token: string): string {
  // A replacer fn: String.replaceAll treats "$$" in a replacement string as "$".
  return token.replaceAll("$", () => "$$");
}

/**
 * Pi apiKey config so `--list-models` marks Devin configured when CLI creds
 * already exist (no prior /login required). Prefers env refs; falls back to an
 * escaped literal from credentials.toml.
 */
export function resolveDevinApiKeyConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveDevinTokenOptions = {},
): string | undefined {
  if (env.DEVIN_API_KEY?.trim()) return "$DEVIN_API_KEY";
  if (env.DEVIN_SESSION_TOKEN?.trim()) return "$DEVIN_SESSION_TOKEN";
  if (env.WINDSURF_API_KEY?.trim()) return "$WINDSURF_API_KEY";
  const token = resolveDevinToken(env, options);
  return token ? escapeDevinApiKeyLiteral(token) : undefined;
}

/**
 * The Devin catalog for Pi: devin-core's disk cache (seeded with its bootstrap
 * list), refreshed through GetCliModelConfigs when stale or forced. A failed
 * or empty discovery keeps what is cached.
 */
export async function refreshDevinModels(
  options: { force?: boolean; signal?: AbortSignal; token?: string } = {},
): Promise<{ models: PiDevinModel[]; fromCache: boolean }> {
  const token = "token" in options ? options.token : resolveDevinToken();
  let fromCache = true;
  if (token && (options.force || isCacheStale())) {
    try {
      const fetched = await fetchDevinModels({
        apiKey: token,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (fetched?.length) {
        updateDevinModelsCache(fetched);
        fromCache = false;
      }
    } catch {
      // keep the cached catalog
    }
  }
  return { models: getCachedModels().map(toPiDevinModel), fromCache };
}

/** One-line catalog status for `/ns-pi status`. */
export function devinCatalogStatus(): string {
  const models = getCachedModels();
  const bootstrap = models.length === devinModels.length && models.every((model, i) => model.id === devinModels[i]?.id);
  return `${DEVIN_PROVIDER_ID}: ${models.length} model(s)${bootstrap ? " (bootstrap list)" : ""}${isCacheStale() ? ", stale" : ""}`;
}

export function formatDevinUsage(usage: DevinProviderUsage, now = Date.now()): string {
  const lines = [`Devin ${usage.planName ?? "plan"}${usage.email ? ` (${usage.email})` : ""}`];
  for (const limit of usage.limits) {
    const amount =
      limit.unit === "percent"
        ? `${Math.round(limit.used)}% used`
        : limit.limit !== undefined
          ? `${limit.used} / ${limit.limit} ${limit.unit}`
          : `${limit.used} ${limit.unit}`;
    const reset =
      limit.resetsAt && limit.resetsAt > now
        ? ` — resets ${new Date(limit.resetsAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`
        : "";
    lines.push(`${limit.label}: ${amount}${reset}`);
  }
  if (usage.overageBalanceUsd !== undefined) lines.push(`Extra balance: $${usage.overageBalanceUsd.toFixed(2)}`);
  return lines.join("\n");
}

function catalogSpec(model: Model<Api>): DevinModelSpec {
  const known = getCachedModels().find((candidate) => candidate.id === model.id);
  if (known) return known;
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...(model.input as ("text" | "image")[])],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
  };
}

export function streamDevinForPi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamToPi({
    model,
    createStream: createAssistantMessageEventStream,
    signal: options?.signal,
    discardOnReset: true,
    events: () => {
      const apiKey = (typeof options?.apiKey === "string" && options.apiKey) || resolveDevinToken();
      if (!apiKey) throw new Error("No Devin credential. Run /login devin");
      const neutral = toBridgeContext(context as never);
      return streamDevinWithCapacityRetry({
        model: catalogSpec(model),
        messages: neutral.messages,
        systemPrompt: neutral.systemPrompt,
        tools: neutral.tools,
        effort: toBridgeEffort(options?.reasoning),
        apiKey,
        sessionId: options?.sessionId,
        signal: options?.signal,
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      });
    },
  });
}

function providerConfig(models: PiDevinModel[], apiKey?: string) {
  return {
    name: "Devin",
    api: DEVIN_API,
    baseUrl: DEVIN_DEFAULT_BASE_URL,
    models,
    // When CLI credentials.toml (or env) already has a token, set apiKey so Pi
    // marks the provider configured for --list-models without /login.
    ...(apiKey ? { apiKey } : {}),
    async refreshModels({
      credential,
      signal,
      allowNetwork,
    }: {
      credential?: { type: string; access?: string; key?: string };
      signal: AbortSignal;
      allowNetwork: boolean;
    }) {
      if (!allowNetwork) return models;
      const token =
        (credential?.type === "oauth" ? credential.access : undefined) ||
        (credential?.type === "api_key" ? credential.key : undefined) ||
        resolveDevinToken();
      return (await refreshDevinModels({ force: true, signal, token })).models;
    },
    oauth: {
      name: "Devin",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const credentials = await loginDevinWithPkce({
          onAuthUrl: (url, instructions) => callbacks.onAuth({ url, ...(instructions ? { instructions } : {}) }),
          ...(callbacks.onProgress ? { onProgress: callbacks.onProgress } : {}),
        });
        return credentials as unknown as OAuthCredentials;
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return (await refreshDevinToken(credentials as unknown as DevinCredentials)) as unknown as OAuthCredentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
    streamSimple: streamDevinForPi,
  };
}

export async function registerDevinProvider(pi: ExtensionAPI): Promise<void> {
  let apiKeyConfig = resolveDevinApiKeyConfig();
  // Serve the cached catalog at startup so --list-models / -p see it without
  // waiting for a network round trip; session_start refreshes it.
  // A stale catalog with a credential at hand is refreshed before the first
  // registration (Pi awaits async extension factories), so a fresh install
  // lists the account's real models rather than the bootstrap list.
  let models = getCachedModels().map(toPiDevinModel);
  if (isCacheStale() && resolveDevinToken()) {
    try {
      models = (await refreshDevinModels({ signal: AbortSignal.timeout(10_000) })).models;
    } catch {
      // keep the cached catalog
    }
  }
  pi.registerProvider(DEVIN_PROVIDER_ID, providerConfig(models, apiKeyConfig) as never);

  pi.on("session_start", async (_event, ctx) => {
    try {
      apiKeyConfig = resolveDevinApiKeyConfig() ?? apiKeyConfig;
      const apiKey = (await ctx.modelRegistry.getApiKeyForProvider?.(DEVIN_PROVIDER_ID)) || resolveDevinToken();
      if (!apiKey) return;
      const refreshed = await refreshDevinModels({ token: apiKey });
      if (!refreshed.fromCache && refreshed.models.length) {
        models = refreshed.models;
        pi.registerProvider(
          DEVIN_PROVIDER_ID,
          providerConfig(models, apiKeyConfig ?? escapeDevinApiKeyLiteral(apiKey)) as never,
        );
      }
    } catch {
      // keep current models
    }
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin authentication status and quota",
    handler: async (_args, ctx) => {
      const key = (await ctx.modelRegistry.getApiKeyForProvider?.(DEVIN_PROVIDER_ID)) || resolveDevinToken();
      if (!key) return ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
      const usage = await fetchDevinUsage({ apiKey: key });
      if (usage) ctx.ui.notify(formatDevinUsage(usage), "info");
      else ctx.ui.notify("Devin: authenticated\nQuota: unavailable. Try again later.", "warning");
    },
  });
}

export default registerDevinProvider;
