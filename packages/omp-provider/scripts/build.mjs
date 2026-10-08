#!/usr/bin/env node
/**
 * Bundle src/index.ts (+ the @ngosangns/ns-pi-provider sources it imports) into
 * dist/index.js for OMP.
 *
 * - `@earendil-works/pi-ai` and `/compat`  → src/compat/pi-ai.ts
 * - `@earendil-works/pi-ai/oauth`           → src/compat/pi-ai-oauth.ts
 * - `@earendil-works/pi-coding-agent`       → src/compat/pi-coding-agent.ts (types only)
 * - `@oh-my-pi/*` stays external: OMP's loader serves its in-process modules.
 *
 * Any other Pi specifier is a hard build error, so an ns-pi-provider upgrade
 * that needs a new shim fails here rather than at OMP load time.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compat = (file) => resolve(root, "src/compat", file);

const PI_ALIASES = new Map([
  ["@earendil-works/pi-ai", compat("pi-ai.ts")],
  ["@earendil-works/pi-ai/compat", compat("pi-ai.ts")],
  ["@earendil-works/pi-ai/oauth", compat("pi-ai-oauth.ts")],
  ["@earendil-works/pi-coding-agent", compat("pi-coding-agent.ts")],
]);

const piCompatPlugin = {
  name: "pi-to-omp-compat",
  setup(b) {
    b.onResolve({ filter: /^@(earendil-works|mariozechner)\/pi-/ }, (args) => {
      const target = PI_ALIASES.get(args.path.replace(/^@mariozechner\//, "@earendil-works/"));
      if (target) return { path: target };
      return {
        errors: [{ text: `no OMP compat shim for "${args.path}" (imported from ${args.importer}); add one in src/compat and scripts/build.mjs` }],
      };
    });
  },
};

// kiro/register.ts derives its root (config.json, debug/) as three dirname()s
// above its own source file (src/kiro/register.ts → package root). Bundled
// into dist/index.js that would point *above* this package, so re-anchor it
// to this package's root (dist/index.js → two dirname()s).
const KIRO_ROOT_FROM = "const EXTENSION_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));";
const KIRO_ROOT_TO = "const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));";
const kiroRootPlugin = {
  name: "kiro-extension-root",
  setup(b) {
    b.onLoad({ filter: /(?:ns-)?pi-provider[\\/]src[\\/]kiro[\\/]register\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!source.includes(KIRO_ROOT_FROM)) {
        return { errors: [{ text: `kiro EXTENSION_ROOT pattern not found in ${args.path}; update scripts/build.mjs` }] };
      }
      return { contents: source.replace(KIRO_ROOT_FROM, KIRO_ROOT_TO), loader: "ts" };
    });
  },
};

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
  plugins: [piCompatPlugin, kiroRootPlugin],
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
