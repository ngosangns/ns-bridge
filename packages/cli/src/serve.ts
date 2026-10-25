/**
 * `ns-bridge serve` — a local Anthropic-Messages server ZCode points an
 * Anthropic client at, with one mount per vendor core. The cores live in the
 * esbuild bundle (serve-entry.js), loaded through a variable specifier exactly
 * like refresh.ts does, so importing this module never loads them.
 */

import type { Server } from "node:http";
import type { AnthropicBackend } from "ns-bridge-core/anthropic";
import { ensureZcodeServeConfig, zcodeConfigPath } from "./zcode-config.js";

export type ServeVendor = "kiro" | "devin" | "grok";

/** The surface of the serve bundle this module needs; matches serve-entry.ts. */
export interface ServeBundle {
  createBundledBackends: () => Record<ServeVendor, AnthropicBackend>;
  createAnthropicServer: (options: {
    backends: Record<string, AnthropicBackend>;
    token?: string;
    log?: (line: string) => void;
  }) => Server;
  setUsageHost: (host: string) => void;
}

export interface RunServeOptions {
  port?: number;
  host?: string;
  /** Overrides the config file and NS_BRIDGE_SERVE_TOKEN. */
  token?: string;
  /** Permit a non-loopback bind. Off by default; the CLI passes --allow-remote. */
  allowRemote?: boolean;
  log?: (line: string) => void;
  err?: (line: string) => void;
  /** Resolves the run when it aborts; without one, SIGINT/SIGTERM stop the run. */
  signal?: AbortSignal;
  /** Tests inject a fake so no vendor core loads. */
  loadBundle?: () => Promise<ServeBundle>;
  /** Tests point this at a temp dir so the real config file is never touched. */
  configPath?: string;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "::ffff:127.0.0.1") return true;
  // A bare dotted quad only: `127.0.0.1.evil.com` is a hostname that may not
  // resolve where the bind expects it to.
  return /^127(\.\d{1,3}){3}$/.test(normalized);
}

/**
 * A variable specifier so typecheck does not follow the esbuild bundle, which
 * pulls in the vendor cores. The file exists only after `pnpm build`.
 */
export async function loadServeBundle(): Promise<ServeBundle> {
  const specifier = "./serve-entry.js";
  return (await import(specifier)) as ServeBundle;
}

export async function runServe(options: RunServeOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !options.allowRemote) {
    err(`refusing to serve on ${host}: not a loopback address (pass --allow-remote to bind it anyway)`);
    return 1;
  }

  const config = ensureZcodeServeConfig(options.configPath ?? zcodeConfigPath());
  const token = options.token ?? (process.env.NS_BRIDGE_SERVE_TOKEN?.trim() || config.token);
  const port = options.port ?? config.port;

  const load = options.loadBundle ?? loadServeBundle;
  let bundle: ServeBundle;
  try {
    bundle = await load();
  } catch (error) {
    err(`serve: could not load the provider bundle: ${error instanceof Error ? error.message : String(error)}`);
    err("run pnpm build so dist/serve-entry.js exists");
    return 1;
  }

  bundle.setUsageHost("zcode");
  const server = bundle.createAnthropicServer({
    backends: bundle.createBundledBackends(),
    token,
    log,
  });

  try {
    await listen(server, port, host);
  } catch (error) {
    err(`serve: could not listen on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const bound = server.address();
  const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;
  log(`ns-bridge serve listening on http://${host}:${boundPort} (kiro, devin, grok)`);

  await stopSignal(options.signal);
  await close(server);
  return 0;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Without an injected signal the run stops on SIGINT/SIGTERM like a daemon. */
function stopSignal(signal: AbortSignal | undefined): Promise<void> {
  if (signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** A shut-down serve drops idle keep-alive sockets and any in-flight stream. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}
