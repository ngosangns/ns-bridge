// ABOUTME: Finds the ns-bridge Go sidecar binary that the package manager installed for this machine.
// ABOUTME: CommonJS on purpose: ns-bridge-core resolves it synchronously through createRequire.
"use strict";

const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PACKAGE_PREFIX = "ns-bridge-bin-";

/** `<os>-<cpu>` targets this release ships, from the optional dependencies. */
const SUPPORTED_TARGETS = Object.freeze(
  Object.keys(require("./package.json").optionalDependencies || {})
    .filter((name) => name.startsWith(PACKAGE_PREFIX))
    .map((name) => name.slice(PACKAGE_PREFIX.length))
    .sort(),
);

/** The `<os>-<cpu>` target, in Node's own vocabulary (`darwin-arm64`, `win32-x64`, …). */
function currentTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** The npm package that carries the binary for a target. */
function platformPackageName(target = currentTarget()) {
  return `${PACKAGE_PREFIX}${target}`;
}

/** The binary's file name on a platform. */
function binaryName(platform = process.platform) {
  return platform === "win32" ? "ns-bridge.exe" : "ns-bridge";
}

/**
 * Absolute path of the ns-bridge binary for this machine.
 *
 * Throws, with the reason and the fix, when the target is unsupported, its
 * platform package was not installed (optional dependencies omitted), or the
 * package carries no binary (a workspace checkout that never built one).
 */
function binaryPath(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = currentTarget(platform, arch);
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(
      `ns-bridge-bin: no ns-bridge binary is published for ${target} (supported: ${SUPPORTED_TARGETS.join(", ")})`,
    );
  }
  const name = platformPackageName(target);
  let manifest;
  if (options.paths?.length) {
    // An explicit lookup looks exactly there: `<path>/node_modules/<name>`.
    // (require.resolve would also walk every ancestor directory and the
    // global folders, finding packages the caller meant to leave out.)
    manifest = options.paths
      .map((root) => join(root, "node_modules", name, "package.json"))
      .find((candidate) => existsSync(candidate));
  } else {
    try {
      manifest = require.resolve(`${name}/package.json`);
    } catch {
      manifest = undefined;
    }
  }
  if (!manifest) {
    throw new Error(
      `ns-bridge-bin: ${name} is not installed. It is an optional dependency of ns-bridge-bin; ` +
        "reinstall without --no-optional / --omit=optional, or set NS_BRIDGE_BIN to a binary.",
    );
  }
  const file = join(dirname(manifest), "bin", binaryName(platform));
  if (!existsSync(file)) {
    throw new Error(
      `ns-bridge-bin: ${name} has no binary at ${file}. In a checkout, build it with \`node scripts/build-sidecar.mjs\`.`,
    );
  }
  return file;
}

module.exports = { SUPPORTED_TARGETS, binaryName, binaryPath, currentTarget, platformPackageName };
