import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CatalogPaths } from "../src/catalog.js";
import { type Runner, run } from "../src/cli.js";
import type { HostPaths } from "../src/hosts.js";
import type { KiroProfileListing, KiroProfileOps } from "../src/kiro-profile.js";
import type { ModelRefresh } from "../src/refresh.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    log: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
  };
}

function pathsIn(dir: string): CatalogPaths {
  return {
    kiro: join(dir, "kiro.json"),
    devin: join(dir, "devin.json"),
    grok: join(dir, "grok.json"),
    arnict: join(dir, "arnict.json"),
    qoder: join(dir, "qoder.json"),
  };
}

/** A temp CLI tree with the prebuilt host bundles in place. */
function hostTree() {
  const root = mkdtempSync(join(tmpdir(), "ns-bridge-hosts-"));
  const hosts: Array<[string, string]> = [
    ["pi", join(root, "dist", "hosts", "pi")],
    ["omp", join(root, "dist", "hosts", "omp")],
    ...["kiro", "devin", "grok", "arnict", "qoder"].map((vendor): [string, string] => [
      `dsh-${vendor}`,
      join(root, "dist", "hosts", "dsh", vendor),
    ]),
  ];
  for (const [, dir] of hosts) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "dist", "index.js"), "");
  }
  const paths: HostPaths = { cliRoot: root, home: join(root, "home"), env: {} };
  return {
    root,
    paths,
    pi: join(root, "dist", "hosts", "pi"),
    omp: join(root, "dist", "hosts", "omp"),
    dsh: (vendor: string) => join(root, "dist", "hosts", "dsh", vendor),
  };
}

