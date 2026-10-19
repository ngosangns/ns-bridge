#!/usr/bin/env node
/**
 * Bundle the catalog refresh into dist/refresh-entry.js.
 * The published CLI has no runtime dependency on the discontinued packages.
 * Smithy and js-tiktoken stay external and load on the first Kiro call that
 * needs them, not when the process starts.
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/refresh-entry.ts"],
  outfile: "dist/refresh-entry.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "eof",
  external: ["@smithy/*", "js-tiktoken", "js-tiktoken/*"],
  banner: {
    js: [
      `// ${pkg.name} ${pkg.version} — catalog refresh bundle.`,
      "import { createRequire as __nsBridgeCreateRequire } from 'node:module';",
      "const require = __nsBridgeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  metafile: true,
  logLevel: "warning",
});

const allowed = new Set(["supports-color", "bufferutil", "utf-8-validate"]);
const leftovers = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports ?? [])
  .filter(
    (imp) =>
      imp.external &&
      !builtins.has(imp.path) &&
      !allowed.has(imp.path) &&
      !imp.path.startsWith("@smithy/") &&
      !imp.path.startsWith("js-tiktoken"),
  );
if (leftovers.length) {
  console.error(
    "unexpected external imports in the refresh bundle:",
    leftovers.map((imp) => imp.path),
  );
  process.exit(1);
}

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`built dist/refresh-entry.js (${Math.round(bytes / 1024)}kb)`);
