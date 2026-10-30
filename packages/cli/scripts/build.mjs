#!/usr/bin/env node
/**
 * Bundle the CLI entries and the prebuilt host extensions into dist/.
 *
 * `dist/hosts/{pi,omp,dsh/<vendor>}` are complete local packages: a generated
 * manifest plus one esbuild bundle. `ns-bridge install <host>` registers those
 * directories with Pi, OMP, and DSH by path; nothing is fetched from npm.
 *
 * Bundled here at build time: every ns-*-core, ns-bridge-core, the host
 * adapters, and — into the host bundles only — Smithy and js-tiktoken. Those
 * two cannot stay external: kiro-core loads them through a createRequire
 * shadow, a compiled-bun host (OMP) cannot resolve bare specifiers at runtime,
 * and the Kiro stream then dies on its first response (issue #18). Left
 * external:
 *   - `@earendil-works/*` (Pi serves them in-process)
 *   - `@oh-my-pi/*` (OMP serves them in-process; Pi specifiers go to compat)
 *   - `@deepseek-ai/{cordis,dsh-*}` (DSH routes its own peers)
 *
 * qoder-core talks to the Qoder model server directly and decrypts the
 * qodercli credential store with a vendored wasm. The asset ships next to
 * every bundle: `dist/vendor/qoder-auth.wasm` for the CLI entries and
 * `<host>/vendor/qoder-auth.wasm` for each host package.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const qoderAuthWasm = resolve(root, "..", "qoder-core", "vendor", "qoder-auth.wasm");
/** Transitive optionals some bundled deps probe for; absent is fine. */
const OPTIONAL_RUNTIME = ["supports-color", "bufferutil", "utf-8-validate"];
const DSH_PEERS = ["@deepseek-ai/dsh-llm", "@deepseek-ai/cordis", "@deepseek-ai/dsh-attachment", "@deepseek-ai/dsh-credentials"];

/**
 * kiro-core defers Smithy and js-tiktoken behind a `require` shadow created
 * with createRequire, so plain-Node consumers pay nothing at import time. That
 * shape defeats esbuild's static analysis — the require calls survive into the
 * bundle as runtime code, and a compiled-bun host (OMP) cannot resolve bare
 * specifiers for dynamically loaded code, so the Kiro stream dies on its first
 * response (issue #18). Host builds strip the shadow from these two files so
 * esbuild inlines the requires as lazy, memoized module loads. The shadow
 * stays in the source and the tsc output: unbundled consumers (vitest, node)
 * still need it. Hosts import the cores through their package entry, so the
 * emitted dist/*.js is what actually flows into these builds.
 */
const inlineKiroLazyRequires = {
  name: "ns-bridge:inline-kiro-lazy-requires",
  setup(build) {
    build.onLoad(
      { filter: /kiro-core[/\\](src|dist)[/\\](response-stream|tokenizer)\.(ts|js)$/ },
      (args) => ({
        contents: readFileSync(args.path, "utf8")
          .replace(/^import \{ createRequire \} from "node:module";\r?\n/m, "")
          .replace(/^const require = createRequire\(import\.meta\.url\);\r?\n?/m, ""),
        loader: args.path.endsWith(".ts") ? "ts" : "js",
        resolveDir: dirname(args.path),
      }),
    );
  },
};

const dshVendors = ["kiro", "devin", "grok", "arnict", "qoder"];
const dshSpecs = dshVendors.map((vendor) => {
  const source = workspacePkg(`dsh-llm-${vendor}`);
  return {
    kind: "dsh",
    vendor,
    entry: `src/host-entry/dsh-${vendor}.ts`,
    dir: `dist/hosts/dsh/${vendor}`,
    external: [...DSH_PEERS],
    source,
  };
});

const hosts = [
  {
    kind: "pi",
    entry: "src/host-entry/pi.ts",
    dir: "dist/hosts/pi",
    external: ["@earendil-works/*"],
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
    external: ["@oh-my-pi/*"],
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
  // These run under plain Node: Smithy/js-tiktoken may keep loading lazily
  // on Kiro calls, so they stay external here.
  external: ["@smithy/*", "js-tiktoken", "js-tiktoken/*"],
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
  (path) => !isAllowed(path, ["@smithy/*", "js-tiktoken", "js-tiktoken/*"]),
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
    plugins: [...(host.plugins ?? []), inlineKiroLazyRequires],
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
  const text = readFileSync(outfile, "utf8");
  // A runtime require of anything but a builtin means the lazy sites were not
  // inlined (e.g. the createRequire shadow made it through) — compiled-bun
  // hosts cannot resolve those (issue #18). A `node:` specifier is a builtin
  // by definition; the bare-name check uses the building node's
  // builtinModules, which lags behind newer builtins.
  const bareRequires = [
    ...new Set(
      [...text.matchAll(/(?<![\w$.])require\d*\("([^"]+)"\)/g)]
        .map((match) => match[1])
        .filter((spec) => !spec.startsWith("node:") && !builtins.has(spec)),
    ),
  ];
  if (bareRequires.length) {
    fail(
      `runtime bare requires left in the ${host.kind}${host.vendor ? `/${host.vendor}` : ""} bundle`,
      bareRequires,
    );
  }
  if (host.kind === "dsh") {
    const exports = output.exports ?? [];
    for (const name of ["name", "apply"]) {
      if (!exports.includes(name)) fail(`the DSH ${host.vendor} bundle does not export ${name}`);
    }
    if (!text.includes(`"llm-${host.vendor}"`)) {
      fail(`the DSH ${host.vendor} bundle does not register llm-${host.vendor}`);
    }
  }

  mkdirSync(resolve(root, host.dir), { recursive: true });
  writeFileSync(resolve(root, host.dir, "package.json"), `${JSON.stringify(host.manifest, null, 2)}\n`, "utf8");
  // store.ts looks for the wasm at ../vendor/ relative to the bundle.
  mkdirSync(resolve(root, host.dir, "vendor"), { recursive: true });
  copyFileSync(qoderAuthWasm, resolve(root, host.dir, "vendor", "qoder-auth.wasm"));
  hostBytes += output.bytes;
  hostFiles += 1;
}

mkdirSync(resolve(root, "dist/vendor"), { recursive: true });
copyFileSync(qoderAuthWasm, resolve(root, "dist", "vendor", "qoder-auth.wasm"));

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