describe("ns-bridge", () => {
  it("prints help and does not spawn", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const code = await run([], { ...io, runner });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("ns-bridge models refresh");
    expect(io.stdout.join("\n")).toContain("dist/hosts/omp");
    expect(io.stdout.join("\n")).toContain("--dry-run");
    expect(runner).not.toHaveBeenCalled();
  });

  it("previews pi and omp install and notes that no DSH profiles exist", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const tree = hostTree();
    const code = await run(["install", "--dry-run"], { ...io, runner, hostPaths: tree.paths });
    expect(code).toBe(0);
    expect(io.stdout).toEqual([
      "# dry-run (run without --dry-run to apply)",
      "pi uninstall npm:@ngosangns/ns-pi-provider",
      `pi install ${tree.pi}`,
      `prune stale local entries in ${join(tree.paths.home, ".pi", "agent", "settings.json")}`,
      "omp plugin uninstall ns-omp-provider-kiro ns-omp-provider",
      `omp plugin install ${tree.omp}`,
      `# dsh skipped: no DSH profiles under ${join(tree.paths.home, ".dsh", "profiles")}`,
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("previews an install for all three hosts for a named profile", async () => {
    const io = capture();
    const tree = hostTree();
    const code = await run(["install", "all", "--profile", "headless", "--dry-run"], { ...io, hostPaths: tree.paths });
    expect(code).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain(`omp plugin install ${tree.omp}`);
    expect(out).toContain(
      [
        "dsh plugin --profile headless remove",
        "ns-dsh-llm-kiro",
        "ns-dsh-llm-devin",
        "ns-dsh-llm-grok",
        "ns-dsh-llm-arnict",
        "ns-dsh-llm-qoder",
      ].join(" "),
    );
    expect(out).toContain(
      [
        "dsh plugin --profile headless add",
        `link:${tree.dsh("kiro")}`,
        `link:${tree.dsh("devin")}`,
        `link:${tree.dsh("grok")}`,
        `link:${tree.dsh("arnict")}`,
        `link:${tree.dsh("qoder")}`,
      ].join(" "),
    );
    expect(out).toContain(
      `ensure provider blocks in ${join(tree.paths.home, ".dsh", "profiles", "headless", "cordis.patch.yml")}`,
    );
  });

  it("updates a host with the same plan as install", async () => {
    const install = capture();
    const update = capture();
    const tree = hostTree();
    expect(await run(["install", "omp", "--dry-run"], { ...install, hostPaths: tree.paths })).toBe(0);
    expect(await run(["update", "omp", "--dry-run"], { ...update, hostPaths: tree.paths })).toBe(0);
    expect(update.stdout).toEqual(install.stdout);
  });

  it("uninstalls the old ns-omp-provider along with the kiro plugin, but never installs or upgrades it", async () => {
    const io = capture();
    const tree = hostTree();
    expect(await run(["uninstall", "omp", "--dry-run"], { ...io, hostPaths: tree.paths })).toBe(0);
    expect(io.stdout).toContain("omp plugin uninstall ns-omp-provider-kiro ns-omp-provider");
    expect(io.stdout.join("\n")).not.toMatch(/(install|upgrade) ns-omp-provider( |$)/);
    const help = capture();
    await run(["help"], help);
    expect(help.stdout.join("\n")).toContain("OMP has its own devin, xai, and xai-oauth providers");
  });

  it("runs host commands by default", async () => {
    const io = capture();
    const calls: string[][] = [];
    const tree = hostTree();
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "installed", stderr: "" };
    };
    const code = await run(["install", "pi"], { ...io, runner, hostPaths: tree.paths });
    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pi", "uninstall", "npm:@ngosangns/ns-pi-provider"],
      ["pi", "install", tree.pi],
    ]);
    expect(io.stdout).toContain("installed");
  });

  it("continues past a tolerated migration command and reports the ones it ignored", async () => {
    const io = capture();
    const calls: string[][] = [];
    const tree = hostTree();
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return argv[2] === "uninstall"
        ? { code: 1, stdout: "", stderr: "not installed" }
        : { code: 0, stdout: "", stderr: "" };
    };
    expect(await run(["install", "omp"], { ...io, runner, hostPaths: tree.paths })).toBe(0);
    expect(calls).toEqual([
      ["omp", "plugin", "uninstall", "ns-omp-provider-kiro", "ns-omp-provider"],
      ["omp", "plugin", "install", tree.omp],
    ]);
    expect(io.stdout.join("\n")).toContain(
      "# ignored: omp plugin uninstall ns-omp-provider-kiro ns-omp-provider exited 1",
    );
    expect(io.stderr).toEqual([]);
  });

  it("rejects the removed --apply flag", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const code = await run(["install", "pi", "--apply"], { ...io, runner });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("--apply was removed");
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns 2 when a host command fails and does not continue", async () => {
    const io = capture();
    const calls: string[][] = [];
    const tree = hostTree();
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 1, stdout: "", stderr: "nope" };
    };
    const code = await run(["install"], { ...io, runner, hostPaths: tree.paths });
    expect(code).toBe(2);
    expect(calls).toEqual([
      ["pi", "uninstall", "npm:@ngosangns/ns-pi-provider"],
      ["pi", "install", tree.pi],
    ]);
    expect(io.stderr.join("\n")).toContain("exited 1");
  });

  it("refuses the desktop profile while the app runs, and does not spawn", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const tree = hostTree();
    mkdirSync(join(tree.paths.home, ".dsh", "profiles", "desktop"), { recursive: true });
    writeFileSync(join(tree.paths.home, ".dsh", "profiles", "desktop", "package.json"), "{}");
    const code = await run(["install", "dsh", "--profile", "desktop"], {
      ...io,
      runner,
      hostPaths: tree.paths,
      desktopRunning: () => true,
    });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("quit the DeepSeek Harness app");
    expect(runner).not.toHaveBeenCalled();
  });

  it("notes empty DSH profiles instead of erroring when dsh has no --profile", async () => {
    const io = capture();
    const tree = hostTree();
    const code = await run(["uninstall", "dsh"], { ...io, hostPaths: tree.paths });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("# dsh skipped: no DSH profiles under");
  });

  it("lists ids from the catalog files and does not invent a fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const paths = pathsIn(dir);
    const now = 10_000;
    writeFileSync(
      paths.devin,
      JSON.stringify({ fetchedAt: now - 1000, models: [{ id: "swe-1-6" }, { id: "swe-2-high" }] }),
    );
    writeFileSync(
      paths.kiro,
      JSON.stringify({
        regions: {
          "us-east-1": { fetchedAt: now - 1000, models: [{ id: "claude-opus-5" }] },
        },
      }),
    );
    const io = capture();
    const code = await run(["models", "list"], { ...io, paths, now });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("claude-opus-5");
    expect(io.stdout.join("\n")).toContain("swe-2-high");
    expect(io.stdout.join("\n")).toContain("grok  no cache file");
    expect(io.stdout.join("\n")).toContain("arnict  no cache file");
    expect(io.stdout.join("\n")).not.toContain("grok-4.7");
  });

  it("rejects an unknown vendor naming the accepted list", async () => {
    const io = capture();
    expect(await run(["models", "list", "nope"], io)).toBe(1);
    expect(io.stderr).toEqual(["unknown vendor nope (expected kiro, devin, grok, arnict, qoder, or all)"]);
  });

  it("lists arnict ids from its catalog file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const paths = pathsIn(dir);
    writeFileSync(
      paths.arnict,
      JSON.stringify({
        fetchedAt: 9_000,
        models: [{ id: "zai/glm-5.3", contextWindow: 1_000_000, maxTokens: 32_000 }],
      }),
    );
    const io = capture();
    expect(await run(["models", "list", "arnict"], { ...io, paths, now: 10_000 })).toBe(0);
    expect(io.stdout.join("\n")).toContain("zai/glm-5.3  window 1000000  max 32000  compact at —");
  });

  it("prints each model's window, ceiling, and compaction point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const paths = pathsIn(dir);
    const now = 10_000;
    writeFileSync(
      paths.devin,
      JSON.stringify({
        fetchedAt: now - 1000,
        models: [
          {
            id: "swe-1-6",
            contextWindow: 200_000,
            maxTokens: 128_000,
            compaction: { reserveTokens: 16_384, thresholdTokens: 183_616 },
          },
          { id: "swe-old", contextWindow: 200_000, maxTokens: 128_000 },
        ],
      }),
    );
    writeFileSync(
      paths.kiro,
      JSON.stringify({
        regions: {
          "us-east-1": {
            fetchedAt: now - 1000,
            models: [
              {
                id: "claude-opus-5",
                contextWindow: 200_000,
                maxTokens: 8_192,
                compaction: { reserveTokens: 8_192, thresholdTokens: 191_808 },
              },
            ],
          },
        },
      }),
    );
    const io = capture();
    const code = await run(["models", "list"], { ...io, paths, now });
    expect(code).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain("swe-1-6  window 200000  max 128000  compact at 183616");
    // A file written before the field existed prints a dash, not a guessed number.
    expect(out).toContain("swe-old  window 200000  max 128000  compact at —");
    expect(out).toContain("claude-opus-5  window 200000  max 8192  compact at 191808");
  });

  it("shows the vendor display name when it says more than the id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const paths = pathsIn(dir);
    writeFileSync(
      paths.qoder,
      JSON.stringify({
        fetchedAt: 9_000,
        models: [
          { id: "cmodel", name: "Cantus", contextWindow: 180_000, maxTokens: 32_000 },
          { id: "auto", name: "Auto", contextWindow: 200_000, maxTokens: 32_000 },
          { id: "fast", contextWindow: 200_000, maxTokens: 32_000 },
        ],
      }),
    );
    const io = capture();
    expect(await run(["models", "list", "qoder"], { ...io, paths, now: 10_000 })).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain("cmodel (Cantus)  window 180000  max 32000  compact at —");
    expect(out).toContain("auto  window 200000  max 32000  compact at —");
    expect(out).toContain("fast  window 200000  max 32000  compact at —");
  });

  it("keeps status to one summary line per vendor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const paths = pathsIn(dir);
    writeFileSync(
      paths.devin,
      JSON.stringify({
        fetchedAt: 9_000,
        models: [
          {
            id: "swe-1-6",
            contextWindow: 200_000,
            maxTokens: 128_000,
            compaction: { reserveTokens: 16_384, thresholdTokens: 183_616 },
          },
        ],
      }),
    );
    const io = capture();
    const code = await run(["status"], { ...io, paths, now: 10_000 });
    expect(code).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).not.toContain("compact at");
    expect(out).toContain("swe-1-6");
  });

  it("reports host bundles a moved or removed CLI left behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const io = capture();
    const code = await run(["status"], {
      ...io,
      paths: pathsIn(dir),
      hostPaths: { cliRoot: join(dir, "missing-cli"), home: dir, env: {} },
    });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain(
      "# host bundles missing (pi, omp, dsh/kiro, dsh/devin, dsh/grok, dsh/arnict, dsh/qoder); re-run ns-bridge install",
    );
  });

  it("reports an unreadable catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const paths = pathsIn(dir);
    writeFileSync(paths.grok, "{");
    const io = capture();
    const code = await run(["status", "grok"], { ...io, paths });
    expect(code).toBe(1);
    const listed = await run(["models", "list", "grok"], { ...io, paths });
    expect(listed).toBe(0);
    expect(io.stdout).toEqual([`grok  unreadable cache  ${paths.grok}`]);
  });

  it("previews model refresh without calling the refreshers", async () => {
    const io = capture();
    const refreshers: ModelRefresh = {
      kiro: vi.fn(async () => ({ count: 1 })),
      devin: vi.fn(async () => ({ count: 1 })),
      grok: vi.fn(async () => ({ count: 1 })),
      arnict: vi.fn(async () => ({ count: 1 })),
      qoder: vi.fn(async () => ({ count: 1 })),
    };
    const code = await run(["models", "refresh", "kiro", "--dry-run"], { ...io, refreshers });
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["# dry-run (run without --dry-run to apply)", "refresh kiro"]);
    expect(refreshers.kiro).not.toHaveBeenCalled();
    expect(refreshers.devin).not.toHaveBeenCalled();
  });

  it("refreshes arnict and reports the catalog source", async () => {
    const io = capture();
    const arnict = vi.fn(async () => ({ count: 4, detail: "source=live" }));
    const refreshers: ModelRefresh = {
      kiro: vi.fn(async () => ({ count: 1 })),
      devin: vi.fn(async () => ({ count: 1 })),
      grok: vi.fn(async () => ({ count: 1 })),
      arnict,
      qoder: vi.fn(async () => ({ count: 1 })),
    };
    const code = await run(["models", "refresh", "arnict"], { ...io, refreshers });
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["arnict: 4 model(s) source=live"]);
    expect(arnict).toHaveBeenCalledOnce();
    expect(refreshers.kiro).not.toHaveBeenCalled();
    expect(refreshers.devin).not.toHaveBeenCalled();
    expect(refreshers.grok).not.toHaveBeenCalled();
  });

  it("refreshes only the selected vendor by default", async () => {
    const io = capture();
    const refreshers: ModelRefresh = {
      kiro: vi.fn(async () => ({ count: 3, detail: "region=us-east-1" })),
      devin: vi.fn(async () => ({ count: 9 })),
      grok: vi.fn(async () => {
        throw new Error("grok should not run");
      }),
      arnict: vi.fn(async () => ({ count: 1 })),
      qoder: vi.fn(async () => ({ count: 1 })),
    };
    const code = await run(["models", "refresh", "kiro"], { ...io, refreshers });
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["kiro: 3 model(s) region=us-east-1"]);
    expect(refreshers.devin).not.toHaveBeenCalled();
    expect(refreshers.grok).not.toHaveBeenCalled();
  });

  it("stops when a refresh fails", async () => {
    const io = capture();
    const refreshers: ModelRefresh = {
      kiro: vi.fn(async () => ({ count: 1 })),
      devin: vi.fn(async () => {
        throw new Error("catalog down");
      }),
      grok: vi.fn(async () => ({ count: 1 })),
      arnict: vi.fn(async () => ({ count: 1 })),
      qoder: vi.fn(async () => ({ count: 1 })),
    };
    const code = await run(["models", "refresh"], { ...io, refreshers });
    expect(code).toBe(1);
    expect(io.stdout).toEqual(["kiro: 1 model(s)"]);
    expect(io.stderr).toEqual(["devin: catalog down"]);
    expect(refreshers.grok).not.toHaveBeenCalled();
    expect(refreshers.arnict).not.toHaveBeenCalled();
  });

  it("previews a provider disable with --dry-run and does not write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const io = capture();
    const selection = join(dir, "providers.json");
    const code = await run(["providers", "disable", "pi", "grok", "--dry-run"], {
      ...io,
      providerPaths: { selection, piSettings: join(dir, "missing.json"), dshHome: dir },
    });
    expect(code).toBe(0);
    expect(io.stdout[0]).toBe("# dry-run (run without --dry-run to apply)");
    expect(io.stdout[1]).toContain("grok off");
    expect(() => readFileSync(selection, "utf8")).toThrow();
  });

  it("writes the provider selection for omp kiro and reports pi status from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const selection = join(dir, "providers.json");
    const piSettings = join(dir, "settings.json");
    writeFileSync(piSettings, JSON.stringify({ packages: ["npm:@ngosangns/ns-pi-provider"] }));
    const paths = { selection, piSettings, dshHome: dir };
    const io = capture();
    expect(await run(["providers", "disable", "pi", "devin"], { ...io, providerPaths: paths })).toBe(0);
    // Only the choice is written. Defaults stay out of the file, so no reader mistakes one for a choice.
    expect(JSON.parse(readFileSync(selection, "utf8"))).toEqual({ devin: false });
    expect(await run(["providers", "disable", "omp", "kiro"], { ...io, providerPaths: paths })).toBe(0);
    expect(JSON.parse(readFileSync(selection, "utf8"))).toEqual({ kiro: false, devin: false });
    const status = capture();
    expect(await run(["providers", "status", "pi"], { ...status, providerPaths: paths })).toBe(0);
    expect(status.stdout.join("\n")).toContain("pi devin off");
    expect(status.stdout.join("\n")).toContain("pi grok on");
    expect(status.stdout.join("\n")).toContain("pi kiro off");
  });

  it("rejects an unknown provider naming the accepted list", async () => {
    const io = capture();
    expect(await run(["providers", "enable", "pi", "nope"], io)).toBe(1);
    expect(io.stderr).toEqual(["unknown provider nope (expected kiro, devin, grok, arnict, or qoder)"]);
  });

  it("enables arnict for pi and writes the shared file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const selection = join(dir, "providers.json");
    const piSettings = join(dir, "settings.json");
    writeFileSync(piSettings, JSON.stringify({ packages: ["npm:@ngosangns/ns-pi-provider"] }));
    const io = capture();
    expect(
      await run(["providers", "enable", "pi", "arnict"], {
        ...io,
        providerPaths: { selection, piSettings, dshHome: dir },
      }),
    ).toBe(0);
    expect(io.stdout.join("\n")).toContain("arnict on");
    expect(JSON.parse(readFileSync(selection, "utf8"))).toEqual({ arnict: true });
  });

  describe("omp has native devin and xai, so only kiro and arnict are choices", () => {
    function setup() {
      const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
      const selection = join(dir, "providers.json");
      return { selection, paths: { selection, piSettings: join(dir, "missing.json"), dshHome: dir } };
    }

    it("refuses to enable devin or grok for omp, says why, and writes nothing", async () => {
      const { selection, paths } = setup();
      for (const provider of ["devin", "grok"]) {
        const io = capture();
        expect(await run(["providers", "enable", "omp", provider], { ...io, providerPaths: paths })).toBe(1);
        expect(io.stderr.join("\n")).toContain(`omp does not use ns-bridge for ${provider}`);
        expect(io.stdout).toEqual([]);
      }
      const io = capture();
      await run(["providers", "enable", "omp", "devin"], { ...io, providerPaths: paths });
      expect(io.stderr.join("\n")).toContain("/login devin");
      const grok = capture();
      await run(["providers", "enable", "omp", "grok"], { ...grok, providerPaths: paths });
      expect(grok.stderr.join("\n")).toContain("/login xai-oauth");
      expect(() => readFileSync(selection, "utf8")).toThrow();
    });

    it("treats disable of devin or grok for omp as already done and leaves the file alone", async () => {
      const { selection, paths } = setup();
      writeFileSync(selection, JSON.stringify({ kiro: true, devin: true, grok: true }));
      const io = capture();
      expect(await run(["providers", "disable", "omp", "devin"], { ...io, providerPaths: paths })).toBe(0);
      expect(await run(["providers", "disable", "omp", "grok"], { ...io, providerPaths: paths })).toBe(0);
      expect(io.stdout.join("\n")).toContain("omp devin off (nothing to change");
      expect(io.stdout.join("\n")).toContain("omp grok off (nothing to change");
      expect(JSON.parse(readFileSync(selection, "utf8"))).toEqual({ kiro: true, devin: true, grok: true });
    });

    it("reports omp devin and grok as not provided, even when the shared file turns them on", async () => {
      const { selection, paths } = setup();
      writeFileSync(selection, JSON.stringify({ kiro: true, devin: true, grok: true }));
      const io = capture();
      expect(await run(["providers", "status", "omp"], { ...io, providerPaths: paths })).toBe(0);
      const out = io.stdout.join("\n");
      expect(out).toContain("omp kiro on");
      expect(out).toContain("omp arnict on");
      expect(out).toContain("omp devin off (not provided: OMP has its own devin provider");
      expect(out).toContain("omp grok off (not provided: OMP has its own xai and xai-oauth providers");
    });

    it("enables and disables arnict for omp through the shared file", async () => {
      const { selection, paths } = setup();
      const io = capture();
      expect(await run(["providers", "enable", "omp", "arnict"], { ...io, providerPaths: paths })).toBe(0);
      expect(io.stdout.join("\n")).toContain("arnict on");
      expect(JSON.parse(readFileSync(selection, "utf8"))).toEqual({ arnict: true });
      const off = capture();
      expect(await run(["providers", "disable", "omp", "arnict"], { ...off, providerPaths: paths })).toBe(0);
      expect(JSON.parse(readFileSync(selection, "utf8"))).toEqual({ arnict: false });
    });

    it("keeps devin and grok for pi", async () => {
      const { paths } = setup();
      const piSettings = join(paths.dshHome, "settings.json");
      writeFileSync(piSettings, JSON.stringify({ packages: ["npm:@ngosangns/ns-pi-provider"] }));
      const io = capture();
      expect(
        await run(["providers", "enable", "pi", "devin"], { ...io, providerPaths: { ...paths, piSettings } }),
      ).toBe(0);
      expect(io.stdout.join("\n")).toContain("devin on");
    });
  });

  it("sets disabled on a dsh plugin and clears it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const patchDir = join(dir, "profiles", "headless");
    mkdirSync(patchDir, { recursive: true });
    const patch = join(patchDir, "cordis.patch.yml");
    writeFileSync(
      patch,
      [
        "- insert:",
        "    - id: llm-grok",
        "      name: ns-dsh-llm-grok",
        "      config:",
        "        provider: grok",
        "",
      ].join("\n"),
    );
    const paths = { selection: join(dir, "providers.json"), piSettings: join(dir, "settings.json"), dshHome: dir };
    const off = capture();
    expect(
      await run(["providers", "disable", "dsh", "grok", "--profile", "headless"], {
        ...off,
        providerPaths: paths,
      }),
    ).toBe(0);
    expect(readFileSync(patch, "utf8")).toContain("disabled: true");
    const on = capture();
    expect(
      await run(["providers", "enable", "dsh", "grok", "--profile", "headless"], {
        ...on,
        providerPaths: paths,
      }),
    ).toBe(0);
    expect(readFileSync(patch, "utf8")).not.toContain("disabled:");
  });

  it("maps arnict to the llm-arnict plugin id and refuses it when the dsh patch lacks it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const patchDir = join(dir, "profiles", "headless");
    mkdirSync(patchDir, { recursive: true });
    const patch = join(patchDir, "cordis.patch.yml");
    writeFileSync(
      patch,
      [
        "- insert:",
        "    - id: llm-arnict",
        "      name: ns-dsh-llm-arnict",
        "      config:",
        "        provider: arnict",
        "",
      ].join("\n"),
    );
    const paths = { selection: join(dir, "providers.json"), piSettings: join(dir, "settings.json"), dshHome: dir };
    const off = capture();
    expect(
      await run(["providers", "disable", "dsh", "arnict", "--profile", "headless"], {
        ...off,
        providerPaths: paths,
      }),
    ).toBe(0);
    expect(readFileSync(patch, "utf8")).toContain("disabled: true");
    const on = capture();
    expect(
      await run(["providers", "enable", "dsh", "arnict", "--profile", "headless"], {
        ...on,
        providerPaths: paths,
      }),
    ).toBe(0);
    expect(readFileSync(patch, "utf8")).not.toContain("disabled:");

    // The dsh package is installed in a later step; a patch without the plugin stays safe.
    const emptyDir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const emptyPatch = join(emptyDir, "profiles", "headless", "cordis.patch.yml");
    mkdirSync(join(emptyDir, "profiles", "headless"), { recursive: true });
    writeFileSync(emptyPatch, "- insert:\n    - id: llm-grok\n      name: ns-dsh-llm-grok\n");
    const missing = capture();
    expect(
      await run(["providers", "disable", "dsh", "arnict", "--profile", "headless"], {
        ...missing,
        providerPaths: {
          selection: join(emptyDir, "providers.json"),
          piSettings: join(emptyDir, "s.json"),
          dshHome: emptyDir,
        },
      }),
    ).toBe(1);
    expect(missing.stderr.join("\n")).toContain(`ns-dsh-llm-arnict is not in ${emptyPatch}`);
  });

  it("previews a self-update and does not install", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "0.2.0\n", stderr: "" };
    };
    const code = await run(["update", "--dry-run"], { ...io, runner, version: "0.1.12" });
    expect(code).toBe(0);
    expect(calls).toEqual([["npm", "view", "@ngosangns/ns-bridge", "version"]]);
    expect(io.stdout).toEqual([
      "# dry-run (run without --dry-run to apply)",
      "@ngosangns/ns-bridge 0.1.12 → 0.2.0",
      "npm install -g @ngosangns/ns-bridge@0.2.0",
    ]);
  });

  it("installs the latest CLI by default", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: argv[1] === "view" ? "0.2.0\n" : "added 1 package", stderr: "" };
    };
    const code = await run(["update"], { ...io, runner, version: "0.1.12" });
    expect(code).toBe(0);
    expect(calls[1]).toEqual(["npm", "install", "-g", "@ngosangns/ns-bridge@0.2.0"]);
    expect(io.stdout.at(-1)).toBe("@ngosangns/ns-bridge updated 0.1.12 → 0.2.0");
  });

  it("does not install when this CLI is already current", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "0.1.12\n", stderr: "" };
    };
    const code = await run(["update"], { ...io, runner, version: "0.1.12" });
    expect(code).toBe(0);
    expect(calls).toEqual([["npm", "view", "@ngosangns/ns-bridge", "version"]]);
    expect(io.stdout).toEqual(["@ngosangns/ns-bridge 0.1.12 is already the latest"]);
  });

  it("reports an npm lookup failure and does not install", async () => {
    const io = capture();
    const runner: Runner = async () => ({ code: 1, stdout: "", stderr: "ENOTFOUND" });
    const code = await run(["update"], { ...io, runner, version: "0.1.12" });
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("ENOTFOUND");
  });

  it("does not manage host coding agents", async () => {
    const io = capture();
    expect(await run(["agents", "disable", "omp", "scout"], io)).toBe(1);
    expect(io.stderr[0]).toBe("unknown command agents");
  });

  describe("usage", () => {
    function line(over: Record<string, unknown>): string {
      return JSON.stringify({
        ts: "2026-10-21T05:00:00.000Z",
        vendor: "grok",
        host: "dsh",
        model: "m",
        session: "s1",
        step: 1,
        gapMs: null,
        input: 100,
        output: 10,
        promptTokens: 1000,
        cacheRead: 900,
        cacheHitRatio: 0.9,
        cacheWriteRatio: null,
        cacheSource: "wire",
        ...over,
      });
    }
    function ledger(files: Record<string, string[]>): string {
      const root = mkdtempSync(join(tmpdir(), "ns-bridge-usage-"));
      for (const [path, lines] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), `${lines.join("\n")}\n`);
      }
      return root;
    }

    it("sums cache read over prompt tokens instead of averaging per-step ratios", async () => {
      // A tiny cold step and a huge warm one: the average of ratios is 50%, the true hit is ~99%.
      const usageDir = ledger({
        "2026-10-21/grok/s1.jsonl": [
          line({ promptTokens: 100, cacheRead: 0, cacheHitRatio: 0 }),
          line({ promptTokens: 9900, cacheRead: 9900, cacheHitRatio: 1, step: 2 }),
        ],
      });
      const io = capture();
      expect(await run(["usage"], { ...io, usageDir })).toBe(0);
      expect(io.stdout.join("\n")).toContain("99.0%");
      expect(io.stdout.join("\n")).not.toContain("50.0%");
    });

    it("leaves steps without cache counters out of the hit ratio and shows their source", async () => {
      const usageDir = ledger({
        "2026-10-21/kiro/s1.jsonl": [
          line({ vendor: "kiro", promptTokens: 1000, cacheRead: 800, cacheHitRatio: 0.8 }),
          line({
            vendor: "kiro",
            promptTokens: 5000,
            cacheRead: undefined,
            cacheHitRatio: null,
            cacheSource: "none",
            step: 2,
          }),
        ],
      });
      const io = capture();
      await run(["usage"], { ...io, usageDir });
      const text = io.stdout.join("\n");
      expect(text).toContain("80.0%");
      expect(text).toContain("wire 1");
      expect(text).toContain("no cache data 1");
    });

    it("shows a credits-capped row as an upper bound and keeps it out of the hit ratio", async () => {
      const usageDir = ledger({
        "2026-10-21/kiro/s1.jsonl": [
          line({ vendor: "kiro", promptTokens: 30000, cacheRead: 27000, cacheHitRatio: 0.9, cacheSource: "credits" }),
          line({
            vendor: "kiro",
            promptTokens: 30000,
            cacheRead: undefined,
            cacheHitRatio: null,
            cacheSource: "credits-capped",
            cacheHitMax: 0.9,
            step: 2,
          }),
        ],
      });
      const summary = capture();
      await run(["usage"], { ...summary, usageDir });
      expect(summary.stdout.join("\n")).toContain("credits cap 1");
      expect(summary.stdout.join("\n")).toContain("90.0%");
      const session = capture();
      await run(["usage", "--session", "s1"], { ...session, usageDir });
      expect(session.stdout[2]).toContain("<=90.0%*");
    });

    it("counts a capped step as cold only when no first step, shrink, idle gap or other session explains it", async () => {
      const capped = { vendor: "kiro", cacheRead: undefined, cacheHitRatio: null, cacheSource: "credits-capped" };
      const warm = { vendor: "kiro", cacheSource: "credits" };
      const usageDir = ledger({
        "2026-10-21/kiro/s1.jsonl": [
          line({ ...capped, step: 1, ts: "2026-10-21T05:00:00.000Z", promptTokens: 30000 }), // first step
          line({ ...warm, step: 2, ts: "2026-10-21T05:00:10.000Z", promptTokens: 31000, gapMs: 10_000 }),
          line({ ...capped, step: 3, ts: "2026-10-21T05:00:20.000Z", promptTokens: 32000, gapMs: 10_000 }), // cold
          line({ ...capped, step: 4, ts: "2026-10-21T05:00:30.000Z", promptTokens: 9000, gapMs: 10_000 }), // shrank
          line({ ...capped, step: 5, ts: "2026-10-21T05:10:30.000Z", promptTokens: 9500, gapMs: 600_000 }), // idle
        ],
        "2026-10-21/kiro/s2.jsonl": [
          line({ ...capped, session: "s2", step: 1, ts: "2026-10-21T05:00:05.000Z", promptTokens: 8000 }), // first of s2
        ],
      });
      const io = capture();
      await run(["usage"], { ...io, usageDir });
      expect(io.stdout[1]).toContain("1/6 (16.7%)");
    });

    it("marks hit ratios derived from credits so they are not read as provider counters", async () => {
      const usageDir = ledger({
        "2026-10-21/kiro/s1.jsonl": [
          line({ vendor: "kiro", promptTokens: 20000, cacheRead: 18000, cacheHitRatio: 0.9, cacheSource: "credits" }),
          line({
            vendor: "kiro",
            promptTokens: 20000,
            cacheRead: undefined,
            cacheHitRatio: null,
            cacheSource: "none",
            step: 2,
          }),
        ],
      });
      const summary = capture();
      await run(["usage"], { ...summary, usageDir });
      expect(summary.stdout.join("\n")).toContain("from credits 1");
      expect(summary.stdout.join("\n")).toContain("no cache data 1");
      const session = capture();
      await run(["usage", "--session", "s1"], { ...session, usageDir });
      expect(session.stdout[1]).toContain("90.0%*");
    });

    it("prints a dash, not 0%, when no step reported cache", async () => {
      const usageDir = ledger({
        "2026-10-21/kiro/s1.jsonl": [
          line({ vendor: "kiro", cacheRead: undefined, cacheHitRatio: null, cacheSource: "none" }),
        ],
      });
      const io = capture();
      await run(["usage"], { ...io, usageDir });
      expect(io.stdout[1]).toMatch(/kiro\s+1\s+1\.0k\s+-\s+-\s+no cache data 1/);
    });

    it("filters by vendor and lists one session step by step", async () => {
      const usageDir = ledger({
        "2026-10-21/grok/s1.jsonl": [line({}), line({ step: 2, gapMs: 7000, cacheHitRatio: 0.5 })],
        "2026-10-21/devin/s1.jsonl": [line({ vendor: "devin", session: "s1" })],
        "2026-10-21/grok/s2.jsonl": [line({ session: "s2" })],
      });
      const byVendor = capture();
      await run(["usage", "--vendor", "devin"], { ...byVendor, usageDir });
      expect(byVendor.stdout.join("\n")).toContain("devin");
      expect(byVendor.stdout.join("\n")).not.toContain("grok");

      const bySession = capture();
      await run(["usage", "--session", "s1", "--vendor", "grok"], { ...bySession, usageDir });
      expect(bySession.stdout).toHaveLength(3);
      expect(bySession.stdout[2]).toContain("7s");
    });

    it("accepts --vendor arnict and shows USD credits as dollar amounts", async () => {
      const usageDir = ledger({
        "2026-10-21/arnict/s1.jsonl": [
          line({
            vendor: "arnict",
            model: "zai/glm-5.3",
            promptTokens: 1000,
            cacheRead: 800,
            cacheHitRatio: 0.8,
            credits: 0.0137,
            creditUnit: "USD",
          }),
        ],
      });
      const byVendor = capture();
      expect(await run(["usage", "--vendor", "arnict"], { ...byVendor, usageDir })).toBe(0);
      expect(byVendor.stdout.join("\n")).toContain("arnict");

      const session = capture();
      await run(["usage", "--session", "s1"], { ...session, usageDir });
      expect(session.stdout[0]).toContain("cost");
      expect(session.stdout[1]).toContain("$0.0137");
    });

    it("keeps non-USD credits as bare numbers in the session cost column", async () => {
      const usageDir = ledger({
        "2026-10-21/kiro/s1.jsonl": [line({ vendor: "kiro", credits: 5, creditUnit: "credit" })],
      });
      const io = capture();
      await run(["usage", "--session", "s1"], { ...io, usageDir });
      expect(io.stdout[1]).toMatch(/\s5\s*$/);
      expect(io.stdout[1]).not.toContain("$5");
    });

    it("limits to the newest days and to one named day", async () => {
      const usageDir = ledger({
        "2026-10-19/grok/s1.jsonl": [line({ ts: "2026-10-19T05:00:00.000Z" })],
        "2026-10-20/grok/s1.jsonl": [line({ ts: "2026-10-20T05:00:00.000Z" })],
        "2026-10-21/grok/s1.jsonl": [line({ ts: "2026-10-21T05:00:00.000Z" })],
      });
      const newest = capture();
      await run(["usage", "--days", "1"], { ...newest, usageDir });
      expect(newest.stdout.join("\n")).toContain("2026-10-21");
      expect(newest.stdout.join("\n")).not.toContain("2026-10-20");

      const one = capture();
      await run(["usage", "--day", "2026-10-20"], { ...one, usageDir });
      expect(one.stdout.join("\n")).toContain("2026-10-20");
      expect(one.stdout.join("\n")).not.toContain("2026-10-21");
    });

    it("prints raw lines with --json and skips a torn line with a note", async () => {
      const usageDir = ledger({ "2026-10-21/grok/s1.jsonl": [line({}), '{"vendor":"grok","prom'] });
      const io = capture();
      expect(await run(["usage", "--json"], { ...io, usageDir })).toBe(0);
      expect(io.stdout).toHaveLength(1);
      expect(JSON.parse(io.stdout[0] ?? "").vendor).toBe("grok");
      expect(io.stderr.join("\n")).toContain("skipped 1 unreadable line");
    });

    it("says so when nothing was recorded, and rejects bad input", async () => {
      const usageDir = mkdtempSync(join(tmpdir(), "ns-bridge-usage-"));
      const empty = capture();
      expect(await run(["usage"], { ...empty, usageDir })).toBe(0);
      expect(empty.stdout[0]).toBe("no usage recorded");

      for (const argv of [
        ["usage", "--vendor", "x"],
        ["usage", "--day", "yesterday"],
        ["usage", "--days", "0"],
        ["usage", "extra"],
      ]) {
        const io = capture();
        expect(await run(argv, { ...io, usageDir })).toBe(1);
      }
    });
  });
});

