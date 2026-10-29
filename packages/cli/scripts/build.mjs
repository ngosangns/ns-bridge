#!/usr/bin/env node
/**
 * Bundle the CLI entries and the prebuilt host extensions into dist/.
 *
 * `dist/hosts/{pi,omp,dsh/<vendor>}` are complete local packages: a generated
 * manifest plus one esbuild bundle. `ns-bridge install <host>` registers those
 * directories with Pi, OMP, and DSH by path; nothing is fetched from npm.
 *
 * Bundled here at build time: every ns-*-core, ns-bridge-core, and the host
 * adapters. Left external because the host or the CLI provides them:
 *   - `@earendil-works/*` (Pi serves them in-process)
 *   - `@oh-my-pi/*` (OMP serves them in-process; Pi specifiers go to compat)
 *   - `@deepseek-ai/{cordis,dsh-*}` (DSH routes its own peers)
 *   - `@qoder-ai/*`, `@smithy/*`, `js-tiktoken` (CLI runtime deps: the Qoder
 *     SDK owns a postinstall download, the other two load lazily on Kiro calls)
 *
 * Smithy and js-tiktoken also stay external in the refresh/serve bundles so
 * they load on the first Kiro call, not when the process starts. The Qoder SDK
 * is external there for the same reason it is external in every host bundle:
 * the SDK locates its downloaded worker runtime relative to its own package
 * directory, which a bundled copy would point at `dist/`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { createPiCompatPlugin } from "../../omp-provider/scripts/pi-compat-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const workspacePkg = (dir) => JSON.parse(readFileSync(resolve(root, "..", dir, "package.json"), "utf8"));
const piPkg = workspacePkg("pi-provider");
const ompPkg = workspacePkg("omp-provider");

/** Externals every host bundle may leave unresolved, and the CLI runtime provides. */
const COMMON_EXTERNALS = ["@qoder-ai/*", "@smithy/*", "js-tiktoken", "js-tiktoken/*"];
/** Transitive optionals some bundled deps probe for; absent is fine. */
const OPTIONAL_RUNTIME = ["supports-color", "bufferutil", "utf-8-validate"];
const DSH_PEERS = ["@deepseek-ai/dsh-llm", "@deepseek-ai/cordis", "@deepseek-ai/dsh-attachment", "@deepseek-ai/dsh-credentials"];

const dshVendors = ["kiro", "devin", "grok", "arnict", "qoder"];
const dshSpecs = dshVendors.map((vendor) => {
  const source = workspacePkg(`dsh-llm-${vendor}`);
  return {
    kind: "dsh",
    vendor,
    entry: `src/host-entry/dsh-${vendor}.ts`,
    dir: `dist/hosts/dsh/${vendor}`,
    external: [...COMMON_EXTERNALS, ...DSH_PEERS],
    source,
  };
});

const hosts = [
  {
    kind: "pi",
    entry: "src/host-entry/pi.ts",
    dir: "dist/hosts/pi",
    external: [...COMMON_EXTERNALS, "@earendil-works/*"],
    manifest: {
      name: piPkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      main: "./dist/index.js",
      pi: { extensions: ["./dist/index.js"] },
      license: "MIT",
    },
  },
  {
    kind: "omp",
    entry: "src/host-entry/omp.ts",
    dir: "dist/hosts/omp",
    external: [...COMMON_EXTERNALS, "@oh-my-pi/*"],
    plugins: [createPiCompatPlugin(resolve(root, "..", "omp-provider"))],
    manifest: {
      name: ompPkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      main: "./dist/index.js",
      omp: { extensions: ["./dist/index.js"] },
      peerDependencies: ompPkg.peerDependencies,
      peerDependenciesMeta: ompPkg.peerDependenciesMeta,
      license: "MIT",
    },
  },
  ...dshSpecs.map((spec) => ({
    ...spec,
    manifest: {
      name: spec.source.name,
      version: spec.source.version,
      private: true,
      type: "module",
      main: "./dist/index.js",
      exports: { ".": { default: "./dist/index.js" }, "./package.json": "./package.json" },
      peerDependencies: spec.source.peerDependencies,
      peerDependenciesMeta: spec.source.peerDependenciesMeta,
      license: spec.source.license,
    },
  })),
];

