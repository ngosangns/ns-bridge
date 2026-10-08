#!/usr/bin/env node
// ABOUTME: Cross-compiles the ns-bridge Go sidecar into each packages/bridge-bin-<os>-<cpu>/bin.
// ABOUTME: Run before packing the binary packages; the binaries are never committed.
//
// The targets are the platform packages themselves: every packages/bridge-bin-*
// directory, with GOOS/GOARCH taken from its package.json `os` / `cpu`. The
// version stamped into the binary (`ns-bridge version`) is ns-bridge-bin's,
// which every binary package shares.
//
//   node scripts/build-sidecar.mjs                          # every target
//   node scripts/build-sidecar.mjs --target darwin-arm64    # one (repeatable)
//   node scripts/build-sidecar.mjs --host                   # this machine's only
//   node scripts/build-sidecar.mjs --version 0.2.0-rc.1     # override the stamp

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const goModule = join(root, "go");

const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" };
const GOARCH = { x64: "amd64", arm64: "arm64" };

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function sidecarTargets() {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("bridge-bin-"))
    .map((entry) => {
      const dir = join("packages", entry.name);
      const manifest = readJson(join(root, dir, "package.json"));
      const [os] = manifest.os ?? [];
      const [cpu] = manifest.cpu ?? [];
      if (!GOOS[os] || !GOARCH[cpu]) throw new Error(`${dir}: unsupported os/cpu ${os}/${cpu}`);
      return {
        target: `${os}-${cpu}`,
        dir,
        name: manifest.name,
        version: manifest.version,
        goos: GOOS[os],
        goarch: GOARCH[cpu],
        binary: join(dir, "bin", os === "win32" ? "ns-bridge.exe" : "ns-bridge"),
      };
    })
    .sort((a, b) => a.target.localeCompare(b.target));
}

function parseArgs(argv) {
  const options = { targets: [], version: undefined, host: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") options.targets.push(argv[++i]);
    else if (arg === "--version") options.version = argv[++i];
    else if (arg === "--host") options.host = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const all = sidecarTargets();
  const wanted = options.host ? [`${process.platform}-${process.arch}`] : options.targets;
  const selected = wanted.length ? all.filter((t) => wanted.includes(t.target)) : all;
  const unknown = wanted.filter((target) => !all.some((t) => t.target === target));
  if (unknown.length) throw new Error(`no binary package for ${unknown.join(", ")} (have: ${all.map((t) => t.target).join(", ")})`);

  const version = options.version ?? readJson(join(root, "packages/bridge-bin/package.json")).version;
  for (const t of all) {
    if (t.version !== version && !options.version) {
      throw new Error(`${t.name}@${t.version} is out of lockstep with ns-bridge-bin@${version}`);
    }
  }

  for (const t of selected) {
    const out = join(root, t.binary);
    rmSync(join(root, t.dir, "bin"), { recursive: true, force: true });
    mkdirSync(join(root, t.dir, "bin"), { recursive: true });
    execFileSync(
      "go",
      ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/ns-bridge"],
      {
        cwd: goModule,
        stdio: "inherit",
        env: { ...process.env, CGO_ENABLED: "0", GOOS: t.goos, GOARCH: t.goarch },
      },
    );
    if (!existsSync(out)) throw new Error(`go build wrote no ${t.binary}`);
    chmodSync(out, 0o755);
    // npm pack (which keeps the executable bit; see publish.yml) only ships a
    // LICENSE that sits in the package directory.
    copyFileSync(join(root, "LICENSE"), join(root, t.dir, "LICENSE"));
    const size = (statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`built ${t.binary} (${t.goos}/${t.goarch}, ${size} MiB, version ${version})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`build-sidecar: ${error.message}`);
    process.exit(1);
  }
}