describe("kiro profile", () => {
  const usArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/US";
  const euArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU";

  function fakeOps(options: { cached?: string[]; active?: KiroProfileListing["active"] } = {}) {
    const selections: Array<{ arn: string; name?: string } | undefined> = [];
    const ops: KiroProfileOps = {
      list: async () => ({
        profiles: [
          { arn: usArn, name: "KiroProfile-us-east-1", region: "us-east-1" },
          { arn: euArn, name: "KiroProfile-eu-central-1", region: "eu-central-1" },
        ],
        active: options.active ?? { arn: euArn, source: "login" },
        loginArn: euArn,
      }),
      select: (selection) => selections.push(selection),
      hasCatalog: (arn) => options.cached?.includes(arn) ?? false,
      selectionPath: "/home/me/.ns-bridge/kiro-profile.json",
    };
    return { ops, selections };
  }

  function fakeRefreshers() {
    const kiro = vi.fn(async () => ({ count: 3, detail: "region=us-east-1" }));
    const refreshers: ModelRefresh = { kiro, devin: vi.fn(), grok: vi.fn(), arnict: vi.fn(), qoder: vi.fn() };
    return { kiro, refreshers };
  }

  it("lists the login's profiles and marks the active one", async () => {
    const io = capture();
    const { ops } = fakeOps();
    expect(await run(["kiro", "profile"], { ...io, kiroProfiles: ops })).toBe(0);
    expect(io.stdout).toEqual([
      `  KiroProfile-us-east-1     us-east-1     ${usArn}`,
      `* KiroProfile-eu-central-1  eu-central-1  ${euArn}  (login)`,
      "# active from the login (kiro-cli's pick, or the first profile Kiro lists)",
    ]);
  });

  it("previews a pin without writing it", async () => {
    const io = capture();
    const { ops, selections } = fakeOps();
    expect(await run(["kiro", "profile", "use", "us-east-1", "--dry-run"], { ...io, kiroProfiles: ops })).toBe(0);
    expect(io.stdout).toEqual([
      "# dry-run (run without --dry-run to apply)",
      "pin KiroProfile-us-east-1 (us-east-1) in /home/me/.ns-bridge/kiro-profile.json",
    ]);
    expect(selections).toEqual([]);
  });

  it("pins by name and fetches the catalog only when the profile has none", async () => {
    const io = capture();
    const { ops, selections } = fakeOps();
    const { kiro, refreshers } = fakeRefreshers();
    expect(
      await run(["kiro", "profile", "use", "kiroprofile-us-east-1"], {
        ...io,
        kiroProfiles: ops,
        refreshers,
      }),
    ).toBe(0);
    expect(selections).toEqual([{ arn: usArn, name: "KiroProfile-us-east-1" }]);
    expect(kiro).toHaveBeenCalledOnce();
    expect(io.stdout).toContain("kiro: 3 model(s) region=us-east-1");

    const again = capture();
    const cached = fakeOps({ cached: [usArn] });
    const second = fakeRefreshers();
    expect(
      await run(["kiro", "profile", "use", usArn], {
        ...again,
        kiroProfiles: cached.ops,
        refreshers: second.refreshers,
      }),
    ).toBe(0);
    expect(cached.selections).toEqual([{ arn: usArn, name: "KiroProfile-us-east-1" }]);
    expect(second.kiro).not.toHaveBeenCalled();
  });

  it("pins a well-formed ARN the listing does not show, with a warning", async () => {
    const io = capture();
    const { ops, selections } = fakeOps({ cached: [] });
    const { refreshers } = fakeRefreshers();
    const apArn = "arn:aws:codewhisperer:ap-southeast-1:123456789012:profile/AP";
    expect(await run(["kiro", "profile", "use", apArn], { ...io, kiroProfiles: ops, refreshers })).toBe(0);
    expect(selections).toEqual([{ arn: apArn }]);
    expect(io.stdout).toContain(`pinned ${apArn} (ap-southeast-1) in /home/me/.ns-bridge/kiro-profile.json`);
    expect(io.stderr).toContain(
      `# ${apArn} is not in this login's listing; Kiro rejects requests if the login cannot use it`,
    );

    const malformed = capture();
    const bad = fakeOps();
    expect(
      await run(["kiro", "profile", "use", "arn:aws:codewhisperer:nowhere:1:profile/X"], {
        ...malformed,
        kiroProfiles: bad.ops,
      }),
    ).toBe(1);
    expect(bad.selections).toEqual([]);
  });

  it("saves the pin and skips the catalog while KIRO_PROFILE_ARN is set", async () => {
    vi.stubEnv("KIRO_PROFILE_ARN", euArn);
    try {
      const io = capture();
      const { ops, selections } = fakeOps();
      const { kiro, refreshers } = fakeRefreshers();
      expect(
        await run(["kiro", "profile", "use", "us-east-1"], {
          ...io,
          kiroProfiles: ops,
          refreshers,
        }),
      ).toBe(0);
      expect(selections).toEqual([{ arn: usArn, name: "KiroProfile-us-east-1" }]);
      expect(kiro).not.toHaveBeenCalled();
      expect(io.stdout).toContain("# the pin takes effect once KIRO_PROFILE_ARN is unset");
      expect(io.stderr).toContain("# KIRO_PROFILE_ARN is set and outranks the pin");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("drops the pin on reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-kiro-profile-"));
    const selectionPath = join(dir, "kiro-profile.json");
    writeFileSync(selectionPath, "{}\n");
    const io = capture();
    const { ops, selections } = fakeOps();
    ops.selectionPath = selectionPath;
    try {
      expect(await run(["kiro", "profile", "reset", "--dry-run"], { ...io, kiroProfiles: ops })).toBe(0);
      expect(selections).toEqual([]);
      expect(io.stdout).toContain(`remove ${selectionPath}`);
      expect(await run(["kiro", "profile", "reset"], { ...io, kiroProfiles: ops })).toBe(0);
      expect(selections).toEqual([undefined]);
      expect(io.stdout).toContain(`removed ${selectionPath}; Kiro follows the login's profile again`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says there is no pin when the file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-kiro-profile-"));
    const selectionPath = join(dir, "kiro-profile.json");
    const io = capture();
    const { ops, selections } = fakeOps();
    ops.selectionPath = selectionPath;
    try {
      expect(await run(["kiro", "profile", "reset", "--dry-run"], { ...io, kiroProfiles: ops })).toBe(0);
      expect(await run(["kiro", "profile", "reset"], { ...io, kiroProfiles: ops })).toBe(0);
      expect(selections).toEqual([]);
      const line = `no pin at ${selectionPath}; Kiro already follows the login's profile`;
      expect(io.stdout.filter((printed) => printed === line)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown profile and malformed commands", async () => {
    const { ops } = fakeOps();
    const unknown = capture();
    expect(await run(["kiro", "profile", "use", "ap-south-1"], { ...unknown, kiroProfiles: ops })).toBe(1);
    expect(unknown.stderr[0]).toContain("no Kiro profile named ap-south-1");

    for (const argv of [
      ["kiro"],
      ["kiro", "profile", "switch"],
      ["kiro", "profile", "use"],
      ["kiro", "profile", "list", "extra"],
      ["kiro", "profile", "use", "us-east-1", "--profile", "headless"],
    ]) {
      const io = capture();
      expect(await run(argv, { ...io, kiroProfiles: ops })).toBe(1);
    }
  });
});