const banner = [
  `// ${pkg.name} ${pkg.version} — prebuilt host bundle.`,
  "import { createRequire as __nsBridgeCreateRequire } from 'node:module';",
  "const require = __nsBridgeCreateRequire(import.meta.url);",
].join("\n");

const cliResult = await build({
  absWorkingDir: root,
  entryPoints: ["src/refresh-entry.ts", "src/serve-entry.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "eof",
  // The Qoder SDK stays external: it resolves its downloaded worker runtime
  // (`dist/_worker`, ~59 MB, per platform) from its own package directory.
  external: ["@qoder-ai/*", "@smithy/*", "js-tiktoken", "js-tiktoken/*"],
  banner: {
    js: [
      `// ${pkg.name} ${pkg.version} — bundled entries (catalog refresh, serve).`,
      "import { createRequire as __nsBridgeCreateRequire } from 'node:module';",
      "const require = __nsBridgeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  metafile: true,
  logLevel: "warning",
});

const cliLeftovers = externalsOf(cliResult).filter(
  (path) => !isAllowed(path, ["@qoder-ai/*", "@smithy/*", "js-tiktoken", "js-tiktoken/*"]),
);
if (cliLeftovers.length) {
  fail("unexpected external imports in the CLI bundles", cliLeftovers);
}

rmSync(resolve(root, "dist/hosts"), { recursive: true, force: true });

let hostBytes = 0;
let hostFiles = 0;
for (const host of hosts) {
  const outfile = resolve(root, host.dir, "dist/index.js");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [host.entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "eof",
    external: host.external,
    plugins: host.plugins,
    banner: { js: banner },
    metafile: true,
    logLevel: "warning",
  });

  const leftovers = externalsOf(result).filter((path) => !isAllowed(path, host.external));
  if (leftovers.length) {
    fail(`unexpected external imports in the ${host.kind}${host.vendor ? `/${host.vendor}` : ""} bundle`, leftovers);
  }
  const output = Object.values(result.metafile.outputs)[0] ?? { bytes: 0, exports: [] };
  if (host.kind === "omp" && externalsOf(result).some((path) => path.startsWith("@earendil-works/"))) {
    fail("the OMP bundle still imports @earendil-works (the compat shim missed an import)");
  }
  if (host.kind === "dsh") {
    const exports = output.exports ?? [];
    for (const name of ["name", "apply"]) {
      if (!exports.includes(name)) fail(`the DSH ${host.vendor} bundle does not export ${name}`);
    }
    const text = readFileSync(outfile, "utf8");
    if (!text.includes(`"llm-${host.vendor}"`)) {
      fail(`the DSH ${host.vendor} bundle does not register llm-${host.vendor}`);
    }
  }

  mkdirSync(resolve(root, host.dir), { recursive: true });
  writeFileSync(resolve(root, host.dir, "package.json"), `${JSON.stringify(host.manifest, null, 2)}\n`, "utf8");
  hostBytes += output.bytes;
  hostFiles += 1;
}

const cliBytes = Object.values(cliResult.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(
  `built dist/refresh-entry.js + dist/serve-entry.js (${Math.round(cliBytes / 1024)}kb) ` +
    `and ${hostFiles} host bundles (${Math.round(hostBytes / 1024)}kb)`,
);

function externalsOf(result) {
  return Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports ?? [])
    .filter((imp) => imp.external && !builtins.has(imp.path))
    .map((imp) => imp.path);
}

function isAllowed(path, patterns) {
  if (OPTIONAL_RUNTIME.includes(path)) return true;
  return patterns.some((pattern) =>
    pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );
}

function fail(message, paths) {
  console.error(message, ...(paths ? [paths] : []));
  process.exit(1);
}
