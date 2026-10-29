/**
 * Runtime adapters between ns-pi-provider (written for Pi 1.0) and OMP.
 *
 * Pi 1.0 and OMP (oh-my-pi) share the extension surface ns-pi-provider uses
 * (registerProvider / registerCommand / on / ctx.ui / ctx.modelRegistry), but
 * differ in a few contracts:
 *
 *  - Context: OMP passes `systemPrompt?: string[]` and may include
 *    `role: "developer"` messages; Pi providers expect `systemPrompt?: string`
 *    and only user / assistant / toolResult (/ system) roles.
 *  - Model refresh: Pi calls `refreshModels({ credential, signal, allowNetwork })`.
 *    OMP calls `fetchDynamicModels(apiKey)` and awaits it while starting, then
 *    stores a non-null result as the authoritative catalog for 24h. A provider
 *    that still has to hit the network returns `null` from that hook so startup
 *    keeps the `models` array already registered.
 *  - apiKey config: Pi resolves `$ENV` and unescapes `$$`; OMP treats the value
 *    as an exact env-var name, `!command`, or a literal.
 *  - Events: Pi 1.0 fires `session_start` on every session (new/resume/switch)
 *    and has `session_info_changed`; OMP fires `session_start` once at startup,
 *    `session_switch` / `session_branch` afterwards, and has no
 *    `session_info_changed`.
 */

import type { BridgeEffort } from "ns-bridge-core";
import { toOmpThinking } from "ns-bridge-core/pi";

export type AnyRecord = Record<string, unknown>;

export interface OmpLikeContext {
  systemPrompt?: string | string[];
  messages: Array<{ role: string; [key: string]: unknown }>;
  tools?: unknown[];
  [key: string]: unknown;
}

/** Events ns-pi-provider subscribes to that OMP never emits. */
export const UNSUPPORTED_EVENTS: ReadonlySet<string> = new Set(["session_info_changed"]);

/** OMP events that correspond to Pi 1.0's `session_start` (which OMP only fires at startup). */
export const SESSION_START_ALIASES: readonly string[] = ["session_switch", "session_branch"];

/** Default timeout for a `fetchDynamicModels` call (OMP also bounds it). */
export const DYNAMIC_MODELS_TIMEOUT_MS = 30_000;

/**
 * Convert an OMP stream context into the Pi 1.0 shape the providers expect.
 * Pi-shaped contexts (string systemPrompt, no developer messages) pass through
 * untouched (same object), so behaviour under Pi-style callers is unchanged.
 */
export function toPiContext<T extends OmpLikeContext>(context: T): T {
  if (!context || typeof context !== "object") return context;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const needsPrompt = Array.isArray(context.systemPrompt);
  const needsMessages = messages.some((message) => message?.role === "developer");
  if (!needsPrompt && !needsMessages) return context;

  const next: OmpLikeContext = { ...context };
  if (needsPrompt) {
    const joined = (context.systemPrompt as unknown[])
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");
    if (joined) next.systemPrompt = joined;
    else delete next.systemPrompt;
  }
  if (needsMessages) {
    // OMP "developer" messages are host-injected instructions (reminders,
    // auto-continue prompts). The wrapped providers have no developer/system
    // turn, so deliver them as user turns rather than silently dropping them.
    next.messages = messages.map((message) => (message?.role === "developer" ? { ...message, role: "user" } : message));
  }
  return next as T;
}

/**
 * Translate a Pi apiKey config value into OMP's syntax.
 *  - `$NAME`  → `NAME` when that env var is set (OMP reads it live); dropped otherwise,
 *               so OMP falls back to /login credentials instead of sending the
 *               literal string "NAME" as a key.
 *  - `$$`     → `$` (Pi's escape for literal dollars).
 *  - anything else (literals, `!command`) passes through.
 */
export function toOmpApiKey(value: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const envRef = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  const name = envRef?.[1];
  if (name) return env[name]?.trim() ? name : undefined;
  if (value.startsWith("!")) return value;
  return value.replaceAll("$$", "$");
}

