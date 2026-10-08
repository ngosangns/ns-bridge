// ABOUTME: Guards the published shape: an extension omp cannot resolve never runs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as Record<string, never>;

describe("packaging", () => {
  it("declares one extension entry under both manifest keys", () => {
    // omp reads `pkg.omp ?? pkg.pi`; keeping both lets an older pi-era host load
    // the same tarball. They must not drift.
    expect(manifest.omp).toEqual({ extensions: ["./dist/index.js"] });
    expect(manifest.pi).toEqual(manifest.omp);
  });

  it("ships the entry the manifest points at", () => {
    const entries = (manifest.omp as unknown as { extensions: string[] }).extensions;
    for (const entry of entries) {
      expect(existsSync(join(packageRoot, entry)), `${entry} is built`).toBe(true);
    }
  });

  it("publishes dist rather than src", () => {
    expect(manifest.files).toContain("dist");
    expect(manifest.main).toBe("./dist/index.js");
  });

  it("keeps every host package out of the runtime dependency set", () => {
    // The host supplies these at runtime; a hard dependency would install a
    // second copy whose classes fail every instanceof check against the host's.
    const dependencies = Object.keys((manifest.dependencies as unknown as object) ?? {});
    expect(dependencies.filter((name) => name.startsWith("@oh-my-pi/"))).toEqual([]);
    expect(Object.keys((manifest.peerDependencies as unknown as object) ?? {})).toContain("@oh-my-pi/pi-ai");
  });

  it("keeps the bundler out of the runtime dependency set", () => {
    // esbuild only produces dist/index.js; nothing in the bundle imports it. As
    // a runtime dependency every install would pull a full esbuild plus its
    // platform binary (upstream pi-provider-kiro #167). The workspace root
    // carries it as a devDependency instead.
    const dependencies = (manifest.dependencies as unknown as Record<string, string>) ?? {};
    expect(dependencies).not.toHaveProperty("esbuild");
    expect((manifest.scripts as unknown as Record<string, string>).build).toMatch(/^esbuild /);
  });
});
