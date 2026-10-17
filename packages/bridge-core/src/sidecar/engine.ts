// ABOUTME: Runs a vendor call in the ns-bridge Go binary, or in-process when
// ABOUTME: NS_BRIDGE_ENGINE=ts and the caller passed an in-process core.

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_SIDECAR_COMMAND, findPackagedSidecarBinary, NS_BRIDGE_BIN_ENV } from "./binary.js";
import { SidecarError } from "./errors.js";
import { type SidecarStreamOptions, sidecarCall, sidecarStream } from "./stream.js";

/** Environment variable that used to select the engine; still read for warnings. */
export const NS_BRIDGE_ENGINE_ENV = "NS_BRIDGE_ENGINE";

/** What NS_BRIDGE_ENGINE may say. Unset stays on the Go sidecar. */
export type BridgeEngine = "go" | "ts";
export type BridgeEngineSetting = BridgeEngine | "auto";

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
 * The engine a call runs on. An explicit `ts` uses the in-process core when
 * the caller passed one. Unset or `go` stays on the sidecar and never falls
 * back. `auto` uses the sidecar when a binary is installed.
 */
export function selectBridgeEngine(vendor?: string, env: NodeJS.ProcessEnv = process.env): BridgeEngine {
  const setting = bridgeEngineSetting(vendor, env);
  if (setting === "ts") return "ts";
  if (setting === "auto") return sidecarBinaryAvailable(env) ? "go" : "ts";
  return "go";
}

/**
 * Warn once when NS_BRIDGE_ENGINE(_<VENDOR>)=ts is set but the caller has no
 * in-process core to run. The call stays on the Go binary.
 */
function warnOnTsSetting(vendor: string, env: NodeJS.ProcessEnv): void {
  if (warnedTsSetting || selectBridgeEngine(vendor, env) !== "ts") return;
  warnedTsSetting = true;
  console.warn(
    `[ns-bridge] ${NS_BRIDGE_ENGINE_ENV}=ts is set but this call has no in-process core. ` +
      "The call runs in the ns-bridge Go binary.",
  );
}

export interface EngineStreamOptions<TEvent, TRequest> {
  vendor: string;
  /** The request as the Go vendor reads it (JSON-serialisable). */
  request: () => TRequest;
  /** The in-process TypeScript core. Used when {@link selectBridgeEngine} is `ts`. */
  inProcess?: () => AsyncIterable<TEvent>;
  /** Turn a sidecar failure back into the vendor core's own error type. */
  mapError?: (error: SidecarError) => unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sidecar?: Omit<SidecarStreamOptions, "signal" | "env">;
  /**
   * Post-process the events the sidecar yields (never the in-process ones),
   * e.g. to apply per-process state the binary cannot hold.
   */
  transform?: (events: AsyncIterable<TEvent>) => AsyncIterable<TEvent>;
}

/** Run one vendor call on the selected engine. Unset stays on the Go sidecar. */
export async function* engineStream<TEvent, TRequest>(
  options: EngineStreamOptions<TEvent, TRequest>,
): AsyncGenerator<TEvent, void, undefined> {
  const env = options.env ?? process.env;
  if (selectBridgeEngine(options.vendor, env) === "ts" && options.inProcess) {
    yield* options.inProcess();
    return;
  }
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
  /** The in-process TypeScript implementation. Used when {@link selectBridgeEngine} is `ts`. */
  inProcess?: () => Promise<_TResult>;
  /** Turn a sidecar failure back into the vendor core's own error type. */
  mapError?: (error: SidecarError) => unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sidecar?: Omit<SidecarStreamOptions, "signal" | "env">;
}

/** Run one vendor operation (catalog, usage, token refresh) on the selected engine. */
export async function engineCall<TResult, TRequest>(options: EngineCallOptions<TResult, TRequest>): Promise<TResult> {
  const env = options.env ?? process.env;
  if (selectBridgeEngine(options.vendor, env) === "ts" && options.inProcess) return options.inProcess();
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
