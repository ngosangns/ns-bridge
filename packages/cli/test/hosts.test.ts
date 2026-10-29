import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DSH_PACKAGES,
  dshBundleDir,
  dshPatchPath,
  type HostPaths,
  hostBundleDir,
  isPiBundleSource,
  parseHosts,
  piSettingsPath,
  planHostCommands,
} from "../src/hosts.js";
import { PROVIDERS } from "../src/selection.js";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "ns-bridge-hosts-"));
  const home = join(root, "home");
  const paths: HostPaths = { cliRoot: root, home, env: {} };
  const pi = hostBundleDir(paths, "pi");
  const omp = hostBundleDir(paths, "omp");
  for (const dir of [pi, omp, ...PROVIDERS.map((provider) => dshBundleDir(paths, provider))]) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "dist", "index.js"), "");
  }
  return { root, home, paths, pi, omp };
}

function argvOf(steps: ReturnType<typeof planHostCommands>["steps"]): string[][] {
  return steps.flatMap((step) => (step.argv ? [step.argv] : []));
}

describe("parseHosts", () => {
  it("accepts one host, all, or nothing", () => {
    expect(parseHosts(undefined)).toEqual(["pi", "omp", "dsh"]);
    expect(parseHosts("all")).toEqual(["pi", "omp", "dsh"]);
    expect(parseHosts("dsh")).toEqual(["dsh"]);
    expect(parseHosts("nope")).toEqual({ error: "unknown host nope (expected pi, omp, dsh, or all)" });
  });
});

describe("planHostCommands install", () => {
  it("migrates Pi and OMP off the npm plugins, in that order", () => {
    const { paths, pi, omp } = tree();
    const plan = planHostCommands("install", ["pi", "omp"], undefined, paths);
    expect(plan.error).toBeUndefined();
    expect(argvOf(plan.steps)).toEqual([
      ["pi", "uninstall", "npm:@ngosangns/ns-pi-provider"],
      ["pi", "install", pi],
      ["omp", "plugin", "uninstall", "ns-omp-provider-kiro"],
      ["omp", "plugin", "install", omp],
    ]);
    expect(plan.steps[0]?.tolerate).toBe(true);
    expect(plan.steps[1]?.tolerate).toBeUndefined();
    expect(plan.steps[3]?.tolerate).toBe(true);
    expect(plan.steps[4]?.tolerate).toBeUndefined();
    expect(plan.skipDsh).toBe(false);
  });

  it("links all five provider bundles for DSH and edits the profile patch", () => {
    const { paths } = tree();
    const plan = planHostCommands("install", ["dsh"], "headless", paths);
    const [link, patch] = plan.steps;
    expect(link?.argv).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "headless",
      "add",
      ...PROVIDERS.map((provider) => `link:${dshBundleDir(paths, provider)}`),
    ]);
    expect(patch?.argv).toBeUndefined();
    expect(patch?.label).toContain(dshPatchPath(paths, "headless"));
  });

  it("is idempotent: update plans the same steps as install", () => {
    const { paths } = tree();
    const install = planHostCommands("install", ["pi", "omp"], "web", paths);
    const update = planHostCommands("update", ["pi", "omp"], "web", paths);
    expect(update.steps.map((s) => ({ ...s, apply: Boolean(s.apply) }))).toEqual(
      install.steps.map((s) => ({ ...s, apply: Boolean(s.apply) })),
    );
  });

  it("applies the patch step only when the commands succeeded", () => {
    const { paths } = tree();
    const plan = planHostCommands("install", ["dsh"], "headless", paths);
    expect(plan.steps[0]?.apply).toBeUndefined();
    expect(typeof plan.steps[1]?.apply).toBe("function");
  });
});

describe("planHostCommands guards", () => {
  it("refuses when a bundle is missing", () => {
    const { paths, omp } = tree();
    mkdirSync(join(omp, "dist"), { recursive: true });
    writeFileSync(join(omp, "dist", "index.js"), "");
    writeFileSync(join(omp, "package.json"), "{}");
    const plan = planHostCommands("install", ["omp"], undefined, {
      ...paths,
      cliRoot: join(paths.cliRoot, "elsewhere"),
    });
    expect(plan.error).toContain("host bundles are missing");
    expect(plan.error).toContain("reinstall @ngosangns/ns-bridge");
    expect(plan.steps).toEqual([]);
  });

  it("refuses to register an extension inside an npx cache", () => {
    const { paths } = tree();
    const plan = planHostCommands("install", ["pi"], undefined, {
      ...paths,
      cliRoot: join(paths.cliRoot, "_npx", "abc123", "node_modules", "@ngosangns", "ns-bridge"),
    });
    expect(plan.error).toContain("npx cache");
    expect(plan.steps).toEqual([]);
  });

  it("lets uninstall run from anywhere, even without bundles", () => {
    const plan = planHostCommands("uninstall", ["pi"], undefined, {
      cliRoot: join(tmpdir(), "_npx", "gone"),
      home: join(tmpdir(), "nobody"),
      env: {},
    });
    expect(plan.error).toBeUndefined();
    expect(argvOf(plan.steps)).toEqual([
      ["pi", "uninstall", join(tmpdir(), "_npx", "gone", "dist", "hosts", "pi")],
      ["pi", "uninstall", "npm:@ngosangns/ns-pi-provider"],
    ]);
  });

  it("requires a profile for DSH and refuses desktop", () => {
    const { paths } = tree();
    expect(planHostCommands("install", ["dsh"], undefined, paths).error).toBe("dsh needs --profile <name>");
    expect(planHostCommands("install", ["dsh"], "Desktop", paths).error).toContain("managed by the DSH Electron app");
  });

  it("skips DSH when another host shares the plan", () => {
    const { paths } = tree();
    const plan = planHostCommands("install", ["pi", "dsh"], undefined, paths);
    expect(plan.error).toBeUndefined();
    expect(plan.skipDsh).toBe(true);
    expect(plan.steps.every((step) => step.host === "pi")).toBe(true);
  });
});

