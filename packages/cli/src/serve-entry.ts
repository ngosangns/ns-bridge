/**
 * Built by esbuild into one file. The typecheck project excludes this module
 * so it does not compile the vendor cores. `ns-bridge serve` is the only
 * command that loads the result.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BridgeContext,
  type BridgeEffort,
  type BridgeStreamEvent,
  type BridgeTool,
  withDeclaredToolNames,
} from "ns-bridge-core";
import { type AnthropicBackend, createAnthropicServer } from "ns-bridge-core/anthropic";
import { setUsageHost } from "ns-core-utils";
import {
  credentialsFromToken,
  type DevinCredentials,
  getCachedModels as getCachedDevinModels,
  isDevinAuthError,
  isExpired as isDevinExpired,
  refreshDevinToken,
  resolveDevinCredentials,
  streamDevin,
} from "ns-devin-core";
import {
  GROK_CATALOG_CACHE_DIR_ENV,
  GROK_DEFAULT_CONTEXT_WINDOW,
  GrokAuthError,
  type GrokModelSpec,
  readGrokCatalog,
  streamGrok,
} from "ns-grok-core";
import {
  formatSafeError,
  getCachedModels as getCachedKiroModels,
  isExpired as isKiroExpired,
  KiroApiError,
  type KiroCredentials,
  type KiroModel,
  readKiroSession,
  refreshKiroToken,
  resolveApiRegion,
  resolveKiroCredentials,
  resolveKiroUsageTracking,
  streamKiro,
} from "ns-kiro-core";

export { createAnthropicServer, setUsageHost };

/** What the local server hands a backend for one /v1/messages call. */
interface BackendRequest {
  model: string;
  context: BridgeContext;
  effort?: BridgeEffort;
  maxTokens?: number;
  sessionId?: string;
  signal: AbortSignal;
}

/** A login this machine does not have; the server answers it with 401. */
class MissingLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingLoginError";
  }
}

// The hint text is what the DSH adapters show for the same situation.
const KIRO_LOGIN_HINT =
  "No Kiro session found. Sign in with `kiro-cli login`, or install the Kiro IDE and sign in there.";
const DEVIN_LOGIN_HINT = "No Devin session found. Sign in with `devin auth login`, or paste a Devin API key.";

function plainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCoreTools(
  tools: readonly BridgeTool[] | undefined,
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> | undefined {
  return tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function isMissingLogin(error: unknown): boolean {
  return error instanceof MissingLoginError || error instanceof GrokAuthError;
}

// ---------------------------------------------------------------------------
// Kiro
// ---------------------------------------------------------------------------

async function kiroCredentials(): Promise<KiroCredentials> {
  const credentials = await resolveKiroCredentials();
  if (!credentials) throw new MissingLoginError(KIRO_LOGIN_HINT);
  return isKiroExpired(credentials) ? refreshKiroToken(credentials) : credentials;
}

/** Catalog region for listing: the session's own, else the default. Disk only. */
function kiroCatalogRegion(): string {
  return resolveApiRegion(readKiroSession()?.region);
}

function kiroModels(): KiroModel[] {
  return getCachedKiroModels(kiroCatalogRegion());
}

async function* kiroStream(request: BackendRequest): AsyncIterable<BridgeStreamEvent> {
  const credentials = await kiroCredentials();
  const region = resolveApiRegion(credentials.region);
  const model = kiroModels().find((candidate) => candidate.id === request.model);
  if (!model) throw new Error(`Unknown Kiro model: ${request.model}`);

  const events = streamKiro({
    model: { ...model, region, ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}) },
    messages: request.context.messages,
    systemPrompt: request.context.systemPrompt,
    tools: toCoreTools(request.context.tools),
    effort: request.effort,
    accessToken: credentials.access,
    sessionId: request.sessionId,
    signal: request.signal,
    profileArn: credentials.profileArn,
    // Kiro bills a repeated prefix for about half the credits and reports no
    // cache counters; the estimate gives the usage ledger something to record.
    usageTracking: resolveKiroUsageTracking({ estimateCacheUsage: true }),
    // The server writes blocks out as they arrive and cannot un-send them.
    canDiscardEmittedBlocks: false,
  });
  yield* withDeclaredToolNames(events, request.context.tools);
}

