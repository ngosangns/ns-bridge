// ABOUTME: Runs every vendor call in the ns-bridge Go binary. The in-process
// ABOUTME: TypeScript engines were removed — the binary (ns-bridge-bin) is required.

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_SIDECAR_COMMAND, findPackagedSidecarBinary, NS_BRIDGE_BIN_ENV } from "./binary.js";
import { SidecarError } from "./errors.js";
import { type SidecarStreamOptions, sidecarCall, sidecarStream } from "./stream.js";

/** Environment variable that used to select the engine; still read for warnings. */
export const NS_BRIDGE_ENGINE_ENV = "NS_BRIDGE_ENGINE";

/** What NS_BRIDGE_ENGINE may say; only `go` is honored — `ts` and `auto` warn and still run Go. */
export type BridgeEngineSetting = "go" | "ts" | "auto";

function parseSetting(value: string | undefined): BridgeEngineSetting | undefined {
  switch (value?.trim().toLowerCase()) {
    case "go":
    case "sidecar":
    case "native":
      return "go";
    case "ts":
    case "typescript":
    case "js":
    case "node":
    case "in-process":
      return "ts";
    case "auto":
      return "auto";
    default:
      return undefined;
  }
}

/**
 * The NS_BRIDGE_ENGINE setting for a vendor: `NS_BRIDGE_ENGINE_<VENDOR>`
 * (e.g. `NS_BRIDGE_ENGINE_KIRO`), then `NS_BRIDGE_ENGINE`.
 */
export function bridgeEngineSetting(
  vendor?: string,
  env: NodeJS.ProcessEnv = process.env,
): BridgeEngineSetting | undefined {
  const perVendor = vendor ? parseSetting(env[`${NS_BRIDGE_ENGINE_ENV}_${vendor.toUpperCase()}`]) : undefined;
  return perVendor ?? parseSetting(env[NS_BRIDGE_ENGINE_ENV]);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  if (isAbsolute(command)) return isFile(command);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions)
      if (isFile(join(dir, command + ext.toLowerCase())) || isFile(join(dir, command + ext))) return true;
  }
  return false;
}

/**
 * Whether a sidecar binary can be found: `NS_BRIDGE_BIN` (when it exists), the
 * ns-bridge-bin package for this platform, or `ns-bridge` on PATH.
 */
export function sidecarBinaryAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const fromEnv = env[NS_BRIDGE_BIN_ENV]?.trim();
  if (fromEnv) return existsSync(fromEnv) || onPath(fromEnv, env);
  if ("path" in findPackagedSidecarBinary()) return true;
  return onPath(DEFAULT_SIDECAR_COMMAND, env);
}

let warnedTsSetting = false;

/**
 * Warn once when NS_BRIDGE_ENGINE(_<VENDOR>)=ts is still set: the TypeScript
 * engine no longer exists, so the call runs in the Go binary anyway.
 */
function warnOnTsSetting(vendor: string, env: NodeJS.ProcessEnv): void {
  if (warnedTsSetting || bridgeEngineSetting(vendor, env) !== "ts") return;
  warnedTsSetting = true;
  console.warn(
    `[ns-bridge] ${NS_BRIDGE_ENGINE_ENV}=ts is no longer supported: the TypeScript engine was removed. ` +
      "The call runs in the ns-bridge Go binary.",
  );
}

export interface EngineStreamOptions<TEvent, TRequest> {
  vendor: string;
  /** The request as the Go vendor reads it (JSON-serialisable). */
  request: () => TRequest;
  /** Turn a sidecar failure back into the vendor core's own error type. */
  mapError?: (error: SidecarError) => unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sidecar?: Omit<SidecarStreamOptions, "signal" | "env">;
  /**
   * Post-process the events the sidecar yields, e.g. to apply per-process
   * state the binary cannot hold.
   */
  transform?: (events: AsyncIterable<TEvent>) => AsyncIterable<TEvent>;
}

/** Run one vendor call in the Go sidecar. */
export async function* engineStream<TEvent, TRequest>(
  options: EngineStreamOptions<TEvent, TRequest>,
): AsyncGenerator<TEvent, void, undefined> {
  const env = options.env ?? process.env;
  warnOnTsSetting(options.vendor, env);
  try {
    const raw = sidecarStream(options.vendor, options.request(), {
      ...options.sidecar,
      ...(options.signal ? { signal: options.signal } : {}),
      env,
    }) as AsyncIterable<TEvent>;
    yield* options.transform ? options.transform(raw) : raw;
  } catch (error) {
    throw error instanceof SidecarError && options.mapError ? options.mapError(error) : error;
  }
}

export interface EngineCallOptions<_TResult, TRequest> {
  vendor: string;
  /** The operation (`ns-bridge call --op`). */
  op: string;
  /** The request as the Go vendor reads it (JSON-serialisable). */
  request: () => TRequest;
  /** Turn a sidecar failure back into the vendor core's own error type. */
  mapError?: (error: SidecarError) => unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sidecar?: Omit<SidecarStreamOptions, "signal" | "env">;
}

/** Run one vendor operation (catalog, usage, token refresh) in the Go sidecar. */
export async function engineCall<TResult, TRequest>(options: EngineCallOptions<TResult, TRequest>): Promise<TResult> {
  const env = options.env ?? process.env;
  warnOnTsSetting(options.vendor, env);
  try {
    return await sidecarCall<TResult>(options.vendor, options.op, options.request(), {
      ...options.sidecar,
      ...(options.signal ? { signal: options.signal } : {}),
      env,
    });
  } catch (error) {
    throw error instanceof SidecarError && options.mapError ? options.mapError(error) : error;
  }
}
