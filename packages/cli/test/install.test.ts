import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/selection.js";

/**
 * Runs the built CLI against fake host binaries on PATH, with HOME pointing at
 * a temp directory. The fakes mutate the same files the real hosts own, so the
 * assertions cover what a user would find after `ns-bridge install all`.
 */

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const main = join(cliRoot, "dist", "main.js");

const MUTATE = `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [action, arg] = process.argv.slice(2);
const home = process.env.HOME;
const settings = join(home, ".pi", "agent", "settings.json");

function read() {
  try {
    return JSON.parse(readFileSync(settings, "utf8"));
  } catch {
    return {};
  }
}

if (action === "pi-add") {
  const record = read();
  const packages = Array.isArray(record.packages) ? record.packages : [];
  if (!packages.includes(arg)) packages.push(arg);
  record.packages = packages;
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify(record));
} else if (action === "pi-remove") {
  const record = read();
  if (Array.isArray(record.packages)) {
    record.packages = record.packages.filter((entry) => entry !== arg);
    writeFileSync(settings, JSON.stringify(record));
  }
} else if (action === "omp-install") {
  // OMP symlinks the package into its plugin node_modules; a file with the
  // target serves the same purpose here.
  const dir = join(home, ".omp", "plugins", "node_modules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ns-omp-provider"), arg);
} else if (action === "omp-remove") {
  for (const name of arg.split(",")) rmSync(join(home, ".omp", "plugins", "node_modules", name), { force: true });
}
`;

const PI_FAKE = `#!/bin/sh
printf 'pi %s\\n' "$*" >> "$FAKE_LOG"
case "$1" in
  install) node "$FAKE_BIN/mutate.mjs" pi-add "$2" ;;
  uninstall) node "$FAKE_BIN/mutate.mjs" pi-remove "$2" ;;
esac
exit 0
`;

const OMP_FAKE = `#!/bin/sh
printf 'omp %s\\n' "$*" >> "$FAKE_LOG"
case "$2" in
  install) node "$FAKE_BIN/mutate.mjs" omp-install "$3" ;;
  uninstall) shift 2; node "$FAKE_BIN/mutate.mjs" omp-remove "$(printf '%s' "$*" | tr ' ' ',')" ;;
esac
exit 0
`;

const DSH_FAKE = `#!/bin/sh
printf 'dsh %s\\n' "$*" >> "$FAKE_LOG"
exit 0
`;

let sandbox: string;
let home: string;
let log: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  if (!existsSync(main)) spawnSync("pnpm", ["run", "build"], { cwd: cliRoot, stdio: "ignore", timeout: 300_000 });
  sandbox = mkdtempSync(join(tmpdir(), "ns-bridge-install-"));
  home = join(sandbox, "home");
  log = join(sandbox, "calls.log");
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "mutate.mjs"), MUTATE);
  for (const [name, body] of [
    ["pi", PI_FAKE],
    ["omp", OMP_FAKE],
    ["dsh", DSH_FAKE],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ packages: ["npm:@ngosangns/ns-pi-provider", "/old/cli/dist/hosts/pi", "npm:other-extension"] }),
  );
  env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_LOG: log, FAKE_BIN: bin };
  env.NS_BRIDGE_USAGE = "0";
  delete env.NS_BRIDGE_PROVIDERS;
  delete env.PI_CODING_AGENT_DIR;
  delete env.DSH_HOME;
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function nsBridge(args: string[]) {
  return spawnSync(process.execPath, [main, ...args], { env, encoding: "utf8" });
}

function settingsPackages(): unknown[] {
  return JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")).packages;
}

describe("ns-bridge install/uninstall against fake hosts", () => {
  it("installs all three hosts, migrating Pi and OMP off the npm plugins", () => {
    const result = nsBridge(["install", "all", "--profile", "test"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const piBundle = join(cliRoot, "dist", "hosts", "pi");
    expect(settingsPackages()).toEqual(["npm:other-extension", piBundle]);

    const ompBundle = join(cliRoot, "dist", "hosts", "omp");
    expect(readFileSync(join(home, ".omp", "plugins", "node_modules", "ns-omp-provider"), "utf8")).toBe(ompBundle);

    const patch = readFileSync(join(home, ".dsh", "profiles", "test", "cordis.patch.yml"), "utf8");
    for (const provider of PROVIDERS) expect(patch).toContain(`- id: llm-${provider}`);

    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toBe("pi uninstall npm:@ngosangns/ns-pi-provider");
    expect(calls[1]).toBe(`pi install ${piBundle}`);
    expect(calls[2]).toBe("omp plugin uninstall ns-omp-provider-kiro");
    expect(calls[3]).toBe(`omp plugin install ${ompBundle}`);
    expect(calls[4]).toBe(
      `dsh plugin --profile test add ${PROVIDERS.map((p) => `link:${join(cliRoot, "dist", "hosts", "dsh", p)}`).join(" ")}`,
    );
  });

  it("is safe to run twice: no duplicate Pi entries, same patch", () => {
    const before = readFileSync(join(home, ".dsh", "profiles", "test", "cordis.patch.yml"), "utf8");
    const result = nsBridge(["install", "all", "--profile", "test"]);
    expect(result.status).toBe(0);
    expect(settingsPackages()).toEqual(["npm:other-extension", join(cliRoot, "dist", "hosts", "pi")]);
    expect(readFileSync(join(home, ".dsh", "profiles", "test", "cordis.patch.yml"), "utf8")).toBe(before);
  });

  it("uninstalls everything it registered", () => {
    const result = nsBridge(["uninstall", "all", "--profile", "test"]);
    expect(result.status).toBe(0);
    expect(settingsPackages()).toEqual(["npm:other-extension"]);
    expect(existsSync(join(home, ".omp", "plugins", "node_modules", "ns-omp-provider"))).toBe(false);
    const patch = readFileSync(join(home, ".dsh", "profiles", "test", "cordis.patch.yml"), "utf8");
    for (const provider of PROVIDERS) expect(patch).not.toContain(`- id: llm-${provider}`);
  });
});
