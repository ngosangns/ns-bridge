// ABOUTME: Chooses where a vendor call runs — the Go sidecar or the in-process TypeScript core —
// ABOUTME: from NS_BRIDGE_ENGINE(_<VENDOR>), and runs it there with a TypeScript fallback for "auto".

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_SIDECAR_COMMAND, findPackagedSidecarBinary, NS_BRIDGE_BIN_ENV } from "./binary.js";
import { SidecarError } from "./errors.js";
import { type SidecarStreamOptions, sidecarStream } from "./stream.js";

/** Environment variable selecting the engine for every vendor. */
export const NS_BRIDGE_ENGINE_ENV = "NS_BRIDGE_ENGINE";

/** Where a vendor call runs. */
export type BridgeEngine = "go" | "ts";

/** What NS_BRIDGE_ENGINE may say: an engine, or `auto` (Go when a binary is installed). */
export type BridgeEngineSetting = BridgeEngine | "auto";

/** The setting used when NS_BRIDGE_ENGINE is unset or unrecognised. */
export const DEFAULT_BRIDGE_ENGINE: BridgeEngineSetting = "ts";

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
 * The engine setting for a vendor: `NS_BRIDGE_ENGINE_<VENDOR>` (e.g.
 * `NS_BRIDGE_ENGINE_KIRO=ts`), then `NS_BRIDGE_ENGINE`, then the default.
 */
export function bridgeEngineSetting(vendor?: string, env: NodeJS.ProcessEnv = process.env): BridgeEngineSetting {
  const perVendor = vendor ? parseSetting(env[`${NS_BRIDGE_ENGINE_ENV}_${vendor.toUpperCase()}`]) : undefined;
  return perVendor ?? parseSetting(env[NS_BRIDGE_ENGINE_ENV]) ?? DEFAULT_BRIDGE_ENGINE;
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

/** The engine a call to `vendor` runs on right now. */
export function selectBridgeEngine(vendor?: string, env: NodeJS.ProcessEnv = process.env): BridgeEngine {
  const setting = bridgeEngineSetting(vendor, env);
  if (setting !== "auto") return setting;
  return sidecarBinaryAvailable(env) ? "go" : "ts";
}

export interface EngineStreamOptions<TEvent, TRequest> {
  vendor: string;
  /** The request as the Go vendor reads it (JSON-serialisable). */
  request: () => TRequest;
  /** The in-process TypeScript core. */
  inProcess: () => AsyncIterable<TEvent>;
  /** Turn a sidecar failure back into the vendor core's own error type. */
  mapError?: (error: SidecarError) => unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sidecar?: Omit<SidecarStreamOptions, "signal" | "env">;
  /** Force an engine (tests); defaults to {@link selectBridgeEngine}. */
  engine?: BridgeEngine;
}

let warnedFallback = false;

/**
 * Run one vendor call on the selected engine. With the `auto` setting, a
 * binary that cannot be started before any event arrives falls back to the
 * in-process core (once-per-process warning); an explicit `go` never falls back.
 */
export async function* engineStream<TEvent, TRequest>(
  options: EngineStreamOptions<TEvent, TRequest>,
): AsyncGenerator<TEvent, void, undefined> {
  const env = options.env ?? process.env;
  const engine = options.engine ?? selectBridgeEngine(options.vendor, env);
  if (engine === "ts") {
    yield* options.inProcess();
    return;
  }
  let delivered = false;
  try {
    for await (const event of sidecarStream(options.vendor, options.request(), {
      ...options.sidecar,
      ...(options.signal ? { signal: options.signal } : {}),
      env,
    })) {
      delivered = true;
      yield event as TEvent;
    }
  } catch (error) {
    if (
      error instanceof SidecarError &&
      error.kind === "unavailable" &&
      !delivered &&
      options.engine === undefined &&
      bridgeEngineSetting(options.vendor, env) === "auto"
    ) {
      if (!warnedFallback) {
        warnedFallback = true;
        console.warn(`[ns-bridge] ${error.message} Falling back to the in-process TypeScript core.`);
      }
      yield* options.inProcess();
      return;
    }
    throw error instanceof SidecarError && options.mapError ? options.mapError(error) : error;
  }
}
