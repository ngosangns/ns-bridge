#!/usr/bin/env node
/**
 * Bundle src/index.ts (+ the @ngosangns/ns-pi-provider sources it imports, and
 * through them ns-kiro-core, ns-arnict-core, ns-qoder-core and ns-bridge-core)
 * into dist/index.js for OMP.
 *
 * Pi specifiers are redirected to src/compat by scripts/pi-compat-plugin.mjs
 * (shared with the CLI's prebuilt OMP host bundle). `@oh-my-pi/*` stays
 * external: OMP's loader serves its in-process modules.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { createPiCompatPlugin } from "./pi-compat-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCompatPlugin = createPiCompatPlugin(root);

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const upstream = JSON.parse(
  readFileSync(resolve(root, "node_modules/@ngosangns/ns-pi-provider/package.json"), "utf8"),
);

rmSync(resolve(root, "dist"), { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "eof",
  external: ["@oh-my-pi/*"],
  plugins: [piCompatPlugin],
  // Some bundled CommonJS-style helpers call require(); give ESM output one.
  banner: {
    js: [
      `// ${pkg.name} ${pkg.version} — bundles ${upstream.name}@${upstream.version} (MIT). See NOTICE.`,
      "import { createRequire as __nsOmpCreateRequire } from 'node:module';",
      "const require = __nsOmpCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  metafile: true,
  logLevel: "warning",
});

// Guard: nothing Pi-scoped may survive into the bundle.
const leftovers = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports ?? [])
  .filter((imp) => imp.external && !/^(node:|@oh-my-pi\/)/.test(imp.path) && !isBuiltin(imp.path));
if (leftovers.length) {
  console.error("unexpected external imports in bundle:", leftovers.map((imp) => imp.path));
  process.exit(1);
}

execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

console.log(`built dist/index.js (${upstream.name}@${upstream.version})`);

function isBuiltin(path) {
  return ["fs", "path", "os", "crypto", "child_process", "http", "https", "url", "util", "zlib", "events", "stream", "readline", "net", "tls", "module", "buffer", "process", "timers", "worker_threads", "assert"].includes(path.split("/")[0]);
}
