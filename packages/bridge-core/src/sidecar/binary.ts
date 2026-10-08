// ABOUTME: Locates the ns-bridge Go binary a sidecar call starts.

/** Environment variable naming the binary to run; wins over every other source. */
export const NS_BRIDGE_BIN_ENV = "NS_BRIDGE_BIN";

/** Command looked up on PATH when nothing else names a binary. */
export const DEFAULT_SIDECAR_COMMAND = "ns-bridge";

/**
 * The binary to start, in order: `NS_BRIDGE_BIN`, the caller's explicit path,
 * then `ns-bridge` on PATH. (Resolution through the per-platform
 * `ns-bridge-bin-*` npm packages slots in before the PATH fallback in M1.)
 */
export function resolveSidecarBinary(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[NS_BRIDGE_BIN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (explicit?.trim()) return explicit.trim();
  return DEFAULT_SIDECAR_COMMAND;
}