const kiroBackend: AnthropicBackend = {
  listModels: () => kiroModels().map((model) => ({ id: model.id, name: model.name })),
  stream: kiroStream,
  errorStatus: (error) => {
    if (isMissingLogin(error)) return 401;
    if (error instanceof KiroApiError && (error.status === 401 || error.status === 403)) return 401;
    return undefined;
  },
  formatError: formatSafeError,
};

// ---------------------------------------------------------------------------
// Devin
// ---------------------------------------------------------------------------

async function devinCredentials(): Promise<DevinCredentials> {
  const stored = resolveDevinCredentials();
  if (!stored) throw new MissingLoginError(DEVIN_LOGIN_HINT);
  const credentials = credentialsFromToken(stored.apiKey);
  return isDevinExpired(credentials) ? refreshDevinToken(credentials) : credentials;
}

async function* devinStream(request: BackendRequest): AsyncIterable<BridgeStreamEvent> {
  const credentials = await devinCredentials();
  const model = getCachedDevinModels().find((candidate) => candidate.id === request.model);
  if (!model) throw new Error(`Unknown Devin model: ${request.model}`);

  yield* streamDevin({
    model,
    messages: request.context.messages,
    systemPrompt: request.context.systemPrompt,
    tools: toCoreTools(request.context.tools),
    effort: request.effort,
    apiKey: credentials.access,
    sessionId: request.sessionId,
    signal: request.signal,
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
  });
}

const devinBackend: AnthropicBackend = {
  listModels: () => getCachedDevinModels().map((model) => ({ id: model.id, name: model.name })),
  stream: devinStream,
  errorStatus: (error) => {
    if (isMissingLogin(error) || isDevinAuthError(error)) return 401;
    return undefined;
  },
  formatError: plainErrorMessage,
};

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

/**
 * The cache root `ns-bridge models refresh` writes into — the Pi provider's
 * directory, the same one the DSH adapter reads. `NS_GROK_CATALOG_CACHE_DIR`
 * points a deployment at a different one.
 */
function grokCatalogCacheDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GROK_CATALOG_CACHE_DIR_ENV]?.trim();
  if (override) return override;
  return join(home, ".pi", "agent", "cache", "ns-pi-provider");
}

function grokModels(): GrokModelSpec[] {
  return readGrokCatalog({ cacheDir: grokCatalogCacheDir() });
}

async function* grokStream(request: BackendRequest): AsyncIterable<BridgeStreamEvent> {
  const contextWindow =
    grokModels().find((candidate) => candidate.id === request.model)?.contextWindow ?? GROK_DEFAULT_CONTEXT_WINDOW;
  yield* streamGrok({
    model: request.model,
    messages: request.context.messages,
    systemPrompt: request.context.systemPrompt,
    tools: toCoreTools(request.context.tools),
    effort: request.effort,
    contextWindow,
    // xAI routes each turn to the server holding this conversation's prefix,
    // so the session id is exactly the key the cache wants.
    ...(request.sessionId ? { promptCacheKey: String(request.sessionId) } : {}),
    signal: request.signal,
  });
}

const grokBackend: AnthropicBackend = {
  listModels: () => grokModels().map((model) => ({ id: model.id, name: model.name })),
  stream: grokStream,
  errorStatus: (error) => {
    if (isMissingLogin(error)) return 401;
    return undefined;
  },
  // Grok core error messages are already free of tokens and account ids.
  formatError: plainErrorMessage,
};

// ---------------------------------------------------------------------------

export function createBundledBackends(): Record<"kiro" | "devin" | "grok", AnthropicBackend> {
  return { kiro: kiroBackend, devin: devinBackend, grok: grokBackend };
}