describe("planHostCommands uninstall", () => {
  it("removes OMP's npm plugin and the same-name bundle", () => {
    const { paths } = tree();
    const plan = planHostCommands("uninstall", ["omp"], undefined, paths);
    expect(argvOf(plan.steps)).toEqual([
      ["omp", "plugin", "uninstall", ...["ns-omp-provider-kiro", "ns-omp-provider"]],
    ]);
  });

  it("removes the five DSH packages and their patch blocks", () => {
    const { paths } = tree();
    const plan = planHostCommands("uninstall", ["dsh"], "web", paths);
    expect(argvOf(plan.steps)).toEqual([["dsh", "plugin", "--profile", "web", "remove", ...DSH_PACKAGES]]);
    expect(typeof plan.steps[1]?.apply).toBe("function");
  });
});

describe("local apply steps", () => {
  it("prunes stale Pi bundle entries and keeps the current one", () => {
    const { paths, pi } = tree();
    const settings = piSettingsPath(paths);
    mkdirSync(join(settings, ".."), { recursive: true });
    const older = join(paths.cliRoot, "old", "dist", "hosts", "pi");
    writeFileSync(
      settings,
      JSON.stringify({
        packages: [
          "npm:other-package",
          { source: older },
          "file:../relative/dist/hosts/pi",
          pi,
          `file:${pi}`,
          "/somewhere/dist/hosts/pi",
        ],
      }),
    );
    const plan = planHostCommands("install", ["pi"], undefined, paths);
    const prune = plan.steps.find((step) => step.apply);
    expect(typeof prune?.apply).toBe("function");
    const message = prune?.apply?.();
    expect(message).toBe(`${settings}: removed 3 stale local entries`);
    expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual(["npm:other-package", pi, `file:${pi}`]);
  });

  it("leaves other Pi entries alone and reports when nothing is stale", () => {
    const { paths } = tree();
    const settings = piSettingsPath(paths);
    mkdirSync(join(settings, ".."), { recursive: true });
    writeFileSync(settings, JSON.stringify({ packages: ["npm:a", "npm:b"] }));
    const plan = planHostCommands("install", ["pi"], undefined, paths);
    const prune = plan.steps.find((step) => step.apply);
    expect(prune?.apply?.()).toBe(`${settings}: no stale local entries`);
    expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual(["npm:a", "npm:b"]);
  });

  it("treats a missing settings file as nothing to prune", () => {
    const { paths } = tree();
    const plan = planHostCommands("install", ["pi"], undefined, paths);
    const prune = plan.steps.find((step) => step.apply);
    expect(prune?.apply?.()).toContain("no local entries to prune");
  });

  it("writes the five DSH blocks once, then reports them present", () => {
    const { paths } = tree();
    const patch = dshPatchPath(paths, "headless");
    const plan = planHostCommands("install", ["dsh"], "headless", paths);
    const ensure = plan.steps.find((step) => step.apply);
    expect(ensure?.apply?.()).toBe(`${patch}: provider blocks written`);
    const raw = readFileSync(patch, "utf8");
    for (const id of ["llm-kiro", "llm-devin", "llm-grok", "llm-arnict", "llm-qoder"]) {
      expect(raw).toContain(`- id: ${id}`);
    }
    expect(ensure?.apply?.()).toBe(`${patch}: provider blocks already present`);
  });

  it("removes the DSH blocks it wrote and keeps unrelated ones", () => {
    const { paths } = tree();
    const patch = dshPatchPath(paths, "web");
    mkdirSync(join(patch, ".."), { recursive: true });
    writeFileSync(
      patch,
      [
        "- insert:",
        "    - id: user-plugin",
        "      name: user-plugin",
        "",
        "- insert:",
        "    - id: llm-kiro",
        "      name: 'ns-dsh-llm-kiro'",
        "",
      ].join("\n"),
    );
    const plan = planHostCommands("uninstall", ["dsh"], "web", paths);
    const remove = plan.steps.find((step) => step.apply);
    expect(remove?.apply?.()).toBe(`${patch}: ns-bridge provider blocks removed`);
    const raw = readFileSync(patch, "utf8");
    expect(raw).toContain("user-plugin");
    expect(raw).not.toContain("llm-kiro");
  });
});

describe("isPiBundleSource", () => {
  it("recognises absolute, file:, and relative bundle paths only", () => {
    const base = join(tmpdir(), "settings");
    expect(isPiBundleSource("/opt/cli/dist/hosts/pi", base)).toBe(true);
    expect(isPiBundleSource("file:/opt/cli/dist/hosts/pi", base)).toBe(true);
    expect(isPiBundleSource("../cli/dist/hosts/pi", base)).toBe(true);
    expect(isPiBundleSource("./cli/dist/hosts/pi", base)).toBe(true);
    expect(isPiBundleSource("dist/hosts/pi", base)).toBe(true);
    expect(isPiBundleSource("npm:@ngosangns/ns-pi-provider", base)).toBe(false);
    expect(isPiBundleSource("git:github.com/x/y", base)).toBe(false);
    expect(isPiBundleSource("/opt/cli/dist/hosts/pi-other", base)).toBe(false);
  });
});
