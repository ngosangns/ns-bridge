import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dshPatchPath, type HostPaths } from "../src/hosts.js";
import { type PluginInstallOptions, runPluginInstall } from "../src/plugin.js";

const PLUGIN = "@local/dsh-example-panel";

/** A temp home with one profile per name; each profile carries the package.json marker. */
function tree(names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "ns-bridge-plugin-"));
  const home = join(root, "home");
  const paths: HostPaths = { cliRoot: root, home, env: {} };
  for (const name of names) {
    const dir = join(home, ".dsh", "profiles", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `dsh-profile-${name}` }));
  }
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "package.json"), JSON.stringify({ name: PLUGIN }));
  return { root, home, paths, bundle };
}

type InstallArgs = Partial<PluginInstallOptions> & { hostPaths: HostPaths; bundlePath: string };

async function install(options: InstallArgs) {
  const lines: string[] = [];
  const errors: string[] = [];
  const result = await runPluginInstall({
    host: "dsh",
    apply: true,
    log: (line) => lines.push(line),
    err: (line) => errors.push(line),
    desktopRunning: () => false,
    ...options,
  });
  return { lines, errors, code: result.code };
}

describe("ns-bridge plugin install", () => {
  it("adds one insert block to every real DSH profile", async () => {
    const { paths, bundle } = tree(["web", "headless"]);
    const { code } = await install({ hostPaths: paths, bundlePath: bundle });

    expect(code).toBe(0);
    for (const name of ["web", "headless"]) {
      const patch = dshPatchPath(paths, name);
      expect(readFileSync(patch, "utf8")).toContain(`name: '${PLUGIN}'`);
    }
  });

  it("is idempotent and reports the plugin as already present", async () => {
    const { paths, bundle } = tree(["web"]);
    await install({ hostPaths: paths, bundlePath: bundle });
    const second = await install({ hostPaths: paths, bundlePath: bundle });

    expect(second.code).toBe(0);
    expect(second.lines.join("\n")).toContain("already present");
    const patch = readFileSync(dshPatchPath(paths, "web"), "utf8");
    expect(patch.match(/- insert:/g)).toHaveLength(1);
  });

  it("never touches a backup profile or a dot directory", async () => {
    const { paths, home, bundle } = tree(["web", "desktop.bak-pre-migration", ".hidden"]);
    const { code } = await install({ hostPaths: paths, bundlePath: bundle });

    expect(code).toBe(0);
    for (const name of ["desktop.bak-pre-migration", ".hidden"]) {
      expect(exists(join(home, ".dsh", "profiles", name, "cordis.patch.yml"))).toBe(false);
    }
  });

  it("skips the desktop profile while the app runs", async () => {
    const { paths, home, bundle } = tree(["desktop", "web"]);
    const { code, lines } = await install({
      hostPaths: paths,
      bundlePath: bundle,
      desktopRunning: () => true,
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("quit the DeepSeek Harness app");
    expect(exists(join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml"))).toBe(false);
  });

  it("prints planned paths without writing in a dry run", async () => {
    const { paths, home, bundle } = tree(["web"]);
    const { code, lines } = await install({ hostPaths: paths, bundlePath: bundle, apply: false });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("cordis.patch.yml");
    expect(exists(join(home, ".dsh", "profiles", "web", "cordis.patch.yml"))).toBe(false);
  });

  it("appends after existing provider blocks and keeps them", async () => {
    const { paths, home, bundle } = tree(["web"]);
    const patch = join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
    writeFileSync(
      patch,
      `- insert:\n    - id: llm-kiro\n      name: 'ns-dsh-llm-kiro'\n      config:\n        provider: kiro\n`,
      "utf8",
    );

    await install({ hostPaths: paths, bundlePath: bundle });
    const raw = readFileSync(patch, "utf8");

    expect(raw).toContain("name: 'ns-dsh-llm-kiro'");
    expect(raw).toContain(`name: '${PLUGIN}'`);
    expect(raw.indexOf("llm-kiro")).toBeLessThan(raw.indexOf(PLUGIN));
  });

  it("rejects a missing bundle, a bundle without package.json, and a nameless package", async () => {
    const { paths, root } = tree(["web"]);
    const missing = await install({ hostPaths: paths, bundlePath: join(root, "nope") });
    expect(missing.code).toBe(1);
    expect(missing.errors.join("\n")).toContain("bundle not found");

    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const noManifest = await install({ hostPaths: paths, bundlePath: empty });
    expect(noManifest.code).toBe(1);
    expect(noManifest.errors.join("\n")).toContain("missing package.json");

    writeFileSync(join(empty, "package.json"), "{}");
    const noName = await install({ hostPaths: paths, bundlePath: empty });
    expect(noName.code).toBe(1);
    expect(noName.errors.join("\n")).toContain("missing name");
  });

  it("plans host commands for pi and omp", async () => {
    const { paths, bundle } = tree(["web"]);
    const pi = await install({ hostPaths: paths, bundlePath: bundle, host: "pi", apply: false });
    const omp = await install({ hostPaths: paths, bundlePath: bundle, host: "omp", apply: false });

    expect(pi.lines.join("\n")).toContain(`pi plugin install ${bundle}`);
    expect(omp.lines.join("\n")).toContain(`omp plugin install ${bundle}`);
  });

  it("notes when no DSH profile exists", async () => {
    const { paths, bundle } = tree([]);
    const { code, lines } = await install({ hostPaths: paths, bundlePath: bundle });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("no DSH profiles");
  });
});

function exists(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