/**
 * The smallest window whose OMP default compaction threshold reaches
 * `threshold`.
 *
 * Copied from packages/omp-provider-kiro/src/models.ts (`ompWindowForThreshold`)
 * — this plugin must not import the dedicated kiro plugin. Mirrors OMP's
 * default compaction rule (oh-my-pi `pi-agent-core` `compaction.ts`,
 * `effectiveReserveTokens` / `resolveThresholdTokens`): OMP holds back
 * `max(floor(0.15·W), 16384)` of a window `W` and compacts at the remainder.
 */
export function ompWindowForThreshold(threshold: number): number {
  const reaches = (window: number) => window - Math.max(Math.floor(window * 0.15), 16_384) >= threshold;
  let window = Math.max(Math.ceil(threshold / 0.85), threshold);
  while (!reaches(window)) window += 1;
  while (window > 1 && reaches(window - 1)) window -= 1;
  return window;
}

export const ARNICT_PROVIDER_ID = "arnict";

/** Providers whose Pi model rows need OMP's compaction window and effort shape. */
const OMP_REMAPPED_PROVIDERS: ReadonlySet<string> = new Set([ARNICT_PROVIDER_ID, "qoder"]);

/**
 * Remap provider model rows so OMP compacts where Pi compacts.
 *
 * The rows carry the Pi compaction threshold (an explicit
 * `compaction.thresholdTokens`, else Pi's own `contextWindow - 16384`), but OMP
 * derives its threshold from `contextWindow` as `max(floor(0.15·W), 16384)`, so
 * registering the row at its Pi window makes OMP compact too early (340,000
 * instead of 383,616 for the 400K standard window). Each row is re-registered
 * at the smallest window whose OMP default threshold reaches the Pi threshold,
 * capped at the row's native window; `maxContextWindow` is kept so OMP can
 * still widen to it.
 *
 * Qoder also exposes an effort ladder. Pi keeps it in `thinkingLevelMap`;
 * OMP wants `thinking: { mode: "effort", efforts }`, so the raw ladder is
 * carried on the row and projected here.
 */
export function mapModelsForOmp(models: readonly unknown[], provider: string): unknown[] {
  if (!OMP_REMAPPED_PROVIDERS.has(provider)) return [...models];
  return models.map((model) => {
    if (!model || typeof model !== "object") return model;
    const row = model as AnyRecord;
    if (typeof row.contextWindow !== "number") return model;
    const compaction = row.compaction as { thresholdTokens?: number } | undefined;
    const threshold = compaction?.thresholdTokens ?? row.contextWindow - 16_384;
    const native = (row.maxContextWindow as number | undefined) ?? row.contextWindow;
    const next: AnyRecord = { ...row, contextWindow: Math.min(ompWindowForThreshold(threshold), native) };
    if (provider === "qoder") {
      delete next.thinkingLevelMap;
      const thinking = toOmpThinking(row.efforts as BridgeEffort[] | undefined);
      if (thinking) next.thinking = thinking;
      delete next.efforts;
    }
    return next;
  });
}

/** Arnict is the only legacy caller; kept for the existing export. */
export function mapArnictModelsForOmp(models: readonly unknown[]): unknown[] {
  return mapModelsForOmp(models, ARNICT_PROVIDER_ID);
}

type PiRefreshModels = (args: {
  credential?: { type: string; key?: string; access?: string };
  signal: AbortSignal;
  allowNetwork: boolean;
}) => unknown;

/**
 * Build OMP's `fetchDynamicModels(apiKey)` from a Pi `refreshModels` hook.
 *
 * The call OMP awaits at startup asks for the list already in memory
 * (`allowNetwork: false`). A `null` result is passed through: OMP treats that
 * as "no dynamic list" and keeps the registered `models`, instead of caching
 * an empty or bootstrap list as authoritative for a day. Providers that can
 * answer from a fresh disk cache should set their own `fetchDynamicModels`.
 * `mapModels` rewrites array results (never a `null`) before they reach OMP.
 */
