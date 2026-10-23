import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CatalogPaths } from "../src/catalog.js";
import { type Runner, run } from "../src/cli.js";
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
  };
}

describe("ns-bridge", () => {
  it("prints help and does not spawn", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const code = await run([], { ...io, runner });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("ns-bridge models refresh");
    expect(io.stdout.join("\n")).toContain("omp plugin upgrade");
    expect(io.stdout.join("\n")).toContain("--apply");
    expect(runner).not.toHaveBeenCalled();
  });

  it("previews pi and omp install and skips dsh without a profile", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const code = await run(["install"], { ...io, runner });
    expect(code).toBe(0);
    expect(io.stdout).toEqual([
      "# dry-run (pass --apply to run)",
      "pi install npm:@ngosangns/ns-pi-provider",
      "omp plugin install ns-omp-provider ns-omp-provider-kiro",
      "# dsh skipped: pass --profile <name>",
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("previews omp upgrade and a dsh update for a named profile", async () => {
    const io = capture();
    const code = await run(["update", "all", "--profile", "headless"], io);
    expect(code).toBe(0);
    expect(io.stdout).toContain("omp plugin upgrade ns-omp-provider ns-omp-provider-kiro");
    expect(io.stdout).toContain(
      "dsh plugin --profile headless update ns-dsh-llm-kiro ns-dsh-llm-devin ns-dsh-llm-grok",
    );
  });

  it("runs host commands only with --apply", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "installed", stderr: "" };
    };
    const code = await run(["install", "pi", "--apply"], { ...io, runner });
    expect(code).toBe(0);
    expect(calls).toEqual([["pi", "install", "npm:@ngosangns/ns-pi-provider"]]);
    expect(io.stdout).toContain("installed");
  });

  it("returns 2 when a host command fails and does not continue", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 1, stdout: "", stderr: "nope" };
    };
    const code = await run(["install", "--apply"], { ...io, runner });
    expect(code).toBe(2);
    expect(calls).toEqual([["pi", "install", "npm:@ngosangns/ns-pi-provider"]]);
    expect(io.stderr.join("\n")).toContain("exited 1");
  });

  it("refuses the desktop profile and does not spawn", async () => {
    const io = capture();
    const runner = vi.fn<Runner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const code = await run(["install", "dsh", "--profile", "desktop", "--apply"], { ...io, runner });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Electron");
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires a profile when the only host is dsh", async () => {
    const io = capture();
    const code = await run(["uninstall", "dsh"], io);
    expect(code).toBe(1);
    expect(io.stderr).toEqual(["dsh needs --profile <name>"]);
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
    expect(io.stdout.join("\n")).not.toContain("grok-4.7");
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
    };
    const code = await run(["models", "refresh", "kiro"], { ...io, refreshers });
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["# dry-run (pass --apply to run)", "refresh kiro"]);
    expect(refreshers.kiro).not.toHaveBeenCalled();
    expect(refreshers.devin).not.toHaveBeenCalled();
  });

  it("refreshes only the selected vendor when --apply is set", async () => {
    const io = capture();
    const refreshers: ModelRefresh = {
      kiro: vi.fn(async () => ({ count: 3, detail: "region=us-east-1" })),
      devin: vi.fn(async () => ({ count: 9 })),
      grok: vi.fn(async () => {
        throw new Error("grok should not run");
      }),
    };
    const code = await run(["models", "refresh", "kiro", "--apply"], { ...io, refreshers });
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
    };
    const code = await run(["models", "refresh", "--apply"], { ...io, refreshers });
    expect(code).toBe(1);
    expect(io.stdout).toEqual(["kiro: 1 model(s)"]);
    expect(io.stderr).toEqual(["devin: catalog down"]);
    expect(refreshers.grok).not.toHaveBeenCalled();
  });

  it("previews a provider disable and does not write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const io = capture();
    const selection = join(dir, "providers.json");
    const code = await run(["providers", "disable", "omp", "grok"], {
      ...io,
      providerPaths: { selection, piSettings: join(dir, "missing.json"), dshHome: dir },
    });
    expect(code).toBe(0);
    expect(io.stdout[0]).toBe("# dry-run (pass --apply to run)");
    expect(io.stdout[1]).toContain("grok off");
    expect(() => readFileSync(selection, "utf8")).toThrow();
  });

  it("writes the provider selection for omp and reports pi status from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const selection = join(dir, "providers.json");
    const piSettings = join(dir, "settings.json");
    writeFileSync(piSettings, JSON.stringify({ packages: ["npm:@ngosangns/ns-pi-provider"] }));
    const paths = { selection, piSettings, dshHome: dir };
    const io = capture();
    expect(await run(["providers", "disable", "omp", "devin", "--apply"], { ...io, providerPaths: paths })).toBe(0);
    expect(JSON.parse(readFileSync(selection, "utf8"))).toMatchObject({ devin: false, grok: true });
    const status = capture();
    expect(await run(["providers", "status", "pi"], { ...status, providerPaths: paths })).toBe(0);
    expect(status.stdout.join("\n")).toContain("pi devin off");
    expect(status.stdout.join("\n")).toContain("pi grok on");
    expect(status.stdout.join("\n")).toContain("pi kiro on");
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
      await run(["providers", "disable", "dsh", "grok", "--profile", "headless", "--apply"], {
        ...off,
        providerPaths: paths,
      }),
    ).toBe(0);
    expect(readFileSync(patch, "utf8")).toContain("disabled: true");
    const on = capture();
    expect(
      await run(["providers", "enable", "dsh", "grok", "--profile", "headless", "--apply"], {
        ...on,
        providerPaths: paths,
      }),
    ).toBe(0);
    expect(readFileSync(patch, "utf8")).not.toContain("disabled:");
  });

  it("previews a self-update and does not install", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "0.2.0\n", stderr: "" };
    };
    const code = await run(["update"], { ...io, runner, version: "0.1.12" });
    expect(code).toBe(0);
    expect(calls).toEqual([["npm", "view", "@ngosangns/ns-bridge", "version"]]);
    expect(io.stdout).toEqual([
      "# dry-run (pass --apply to run)",
      "@ngosangns/ns-bridge 0.1.12 → 0.2.0",
      "npm install -g @ngosangns/ns-bridge@0.2.0",
    ]);
  });

  it("installs the latest CLI only with --apply", async () => {
    const io = capture();
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: argv[1] === "view" ? "0.2.0\n" : "added 1 package", stderr: "" };
    };
    const code = await run(["update", "--apply"], { ...io, runner, version: "0.1.12" });
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
    const code = await run(["update", "--apply"], { ...io, runner, version: "0.1.12" });
    expect(code).toBe(0);
    expect(calls).toEqual([["npm", "view", "@ngosangns/ns-bridge", "version"]]);
    expect(io.stdout).toEqual(["@ngosangns/ns-bridge 0.1.12 is already the latest"]);
  });

  it("reports an npm lookup failure and does not install", async () => {
    const io = capture();
    const runner: Runner = async () => ({ code: 1, stdout: "", stderr: "ENOTFOUND" });
    const code = await run(["update", "--apply"], { ...io, runner, version: "0.1.12" });
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
    const refreshers: ModelRefresh = { kiro, devin: vi.fn(), grok: vi.fn() };
    return { kiro, refreshers };
  }

  it("lists the login's profiles and marks the active one", async () => {
    const io = capture();
    const { ops } = fakeOps();
    expect(await run(["kiro", "profile"], { ...io, kiroProfiles: ops })).toBe(0);
    expect(io.stdout).toEqual([
      `  KiroProfile-us-east-1     us-east-1     ${usArn}`,
      `* KiroProfile-eu-central-1  eu-central-1  ${euArn}  (kiro-cli)`,
      "# active from the login (kiro-cli's pick, or the first profile Kiro lists)",
    ]);
  });

  it("previews a pin without writing it", async () => {
    const io = capture();
    const { ops, selections } = fakeOps();
    expect(await run(["kiro", "profile", "use", "us-east-1"], { ...io, kiroProfiles: ops })).toBe(0);
    expect(io.stdout).toEqual([
      "# dry-run (pass --apply to run)",
      "pin KiroProfile-us-east-1 (us-east-1) in /home/me/.ns-bridge/kiro-profile.json",
    ]);
    expect(selections).toEqual([]);
  });

  it("pins by name and fetches the catalog only when the profile has none", async () => {
    const io = capture();
    const { ops, selections } = fakeOps();
    const { kiro, refreshers } = fakeRefreshers();
    expect(
      await run(["kiro", "profile", "use", "kiroprofile-us-east-1", "--apply"], {
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
      await run(["kiro", "profile", "use", usArn, "--apply"], {
        ...again,
        kiroProfiles: cached.ops,
        refreshers: second.refreshers,
      }),
    ).toBe(0);
    expect(cached.selections).toEqual([{ arn: usArn, name: "KiroProfile-us-east-1" }]);
    expect(second.kiro).not.toHaveBeenCalled();
  });

  it("saves the pin and skips the catalog while KIRO_PROFILE_ARN is set", async () => {
    vi.stubEnv("KIRO_PROFILE_ARN", euArn);
    try {
      const io = capture();
      const { ops, selections } = fakeOps();
      const { kiro, refreshers } = fakeRefreshers();
      expect(
        await run(["kiro", "profile", "use", "us-east-1", "--apply"], {
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

  it("drops the pin on reset --apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-kiro-profile-"));
    const selectionPath = join(dir, "kiro-profile.json");
    writeFileSync(selectionPath, "{}\n");
    const io = capture();
    const { ops, selections } = fakeOps();
    ops.selectionPath = selectionPath;
    try {
      expect(await run(["kiro", "profile", "reset"], { ...io, kiroProfiles: ops })).toBe(0);
      expect(selections).toEqual([]);
      expect(io.stdout).toContain(`remove ${selectionPath}`);
      expect(await run(["kiro", "profile", "reset", "--apply"], { ...io, kiroProfiles: ops })).toBe(0);
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
      expect(await run(["kiro", "profile", "reset"], { ...io, kiroProfiles: ops })).toBe(0);
      expect(await run(["kiro", "profile", "reset", "--apply"], { ...io, kiroProfiles: ops })).toBe(0);
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
