import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CatalogPaths } from "../src/catalog.js";
import { type Runner, run } from "../src/cli.js";
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

  it("adds and removes an omp agent from task.disabledAgents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-cli-"));
    const config = join(dir, "config.yml");
    writeFileSync(config, "modelRoles:\n  default: grok/grok-4.7\n");
    const off = capture();
    expect(await run(["agents", "disable", "omp", "scout", "--apply"], { ...off, ompConfig: config })).toBe(0);
    expect(readFileSync(config, "utf8")).toContain("disabledAgents:\n    - scout");
    expect(readFileSync(config, "utf8")).toContain("modelRoles:");
    const on = capture();
    expect(await run(["agents", "enable", "omp", "scout", "--apply"], { ...on, ompConfig: config })).toBe(0);
    expect(readFileSync(config, "utf8")).not.toContain("disabledAgents");
    expect(readFileSync(config, "utf8")).toContain("modelRoles:");
  });

  it("refuses agent toggles for hosts without a list", async () => {
    const io = capture();
    expect(await run(["agents", "disable", "pi", "scout"], io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("only omp");
  });
});