export function toFetchDynamicModels(
  refreshModels: PiRefreshModels,
  timeoutMs: number = DYNAMIC_MODELS_TIMEOUT_MS,
  mapModels?: (models: unknown[]) => unknown[],
): (apiKey: string | undefined) => Promise<unknown[] | null> {
  return async (apiKey) => {
    const credential = apiKey ? { type: "api_key", key: apiKey, access: apiKey } : undefined;
    const models = await refreshModels({
      credential,
      signal: AbortSignal.timeout(timeoutMs),
      allowNetwork: false,
    });
    if (models === null) return null;
    const list = Array.isArray(models) ? models : [];
    return mapModels ? mapModels(list) : list;
  };
}

/**
 * Adapt one Pi `registerProvider` config to OMP's `ProviderConfig`.
 * `providerName` is the id the config registers under; arnict and qoder rows are
 * remapped onto OMP's compaction rule (see {@link mapModelsForOmp}) — kiro rows
 * already carry OMP-shaped windows.
 */
export function adaptProviderConfig(
  config: AnyRecord,
  env: NodeJS.ProcessEnv = process.env,
  providerName?: string,
): AnyRecord {
  if (!config || typeof config !== "object") return config;
  const { refreshModels, ...rest } = config as AnyRecord & { refreshModels?: PiRefreshModels };
  const next: AnyRecord = { ...rest };
  const remapProvider = providerName && OMP_REMAPPED_PROVIDERS.has(providerName) ? providerName : undefined;

  if ("apiKey" in next) {
    const apiKey = toOmpApiKey(next.apiKey, env);
    if (apiKey === undefined) delete next.apiKey;
    else next.apiKey = apiKey;
  }

  if (typeof next.streamSimple === "function") {
    const streamSimple = next.streamSimple as (model: unknown, context: OmpLikeContext, options?: unknown) => unknown;
    next.streamSimple = (model: unknown, context: OmpLikeContext, options?: unknown) =>
      streamSimple(model, toPiContext(context), options);
  }

  if (typeof next.fetchDynamicModels === "function") {
    if (remapProvider) {
      const fetchDynamicModels = next.fetchDynamicModels as (apiKey: string | undefined) => Promise<unknown>;
      next.fetchDynamicModels = async (apiKey: string | undefined) => {
        const models = await fetchDynamicModels(apiKey);
        return Array.isArray(models) ? mapModelsForOmp(models, remapProvider) : models;
      };
    }
  } else if (typeof refreshModels === "function") {
    next.fetchDynamicModels = remapProvider
      ? toFetchDynamicModels(refreshModels, DYNAMIC_MODELS_TIMEOUT_MS, (models) =>
          mapModelsForOmp(models, remapProvider),
        )
      : toFetchDynamicModels(refreshModels);
  }

  if (remapProvider && Array.isArray(next.models)) {
    next.models = mapModelsForOmp(next.models, remapProvider);
  }

  return next;
}

export interface WrapOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Wrap OMP's ExtensionAPI so ns-pi-provider's Pi-targeted registration code
 * runs unchanged: provider configs are adapted, unsupported events are dropped,
 * and `session_start` handlers also run on OMP's session switch/branch events.
 * Every other member is forwarded (methods bound to the real API object).
 */
export function wrapExtensionApi<T extends object>(pi: T, options: WrapOptions = {}): T {
  const env = options.env ?? process.env;
  const api = pi as unknown as {
    registerProvider: (name: string, config: AnyRecord) => void;
    on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  };

  const overrides: Record<PropertyKey, unknown> = {
    registerProvider(name: string, config: AnyRecord) {
      return api.registerProvider(name, adaptProviderConfig(config, env, name));
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (UNSUPPORTED_EVENTS.has(event)) return;
      api.on(event, handler);
      if (event === "session_start") {
        for (const alias of SESSION_START_ALIASES) api.on(alias, handler);
      }
    },
  };

  return new Proxy(pi, {
    get(target, prop) {
      if (Object.hasOwn(overrides, prop)) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
