// ns-bridge-bin's lookup: which package carries this machine's binary, and the
// errors that name the fix when it is missing.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bin = require("../index.js") as typeof import("../index.js");
const manifest = require("../package.json") as { version: string; optionalDependencies: Record<string, string> };

// realpath: macOS tmpdir() is a symlink, and require.resolve returns real paths.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ns-bridge-bin-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A node_modules tree holding one fake platform package, optionally with its binary. */
function fakeInstall(target: string, withBinary: boolean): string {
  const root = mkdtempSync(join(scratch, "install-"));
  const pkg = join(root, "node_modules", `ns-bridge-bin-${target}`);
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `ns-bridge-bin-${target}`, version: "0.0.0" }));
  if (withBinary) writeFileSync(join(pkg, "bin", target.startsWith("win32") ? "ns-bridge.exe" : "ns-bridge"), "");
  return root;
}

describe("ns-bridge-bin", () => {
  it("ships the five targets, pinned to its own version", () => {
    expect(bin.SUPPORTED_TARGETS).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    // workspace:* in the checkout; pnpm pack rewrites it to this exact version.
    for (const range of Object.values(manifest.optionalDependencies)) expect(range).toBe("workspace:*");
  });

  it("names the package and binary for a target", () => {
    expect(bin.currentTarget("linux", "arm64")).toBe("linux-arm64");
    expect(bin.platformPackageName("win32-x64")).toBe("ns-bridge-bin-win32-x64");
    expect(bin.binaryName("win32")).toBe("ns-bridge.exe");
    expect(bin.binaryName("darwin")).toBe("ns-bridge");
  });

  it("finds an installed platform package's binary", () => {
    const root = fakeInstall("linux-x64", true);
    expect(bin.binaryPath({ platform: "linux", arch: "x64", paths: [root] })).toBe(
      join(root, "node_modules", "ns-bridge-bin-linux-x64", "bin", "ns-bridge"),
    );
    const win = fakeInstall("win32-x64", true);
    expect(bin.binaryPath({ platform: "win32", arch: "x64", paths: [win] })).toMatch(/ns-bridge\.exe$/);
  });

  it("explains an unsupported target, a missing package and a missing binary", () => {
    expect(() => bin.binaryPath({ platform: "freebsd", arch: "x64" })).toThrow(
      /no ns-bridge binary is published for freebsd-x64/,
    );
    expect(() =>
      bin.binaryPath({ platform: "linux", arch: "x64", paths: [mkdtempSync(join(scratch, "empty-"))] }),
    ).toThrow(/ns-bridge-bin-linux-x64 is not installed.*NS_BRIDGE_BIN/);
    const root = fakeInstall("darwin-x64", false);
    expect(() => bin.binaryPath({ platform: "darwin", arch: "x64", paths: [root] })).toThrow(
      /has no binary.*build-sidecar/,
    );
  });
});
