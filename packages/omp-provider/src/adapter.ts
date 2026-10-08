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
 *  - Model refresh: Pi calls `refreshModels({ credential, signal, allowNetwork })`;
 *    OMP calls `fetchDynamicModels(apiKey)`.
 *  - apiKey config: Pi resolves `$ENV` and unescapes `$$`; OMP treats the value
 *    as an exact env-var name, `!command`, or a literal.
 *  - Events: Pi 1.0 fires `session_start` on every session (new/resume/switch)
 *    and has `session_info_changed`; OMP fires `session_start` once at startup,
 *    `session_switch` / `session_branch` afterwards, and has no
 *    `session_info_changed`.
 */

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
    next.messages = messages.map((message) =>
      message?.role === "developer" ? { ...message, role: "user" } : message,
    );
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
  if (envRef) return env[envRef[1]!]?.trim() ? envRef[1] : undefined;
  if (value.startsWith("!")) return value;
  return value.replaceAll("$$", "$");
}

type PiRefreshModels = (args: {
  credential?: { type: string; key?: string; access?: string };
  signal: AbortSignal;
  allowNetwork: boolean;
}) => unknown;

/** Build OMP's `fetchDynamicModels(apiKey)` from a Pi `refreshModels` hook. */
export function toFetchDynamicModels(
  refreshModels: PiRefreshModels,
  timeoutMs: number = DYNAMIC_MODELS_TIMEOUT_MS,
): (apiKey: string | undefined) => Promise<unknown[]> {
  return async (apiKey) => {
    const credential = apiKey ? { type: "api_key", key: apiKey, access: apiKey } : undefined;
    const models = await refreshModels({
      credential,
      signal: AbortSignal.timeout(timeoutMs),
      allowNetwork: true,
    });
    return Array.isArray(models) ? models : [];
  };
}

/** Adapt one Pi `registerProvider` config to OMP's `ProviderConfig`. */
export function adaptProviderConfig(config: AnyRecord, env: NodeJS.ProcessEnv = process.env): AnyRecord {
  if (!config || typeof config !== "object") return config;
  const { refreshModels, ...rest } = config as AnyRecord & { refreshModels?: PiRefreshModels };
  const next: AnyRecord = { ...rest };

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

  if (typeof refreshModels === "function" && typeof next.fetchDynamicModels !== "function") {
    next.fetchDynamicModels = toFetchDynamicModels(refreshModels);
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
      return api.registerProvider(name, adaptProviderConfig(config, env));
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
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
