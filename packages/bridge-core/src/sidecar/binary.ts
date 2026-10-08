// ABOUTME: Locates the ns-bridge Go binary a sidecar call starts: NS_BRIDGE_BIN, an explicit path,
// ABOUTME: the ns-bridge-bin package's platform binary, then `ns-bridge` on PATH.

import { createRequire } from "node:module";

/** Environment variable naming the binary to run; wins over every other source. */
export const NS_BRIDGE_BIN_ENV = "NS_BRIDGE_BIN";

/** Command looked up on PATH when nothing else names a binary. */
export const DEFAULT_SIDECAR_COMMAND = "ns-bridge";

/** The npm package that installs the per-platform binary. */
export const SIDECAR_BIN_PACKAGE = "ns-bridge-bin";

/** What looking for the ns-bridge-bin binary found. */
export type PackagedSidecarBinary = { path: string } | { error: string };

// A local `require` (not the global one) so bundlers leave the lookup to run
// time: an adapter bundle must find the binary next to where it is installed.
const localRequire = createRequire(import.meta.url);

/**
 * The binary installed by ns-bridge-bin (an optional peer: the adapter that
 * runs vendors in the sidecar depends on it), or why there is none.
 */
export function findPackagedSidecarBinary(): PackagedSidecarBinary {
  let bin: { binaryPath(): string };
  try {
    bin = localRequire(SIDECAR_BIN_PACKAGE) as { binaryPath(): string };
  } catch {
    return { error: `${SIDECAR_BIN_PACKAGE} is not installed` };
  }
  try {
    return { path: bin.binaryPath() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ResolveSidecarBinaryOptions {
  /** Replaces the ns-bridge-bin lookup (tests). */
  packaged?: () => PackagedSidecarBinary;
}

/**
 * The binary to start, in order: `NS_BRIDGE_BIN`, the caller's explicit path,
 * the binary ns-bridge-bin installed for this platform, then `ns-bridge` on PATH.
 */
export function resolveSidecarBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSidecarBinaryOptions = {},
): string {
  const fromEnv = env[NS_BRIDGE_BIN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (explicit?.trim()) return explicit.trim();
  const packaged = (options.packaged ?? findPackagedSidecarBinary)();
  if ("path" in packaged) return packaged.path;
  return DEFAULT_SIDECAR_COMMAND;
}
