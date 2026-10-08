/** `<os>-<cpu>` targets this release ships (`darwin-arm64`, `linux-x64`, `win32-x64`, …). */
export declare const SUPPORTED_TARGETS: readonly string[];

/** The `<os>-<cpu>` target in Node's vocabulary for a platform/arch (defaults: this process). */
export declare function currentTarget(platform?: string, arch?: string): string;

/** The npm package that carries the binary for a target (default: this machine's). */
export declare function platformPackageName(target?: string): string;

/** `ns-bridge.exe` on Windows, `ns-bridge` elsewhere. */
export declare function binaryName(platform?: string): string;

export interface BinaryPathOptions {
  /** Override `process.platform` (tests). */
  platform?: string;
  /** Override `process.arch` (tests). */
  arch?: string;
  /** Look only in `<path>/node_modules/<platform package>` for these paths, instead of resolving from this package. */
  paths?: string[];
}

/**
 * Absolute path of the ns-bridge binary for this machine. Throws, naming the
 * fix, when the target is unsupported or its platform package / binary is
 * missing.
 */
export declare function binaryPath(options?: BinaryPathOptions): string;
