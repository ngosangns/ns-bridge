import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CatalogGroup, CatalogPaths, CatalogReport } from "../src/catalog.js";
import { type Runner, run } from "../src/cli.js";
import {
  applyZcodeProviders,
  backupProviderConfig,
  launchAgentPlist,
  parseDefaultModel,
  parseVendorList,
  planZcodeProviders,
  supportsImage,
  ZCODE_LAUNCH_AGENT_LABEL,
  type ZcodePlan,
  zcodeModelWindow,
} from "../src/zcode.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, log: (line: string) => stdout.push(line), err: (line: string) => stderr.push(line) };
}

interface Route {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** Fakes spawn results for the commands a test names; anything else "succeeds". */
function fakeRunner(routes: Record<string, Route> = {}): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (argv) => {
    calls.push(argv);
    const joined = argv.join(" ");
    for (const [key, route] of Object.entries(routes)) {
      if (joined === key || joined.startsWith(`${key} `)) {
        return { code: route.code, stdout: route.stdout ?? "", stderr: route.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

const ZCODE_RUNNING: Record<string, Route> = { pgrep: { code: 0, stdout: "4242" } };
const ZCODE_NOT_RUNNING: Record<string, Route> = { pgrep: { code: 1 } };

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// --- fixtures ---

const KIRO_1M = {
  id: "claude-1m",
  contextWindow: 1_000_000,
  maxTokens: 64000,
  compaction: { thresholdTokens: 150000 },
  input: ["text", "image"],
};
const KIRO_200K = { id: "claude-200k", contextWindow: 200000, maxTokens: 8192 };
const DEVIN_MODEL = { id: "devin-main", contextWindow: 200000, maxTokens: 16000, input: ["text"] };
const GROK_MODEL = { id: "grok-4", contextWindow: 256000, maxTokens: 32000 };

function catalogPathsIn(dir: string): CatalogPaths {
  return { kiro: join(dir, "kiro.json"), devin: join(dir, "devin.json"), grok: join(dir, "grok.json") };
}

function seedCatalogs(dir: string, present: { kiro?: boolean; devin?: boolean; grok?: boolean } = {}): void {
  const { kiro = true, devin = true, grok = true } = present;
  if (kiro) {
    writeFileSync(
      join(dir, "kiro.json"),
      JSON.stringify({
        regions: {
          "us-east-1": { fetchedAt: 1, models: [KIRO_1M] },
          "eu-west-1": { fetchedAt: 1, models: [KIRO_1M, KIRO_200K] },
        },
      }),
    );
  }
  if (devin) writeFileSync(join(dir, "devin.json"), JSON.stringify({ fetchedAt: 1, models: [DEVIN_MODEL] }));
  if (grok) writeFileSync(join(dir, "grok.json"), JSON.stringify({ fetchedAt: 1, models: [GROK_MODEL] }));
}

interface CmdPaths {
  home: string;
  catalogs: string;
  providerConfig: string;
  serveConfig: string;
  selection: string;
  plist: string;
}

function cmdPaths(home: string, catalogs: string): CmdPaths {
  return {
    home,
    catalogs,
    providerConfig: join(home, "zcode", "v2", "provider_config.json"),
    serveConfig: join(home, "ns-bridge", "zcode.json"),
    selection: join(home, "ns-bridge", "providers.json"),
    plist: join(home, "Library", "LaunchAgents", `${ZCODE_LAUNCH_AGENT_LABEL}.plist`),
  };
}

interface RunOverrides {
  apply?: boolean;
  force?: boolean;
  noService?: boolean;
  vendors?: string;
  default?: string;
  platform?: NodeJS.Platform;
  routes?: Record<string, Route>;
  now?: Date;
  serveConfigPath?: string;
}

function zcodeRun(action: "setup" | "status" | "remove", paths: CmdPaths, overrides: RunOverrides = {}) {
  const io = capture();
  const { runner, calls } = fakeRunner(overrides.routes ?? ZCODE_NOT_RUNNING);
  const options = {
    ...io,
    runner,
    home: paths.home,
    platform: overrides.platform ?? ("darwin" as NodeJS.Platform),
    paths: catalogPathsIn(paths.catalogs),
    zcodeProviderConfigPath: paths.providerConfig,
    serveConfigPath: overrides.serveConfigPath ?? paths.serveConfig,
    selectionFilePath: paths.selection,
    ...(overrides.now ? { now: overrides.now.getTime() } : {}),
  };
  const argv = ["zcode", action];
  if (overrides.vendors !== undefined) argv.push("--vendors", overrides.vendors);
  if (overrides.default !== undefined) argv.push("--default", overrides.default);
  if (overrides.apply) argv.push("--apply");
  if (overrides.force) argv.push("--force");
  if (overrides.noService) argv.push("--no-service");
  return { io, calls, done: run(argv, options) };
}

function backupsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".bak-ns-bridge-"));
}

interface RuleLike {
  providerId: string;
  providerName?: string;
  config?: { access?: { apiKey?: string }; personalModelIds?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** The parts of ZCode's provider config the tests read back, plus whatever else the file holds. */
interface ZcodeFileLike {
  schemaVersion?: number;
  config: {
    providerOrder?: string[];
    providerConfigRules: { providerRules: RuleLike[] };
    modelConfigRules: { providerModelRules: RuleLike[]; manualProviderModelRules?: RuleLike[] };
    defaultModelSelection?: { providerId: string; modelId: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function asFile(json: unknown): ZcodeFileLike {
  return json as ZcodeFileLike;
}

function readJson<T = ZcodeFileLike>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function foreignConfig(): ZcodeFileLike {
  return {
    schemaVersion: 1,
    userFlags: { beta: true },
    config: {
      providerOrder: ["acme"],
      futureFeature: { on: true },
      providerConfigRules: {
        providerRules: [{ providerId: "acme", providerName: "Acme", config: { group: "standard-personal" } }],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: "acme", modelId: "acme-1", config: { properties: { contextWindow: 8000 } } },
        ],
        manualProviderModelRules: [{ providerId: "acme", modelId: "acme-2" }],
      },
      defaultModelSelection: { providerId: "acme", modelId: "acme-1" },
    },
  };
}

// --- window math ---

describe("zcodeModelWindow", () => {
  it("lands ZCode's compaction on the catalog threshold for a 1M model", () => {
    // threshold 150000 + 13000 + min(64000, 21000) = 184000
    expect(zcodeModelWindow({ id: "m", contextWindow: 1_000_000, thresholdTokens: 150000, maxTokens: 64000 })).toEqual({
      window: 184000,
      maxOutputTokens: 64000,
    });
  });

  it("caps a 200k model at its real window", () => {
    expect(zcodeModelWindow({ id: "m", contextWindow: 200000, maxTokens: 64000 })).toEqual({
      window: 200000,
      maxOutputTokens: 64000,
    });
    expect(zcodeModelWindow({ id: "m", contextWindow: 200000, thresholdTokens: 150000, maxTokens: 64000 })).toEqual({
      window: 184000,
      maxOutputTokens: 64000,
    });
  });

  it("falls back to ZCode's own reservation defaults when the catalog omits them", () => {
    expect(zcodeModelWindow({ id: "m", contextWindow: 200000 })).toEqual({
      window: 200000,
      maxOutputTokens: 32000,
    });
  });

  it("reads image support from the input modality list", () => {
    expect(supportsImage({ id: "m", input: ["text", "image"] })).toBe(true);
    expect(supportsImage({ id: "m", input: ["text"] })).toBe(false);
    expect(supportsImage({ id: "m" })).toBe(false);
  });
});

// --- plan ---

describe("planZcodeProviders", () => {
  const serve = { port: 47821, token: "tok" };

  function report(
    vendor: CatalogReport["vendor"],
    groups: CatalogGroup[],
    state: CatalogReport["state"] = "ready",
  ): CatalogReport {
    return { vendor, path: `/${vendor}.json`, state, groups };
  }

  it("builds a provider rule and model rules per ready catalog, deduplicating kiro regions", () => {
    const plan = planZcodeProviders(
      [
        report("kiro", [
          {
            label: "us-east-1",
            ids: ["claude-1m"],
            entries: [
              {
                id: "claude-1m",
                contextWindow: 1_000_000,
                maxTokens: 64000,
                thresholdTokens: 150000,
                input: ["text", "image"],
              },
            ],
          },
          {
            label: "eu-west-1",
            ids: ["claude-1m", "claude-200k"],
            entries: [
              {
                id: "claude-1m",
                contextWindow: 1_000_000,
                maxTokens: 64000,
                thresholdTokens: 150000,
                input: ["text", "image"],
              },
              { id: "claude-200k", contextWindow: 200000, maxTokens: 8192 },
            ],
          },
        ]),
      ],
      serve,
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.providers).toHaveLength(1);
    const provider = plan.providers[0];
    expect(provider.providerId).toBe("ns-bridge-kiro");
    expect(provider.providerName).toBe("ns-bridge Kiro");
    expect(provider.baseUrl).toBe("http://127.0.0.1:47821/kiro");
    expect(provider.apiKey).toBe("tok");
    expect(provider.modelIds).toEqual(["claude-1m", "claude-200k"]);
    expect(provider.modelRules).toEqual([
      {
        providerId: "ns-bridge-kiro",
        modelId: "claude-1m",
        config: {
          properties: { contextWindow: 184000, inputFormat: { supportsImage: true } },
          optionSpecs: { maxOutputTokens: { max: 64000 } },
        },
      },
      {
        providerId: "ns-bridge-kiro",
        modelId: "claude-200k",
        config: {
          properties: { contextWindow: 200000, inputFormat: { supportsImage: false } },
          optionSpecs: { maxOutputTokens: { max: 8192 } },
        },
      },
    ]);
  });

  it("skips catalogs that are missing, unreadable, or have no usable models", () => {
    const plan = planZcodeProviders(
      [
        report("kiro", [], "missing"),
        report("devin", [], "unreadable"),
        report("grok", [{ label: "grok", ids: [], entries: [] }]),
      ],
      serve,
    );
    expect(plan.providers).toEqual([]);
    expect(plan.skipped.map((skip) => skip.vendor)).toEqual(["kiro", "devin", "grok"]);
  });
});

// --- merge ---

type PlanVendor = "kiro" | "devin" | "grok";

function planFor(vendors: PlanVendor[]): ZcodePlan {
  return {
    providers: vendors.map((vendor) => ({
      vendor,
      providerId: `ns-bridge-${vendor}`,
      providerName: `ns-bridge ${vendor[0].toUpperCase()}${vendor.slice(1)}`,
      baseUrl: `http://127.0.0.1:47821/${vendor}`,
      apiKey: "tok",
      modelIds: ["m1"],
      modelRules: [
        {
          providerId: `ns-bridge-${vendor}`,
          modelId: "m1",
          config: {
            properties: { contextWindow: 184000, inputFormat: { supportsImage: true } },
            optionSpecs: { maxOutputTokens: { max: 64000 } },
          },
        },
      ],
      skippedModels: [],
    })),
    skipped: [],
  };
}

describe("applyZcodeProviders", () => {
  const plan = planFor(["kiro"]);

  it("creates the skeleton ZCode accepts when the file does not exist", () => {
    const { json, changed } = applyZcodeProviders(undefined, plan);
    expect(changed).toBe(true);
    const file = asFile(json);
    expect(file.schemaVersion).toBe(1);
    expect(Object.keys(file.config).sort()).toEqual(["modelConfigRules", "providerConfigRules"]);
    expect(file.config.providerConfigRules.providerRules).toHaveLength(1);
    expect(file.config.modelConfigRules.providerModelRules).toHaveLength(1);
    expect(file.config.modelConfigRules.manualProviderModelRules).toBeUndefined();
  });

  it("is idempotent: the second application changes nothing", () => {
    const first = applyZcodeProviders(foreignConfig(), plan);
    expect(first.changed).toBe(true);
    const second = applyZcodeProviders(first.json, plan);
    expect(second.changed).toBe(false);
    expect(JSON.stringify(second.json)).toBe(JSON.stringify(first.json));
  });

  it("preserves foreign providers, unknown keys, and defaultModelSelection", () => {
    const file = asFile(applyZcodeProviders(foreignConfig(), plan).json);
    expect(file.userFlags).toEqual({ beta: true });
    expect(file.config.futureFeature).toEqual({ on: true });
    const rules = file.config.providerConfigRules.providerRules;
    expect(rules.map((rule) => rule.providerId)).toEqual(["acme", "ns-bridge-kiro"]);
    expect(rules[0]).toEqual(foreignConfig().config.providerConfigRules.providerRules[0]);
    const modelRules = file.config.modelConfigRules.providerModelRules;
    expect(modelRules.map((rule) => rule.providerId)).toEqual(["acme", "ns-bridge-kiro"]);
    expect(file.config.modelConfigRules.manualProviderModelRules).toEqual([{ providerId: "acme", modelId: "acme-2" }]);
    expect(file.config.providerOrder).toEqual(["acme", "ns-bridge-kiro"]);
    expect(file.config.defaultModelSelection).toEqual({ providerId: "acme", modelId: "acme-1" });
  });

  it("strips stale ns-bridge-* rules before appending", () => {
    const existing = foreignConfig();
    existing.config.providerConfigRules.providerRules.push({
      providerId: "ns-bridge-old",
      providerName: "ns-bridge Old",
      config: {},
    });
    const file = asFile(applyZcodeProviders(existing, plan).json);
    expect(file.config.providerConfigRules.providerRules.map((rule) => rule.providerId)).toEqual([
      "acme",
      "ns-bridge-kiro",
    ]);
  });

  it("keeps keepProviderIds entries in place when their vendor is skipped", () => {
    const registered = applyZcodeProviders(foreignConfig(), planFor(["kiro", "devin"])).json;
    const file = asFile(registered);
    file.config.modelConfigRules.manualProviderModelRules = [
      ...(file.config.modelConfigRules.manualProviderModelRules ?? []),
      { providerId: "ns-bridge-devin", modelId: "pinned" },
    ];
    const merged = applyZcodeProviders(registered, planFor(["kiro"]), {
      keepProviderIds: ["ns-bridge-devin"],
    });
    expect(merged.changed).toBe(false);
    const after = asFile(merged.json);
    expect(after.config.providerConfigRules.providerRules.map((rule) => rule.providerId)).toEqual([
      "acme",
      "ns-bridge-kiro",
      "ns-bridge-devin",
    ]);
    expect(after.config.modelConfigRules.manualProviderModelRules).toEqual([
      { providerId: "acme", modelId: "acme-2" },
      { providerId: "ns-bridge-devin", modelId: "pinned" },
    ]);
    expect(after.config.providerOrder).toEqual(["acme", "ns-bridge-kiro", "ns-bridge-devin"]);
  });

  it("still strips vendors that are neither re-registered nor kept", () => {
    const registered = applyZcodeProviders(foreignConfig(), planFor(["kiro", "devin", "grok"])).json;
    const merged = applyZcodeProviders(registered, planFor(["devin"]), { keepProviderIds: ["ns-bridge-kiro"] });
    const after = asFile(merged.json);
    expect(after.config.providerConfigRules.providerRules.map((rule) => rule.providerId)).toEqual([
      "acme",
      "ns-bridge-kiro",
      "ns-bridge-devin",
    ]);
    expect(after.config.modelConfigRules.providerModelRules.map((rule) => rule.providerId)).toEqual([
      "acme",
      "ns-bridge-kiro",
      "ns-bridge-devin",
    ]);
    expect(after.config.providerOrder).toEqual(["acme", "ns-bridge-kiro", "ns-bridge-devin"]);
  });

  it("removes our entries with an empty plan and keeps foreign ones", () => {
    const merged = applyZcodeProviders(foreignConfig(), plan).json;
    const removed = applyZcodeProviders(merged, { providers: [], skipped: [] });
    expect(removed.changed).toBe(true);
    const file = asFile(removed.json);
    expect(file.config.providerConfigRules.providerRules.map((rule) => rule.providerId)).toEqual(["acme"]);
    expect(file.config.modelConfigRules.providerModelRules.map((rule) => rule.providerId)).toEqual(["acme"]);
    expect(file.config.providerOrder).toEqual(["acme"]);
  });

  it("leaves a file alone when an empty plan has nothing to remove", () => {
    const existing = foreignConfig();
    const { json, changed } = applyZcodeProviders(existing, { providers: [], skipped: [] });
    expect(changed).toBe(false);
    expect(JSON.stringify(json)).toBe(JSON.stringify(existing));
  });

  it("sets defaultModelSelection only when asked", () => {
    const withDefault = applyZcodeProviders(foreignConfig(), plan, {
      defaultModel: { providerId: "ns-bridge-kiro", modelId: "m1" },
    });
    expect(asFile(withDefault.json).config.defaultModelSelection).toEqual({
      providerId: "ns-bridge-kiro",
      modelId: "m1",
    });
  });

  it("refuses a file whose shape it does not recognize", () => {
    expect(() => applyZcodeProviders([1, 2], plan)).toThrow(/not a JSON object/);
    expect(() => applyZcodeProviders({ config: { providerConfigRules: { providerRules: {} } } }, plan)).toThrow(
      /not an array/,
    );
  });
});

// --- backups ---

describe("backupProviderConfig", () => {
  it("never overwrites: a taken stamp gets -1, -2, ... appended", () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-bridge-zcode-bak-"));
    tempDirs.push(dir);
    const source = join(dir, "provider_config.json");
    writeFileSync(source, "v1");
    const now = new Date(2026, 0, 2, 3, 4, 5);

    const first = backupProviderConfig(source, now);
    expect(first).toBe(join(dir, "provider_config.json.bak-ns-bridge-20260102-030405"));
    const second = backupProviderConfig(source, now);
    expect(second).toBe(`${first}-1`);
    writeFileSync(source, "v2");
    const third = backupProviderConfig(source, now);
    expect(third).toBe(`${first}-2`);

    expect(readFileSync(first, "utf8")).toBe("v1");
    expect(readFileSync(second, "utf8")).toBe("v1");
    expect(readFileSync(third, "utf8")).toBe("v2");
    expect(statSync(third).mode & 0o777).toBe(0o600);
  });
});

// --- argument parsing helpers ---

describe("zcode argument parsing", () => {
  it("parses vendor lists and defaults", () => {
    expect(parseVendorList("kiro, devin")).toEqual(["kiro", "devin"]);
    expect(parseVendorList("kiro kiros")).toEqual({ error: "unknown vendor kiros (expected kiro, devin, or grok)" });
    expect(parseVendorList(",")).toEqual({ error: "--vendors needs at least one of kiro, devin, grok" });
    expect(parseDefaultModel("kiro/claude-1m")).toEqual({ vendor: "kiro", modelId: "claude-1m" });
    expect(parseDefaultModel("nope")).toEqual({ error: "--default needs <vendor>/<model> (got nope)" });
    expect(parseDefaultModel("acme/m")).toEqual({
      error: "--default: unknown vendor acme (expected kiro, devin, or grok)",
    });
  });
});

// --- the command ---

describe("ns-bridge zcode setup", () => {
  function fresh(present?: { kiro?: boolean; devin?: boolean; grok?: boolean }): CmdPaths {
    const home = tempHome();
    const catalogs = join(home, "catalogs");
    mkdirSync(catalogs);
    seedCatalogs(catalogs, present);
    return cmdPaths(home, catalogs);
  }

  it("previews and writes nothing", async () => {
    const paths = fresh();
    const { io, calls, done } = zcodeRun("setup", paths);
    expect(await done).toBe(0);
    expect(io.stdout[0]).toBe("# dry-run (pass --apply to run)");
    expect(io.stdout.join("\n")).toContain("register ns-bridge-kiro  2 model(s)  http://127.0.0.1:47821/kiro");
    expect(io.stdout.join("\n")).toContain(`write ${paths.providerConfig}  (new file)`);
    expect(io.stdout.join("\n")).toContain(`write ${paths.plist}`);
    expect(io.stdout.join("\n")).toContain("launchctl bootstrap");
    expect(calls).toEqual([]);
    expect(existsSync(paths.providerConfig)).toBe(false);
    expect(existsSync(paths.serveConfig)).toBe(false);
    expect(existsSync(paths.plist)).toBe(false);
  });

  it("applies: provider config, serve config, plist, and launchctl calls", async () => {
    const paths = fresh();
    const { io, calls, done } = zcodeRun("setup", paths, { apply: true, now: new Date(2026, 0, 2, 3, 4, 5) });
    expect(await done).toBe(0);

    const json = readJson(paths.providerConfig);
    expect(json.config.providerConfigRules.providerRules.map((rule) => rule.providerId)).toEqual([
      "ns-bridge-kiro",
      "ns-bridge-devin",
      "ns-bridge-grok",
    ]);
    expect(statSync(paths.providerConfig).mode & 0o777).toBe(0o600);
    expect(io.stdout.join("\n")).toContain(`wrote ${paths.providerConfig}`);
    expect(backupsIn(join(paths.home, "zcode", "v2"))).toHaveLength(0);

    const serve = readJson(paths.serveConfig);
    expect(serve.port).toBe(47821);
    expect(serve.token).toMatch(/^[0-9a-f]{48}$/);
    // The token lands in the provider config, never in the output.
    expect([...io.stdout, ...io.stderr].join("\n")).not.toContain(serve.token);
    expect(readJson(paths.providerConfig).config.providerConfigRules.providerRules[0].config?.access?.apiKey).toBe(
      serve.token,
    );

    const plist = readFileSync(paths.plist, "utf8");
    expect(plist).toContain(`<string>${ZCODE_LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>PATH</key>");
    // The temp serve config is off the default ~/.ns-bridge path, so the agent is told where it is.
    expect(plist).toContain(`<key>NS_BRIDGE_ZCODE_CONFIG</key>\n        <string>${paths.serveConfig}</string>`);
    expect(statSync(join(paths.home, ".ns-bridge", "logs")).isDirectory()).toBe(true);
    const consoleUid = process.getuid?.() ?? 0;
    expect(calls).toEqual([
      ["pgrep", "-x", "ZCode"],
      ["launchctl", "bootout", `gui/${consoleUid}/${ZCODE_LAUNCH_AGENT_LABEL}`],
      ["launchctl", "bootstrap", `gui/${consoleUid}`, paths.plist],
    ]);
    expect(io.stdout.join("\n")).toContain("restart ZCode");
  });

  it("names a custom serve config path in the plist env, never the token", async () => {
    const home = tempHome();
    const catalogs = join(home, "catalogs");
    mkdirSync(catalogs);
    seedCatalogs(catalogs);
    const paths = cmdPaths(home, catalogs);
    const customServe = join(home, "elsewhere", "zcode.json");
    const { done } = zcodeRun("setup", paths, { apply: true, serveConfigPath: customServe });
    expect(await done).toBe(0);
    const plist = readFileSync(paths.plist, "utf8");
    expect(plist).toContain(`<key>NS_BRIDGE_ZCODE_CONFIG</key>\n        <string>${customServe}</string>`);
    expect(existsSync(customServe)).toBe(true);
    expect(plist).not.toContain(readJson<{ token: string }>(customServe).token);
  });

  it("leaves the plist env at PATH when the serve config is at its default path", async () => {
    const home = tempHome();
    const catalogs = join(home, "catalogs");
    mkdirSync(catalogs);
    seedCatalogs(catalogs);
    const paths = cmdPaths(home, catalogs);
    const { done } = zcodeRun("setup", paths, {
      apply: true,
      serveConfigPath: join(home, ".ns-bridge", "zcode.json"),
    });
    expect(await done).toBe(0);
    expect(readFileSync(paths.plist, "utf8")).not.toContain("NS_BRIDGE_ZCODE_CONFIG");
  });

  it("backs up an existing file before writing, with 0600 modes", async () => {
    const paths = fresh();
    mkdirSync(join(paths.home, "zcode", "v2"), { recursive: true });
    const original = JSON.stringify(foreignConfig(), null, 2);
    writeFileSync(paths.providerConfig, original);
    const { io, done } = zcodeRun("setup", paths, { apply: true, now: new Date(2026, 0, 2, 3, 4, 5) });
    expect(await done).toBe(0);
    const backups = backupsIn(join(paths.home, "zcode", "v2"));
    expect(backups).toEqual(["provider_config.json.bak-ns-bridge-20260102-030405"]);
    const backupPath = join(paths.home, "zcode", "v2", backups[0]);
    expect(readFileSync(backupPath, "utf8")).toBe(original);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.providerConfig).mode & 0o777).toBe(0o600);
    expect(io.stdout.join("\n")).toContain(`backup ${backupPath}`);
  });

  it("is idempotent: a second apply makes no second backup and changes nothing", async () => {
    const paths = fresh();
    mkdirSync(join(paths.home, "zcode", "v2"), { recursive: true });
    writeFileSync(paths.providerConfig, JSON.stringify(foreignConfig(), null, 2));
    expect(await zcodeRun("setup", paths, { apply: true }).done).toBe(0);
    const before = readFileSync(paths.providerConfig, "utf8");
    const { io, done } = zcodeRun("setup", paths, { apply: true });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("already up to date");
    expect(backupsIn(join(paths.home, "zcode", "v2"))).toHaveLength(1);
    expect(readFileSync(paths.providerConfig, "utf8")).toBe(before);
  });

  it("reports already up to date when the file matches", async () => {
    const paths = fresh();
    await zcodeRun("setup", paths, { apply: true });
    const { io, done } = zcodeRun("setup", paths, { apply: true });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("already up to date");
    expect(io.stdout.join("\n")).not.toContain("backup ");
  });

  it("refuses --apply while ZCode runs, unless --force", async () => {
    const paths = fresh();
    const refused = zcodeRun("setup", paths, { apply: true, routes: ZCODE_RUNNING });
    expect(await refused.done).toBe(1);
    expect(refused.io.stderr.join("\n")).toContain("ZCode is running");
    expect(refused.io.stderr.join("\n")).toContain("--force");
    expect(existsSync(paths.providerConfig)).toBe(false);
    expect(existsSync(paths.serveConfig)).toBe(false);

    const forced = zcodeRun("setup", paths, { apply: true, force: true, routes: ZCODE_RUNNING });
    expect(await forced.done).toBe(0);
    expect(existsSync(paths.providerConfig)).toBe(true);
  });

  it("never runs the pgrep check on a preview", async () => {
    const paths = fresh();
    const { calls, done } = zcodeRun("setup", paths, { routes: ZCODE_RUNNING });
    expect(await done).toBe(0);
    expect(calls).toEqual([]);
  });

  it("validates --default against the planned models", async () => {
    const paths = fresh();
    const bad = zcodeRun("setup", paths, { apply: true, default: "kiro/nope" });
    expect(await bad.done).toBe(1);
    expect(bad.io.stderr.join("\n")).toContain("not in the ns-bridge-kiro model list");
    expect(existsSync(paths.providerConfig)).toBe(false);

    const wrongVendor = zcodeRun("setup", paths, { apply: true, default: "acme/m" });
    expect(await wrongVendor.done).toBe(1);
    expect(wrongVendor.io.stderr.join("\n")).toContain("unknown vendor acme");

    const good = zcodeRun("setup", paths, { apply: true, default: "kiro/claude-1m" });
    expect(await good.done).toBe(0);
    expect(readJson(paths.providerConfig).config.defaultModelSelection).toEqual({
      providerId: "ns-bridge-kiro",
      modelId: "claude-1m",
    });
  });

  it("respects the provider selection file and narrows with --vendors", async () => {
    const paths = fresh();
    mkdirSync(join(paths.home, "ns-bridge"), { recursive: true });
    writeFileSync(paths.selection, JSON.stringify({ kiro: false }));

    const withoutKiro = zcodeRun("setup", paths, { apply: true });
    expect(await withoutKiro.done).toBe(0);
    expect(
      readJson(paths.providerConfig).config.providerConfigRules.providerRules.map((rule) => rule.providerId),
    ).toEqual(["ns-bridge-devin", "ns-bridge-grok"]);

    const narrowed = zcodeRun("setup", paths, { apply: true, vendors: "devin" });
    expect(await narrowed.done).toBe(0);
    expect(
      readJson(paths.providerConfig).config.providerConfigRules.providerRules.map((rule) => rule.providerId),
    ).toEqual(["ns-bridge-devin"]);

    const empty = zcodeRun("setup", paths, { vendors: "kiro" });
    expect(await empty.done).toBe(1);
    expect(empty.io.stderr.join("\n")).toContain("no vendors to register");
  });

  it("skips vendors whose catalog is missing and says so", async () => {
    const paths = fresh({ kiro: true, devin: true, grok: false });
    const { io, done } = zcodeRun("setup", paths, { apply: true });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("# skipped grok: no catalog (missing)");
    const ids = readJson(paths.providerConfig).config.providerConfigRules.providerRules.map((rule) => rule.providerId);
    expect(ids).toEqual(["ns-bridge-kiro", "ns-bridge-devin"]);
  });

  it("keeps a registered provider whose catalog goes missing, untouched", async () => {
    const paths = fresh();
    const now = new Date(2026, 0, 2, 3, 4, 5);
    expect(await zcodeRun("setup", paths, { apply: true, now }).done).toBe(0);
    const before = readJson(paths.providerConfig);
    rmSync(join(paths.catalogs, "grok.json"));

    const { io, done } = zcodeRun("setup", paths, { apply: true, now });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("# skipped grok: no catalog (missing)");
    expect(io.stdout.join("\n")).toContain("already up to date");
    expect(readJson(paths.providerConfig)).toEqual(before);
    expect(backupsIn(join(paths.home, "zcode", "v2"))).toHaveLength(0);
  });

  it("keeps a skipped vendor's provider while refreshing the others", async () => {
    const paths = fresh();
    const now = new Date(2026, 0, 2, 3, 4, 5);
    expect(await zcodeRun("setup", paths, { apply: true, now }).done).toBe(0);
    rmSync(join(paths.catalogs, "grok.json"));
    writeFileSync(
      join(paths.catalogs, "devin.json"),
      JSON.stringify({
        fetchedAt: 2,
        models: [DEVIN_MODEL, { id: "devin-new", contextWindow: 100000, maxTokens: 8000 }],
      }),
    );

    const { io, done } = zcodeRun("setup", paths, { apply: true, now });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("wrote ");
    const rules = readJson(paths.providerConfig).config.providerConfigRules.providerRules;
    expect(rules.map((rule) => rule.providerId)).toEqual(["ns-bridge-kiro", "ns-bridge-devin", "ns-bridge-grok"]);
    const grok = rules.find((rule) => rule.providerId === "ns-bridge-grok");
    expect(grok?.config?.access?.apiKey).toBe(readJson<{ token: string }>(paths.serveConfig).token);
    expect(grok?.config?.personalModelIds).toEqual(["grok-4"]);
    const devin = rules.find((rule) => rule.providerId === "ns-bridge-devin");
    expect(devin?.config?.personalModelIds).toEqual(["devin-main", "devin-new"]);
    expect(backupsIn(join(paths.home, "zcode", "v2"))).toHaveLength(1);
  });

  it("skips the service with --no-service or off darwin", async () => {
    const withoutService = fresh();
    const noService = zcodeRun("setup", withoutService, { apply: true, noService: true });
    expect(await noService.done).toBe(0);
    expect(noService.calls).toEqual([["pgrep", "-x", "ZCode"]]);
    expect(noService.io.stdout.join("\n")).toContain("ns-bridge serve");

    const onLinux = fresh();
    const linux = zcodeRun("setup", onLinux, { apply: true, platform: "linux" });
    expect(await linux.done).toBe(0);
    expect(linux.calls).toEqual([["pgrep", "-x", "ZCode"]]);
    expect(existsSync(onLinux.plist)).toBe(false);
  });

  it("preserves a foreign file exactly except for our entries", async () => {
    const paths = fresh();
    mkdirSync(join(paths.home, "zcode", "v2"), { recursive: true });
    const original = foreignConfig();
    writeFileSync(paths.providerConfig, JSON.stringify(original, null, 2));
    const { done } = zcodeRun("setup", paths, { apply: true });
    expect(await done).toBe(0);
    const json = readJson(paths.providerConfig);
    expect(json.userFlags).toEqual(original.userFlags);
    expect(json.config.futureFeature).toEqual(original.config.futureFeature);
    expect(json.config.defaultModelSelection).toEqual(original.config.defaultModelSelection);
    expect(json.config.providerConfigRules.providerRules[0].providerId).toBe("acme");
  });

  it("refuses to overwrite an unreadable provider config", async () => {
    const paths = fresh();
    mkdirSync(join(paths.home, "zcode", "v2"), { recursive: true });
    writeFileSync(paths.providerConfig, "{");
    const { io, done } = zcodeRun("setup", paths, { apply: true });
    expect(await done).toBe(1);
    expect(io.stderr.join("\n")).toContain("cannot read");
    expect(readFileSync(paths.providerConfig, "utf8")).toBe("{");
  });
});

describe("ns-bridge zcode remove", () => {
  function seeded(): CmdPaths {
    const paths = freshSetup();
    mkdirSync(join(paths.home, "zcode", "v2"), { recursive: true });
    mkdirSync(join(paths.home, "ns-bridge"), { recursive: true });
    mkdirSync(join(paths.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(paths.providerConfig, JSON.stringify(foreignConfig(), null, 2));
    writeFileSync(
      paths.plist,
      launchAgentPlist({
        programArguments: ["/usr/bin/node", "main.js", "serve"],
        logPath: "/tmp/l",
        envPath: "/usr/bin",
      }),
    );
    writeFileSync(paths.serveConfig, JSON.stringify({ port: 47821, token: "t".repeat(48) }), { mode: 0o600 });
    return paths;
  }

  function freshSetup(): CmdPaths {
    const home = tempHome();
    const catalogs = join(home, "catalogs");
    mkdirSync(catalogs);
    return cmdPaths(home, catalogs);
  }

  function mergedWithOurs(paths: CmdPaths): void {
    const existing = readJson(paths.providerConfig);
    const merged = applyZcodeProviders(existing, planFor(["kiro", "devin"]));
    const file = asFile(merged.json);
    file.config.defaultModelSelection = { providerId: "ns-bridge-kiro", modelId: "m1" };
    writeFileSync(paths.providerConfig, JSON.stringify(file, null, 2));
  }

  it("previews and writes nothing", async () => {
    const paths = seeded();
    mergedWithOurs(paths);
    const before = readFileSync(paths.providerConfig, "utf8");
    const { io, done } = zcodeRun("remove", paths);
    expect(await done).toBe(0);
    expect(io.stdout[0]).toBe("# dry-run (pass --apply to run)");
    expect(io.stdout.join("\n")).toContain("remove ns-bridge-kiro  1 model(s)");
    expect(io.stdout.join("\n")).toContain(`remove ${paths.plist}`);
    expect(io.stdout.join("\n")).toContain(`${paths.serveConfig} stays`);
    expect(readFileSync(paths.providerConfig, "utf8")).toBe(before);
    expect(existsSync(paths.plist)).toBe(true);
  });

  it("strips our entries, keeps foreign ones, and removes the agent", async () => {
    const paths = seeded();
    mergedWithOurs(paths);
    const before = readJson(paths.providerConfig);
    const { io, calls, done } = zcodeRun("remove", paths, { apply: true });
    expect(await done).toBe(0);

    const json = readJson(paths.providerConfig);
    expect(json.config.providerConfigRules.providerRules.map((rule) => rule.providerId)).toEqual(["acme"]);
    expect(json.config.modelConfigRules.providerModelRules.map((rule) => rule.providerId)).toEqual(["acme"]);
    expect(json.config.defaultModelSelection).toEqual(before.config.defaultModelSelection);
    expect(backupsIn(join(paths.home, "zcode", "v2"))).toHaveLength(1);
    expect(existsSync(paths.plist)).toBe(false);
    expect(existsSync(paths.serveConfig)).toBe(true);
    expect(calls.some((argv) => argv[0] === "launchctl" && argv[1] === "bootout")).toBe(true);
    expect(io.stderr.join("\n")).toContain("defaultModelSelection");
  });

  it("reports nothing to do when no ns-bridge providers are registered", async () => {
    const paths = seeded();
    const { io, done } = zcodeRun("remove", paths, { apply: true });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("has no ns-bridge providers");
    expect(backupsIn(join(paths.home, "zcode", "v2"))).toHaveLength(0);
    expect(existsSync(paths.plist)).toBe(false);
  });

  it("refuses --apply while ZCode runs", async () => {
    const paths = seeded();
    mergedWithOurs(paths);
    const { io, done } = zcodeRun("remove", paths, { apply: true, routes: ZCODE_RUNNING });
    expect(await done).toBe(1);
    expect(io.stderr.join("\n")).toContain("ZCode is running");
    expect(existsSync(paths.plist)).toBe(true);
  });

  it("says nothing to remove when the file does not exist", async () => {
    const paths = freshSetup();
    const { io, done } = zcodeRun("remove", paths, { apply: true });
    expect(await done).toBe(0);
    expect(io.stdout.join("\n")).toContain("nothing to remove");
  });
});

describe("ns-bridge zcode status", () => {
  function fresh(): CmdPaths {
    const home = tempHome();
    return cmdPaths(home, home);
  }

  it("reports what is registered, the serve config, the server, and the agent", async () => {
    const paths = fresh();
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      mkdirSync(join(paths.home, "zcode", "v2"), { recursive: true });
      mkdirSync(join(paths.home, "ns-bridge"), { recursive: true });
      writeFileSync(
        paths.providerConfig,
        JSON.stringify(applyZcodeProviders(foreignConfig(), planFor(["devin"])).json),
      );
      writeFileSync(paths.serveConfig, JSON.stringify({ port, token: "s".repeat(48) }), { mode: 0o600 });
      const { io, done } = zcodeRun("status", paths);
      expect(await done).toBe(0);
      const out = io.stdout.join("\n");
      expect(out).toContain(`provider config  ${paths.providerConfig}  ready`);
      expect(out).toContain("ns-bridge-kiro  absent");
      expect(out).toContain("ns-bridge-devin  present, 1 model(s)");
      expect(out).toContain("ns-bridge-grok  absent");
      expect(out).toContain(`serve config  ${paths.serveConfig}  present, port ${port}`);
      expect(out).toContain(`server  http://127.0.0.1:${port}/healthz  ok`);
      expect(out).toContain(`launch agent  ${ZCODE_LAUNCH_AGENT_LABEL}  not installed`);
      expect(out).not.toContain("s".repeat(48));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports missing pieces and an unreachable server", async () => {
    const paths = fresh();
    const { io, done } = zcodeRun("status", paths, { platform: "linux" });
    expect(await done).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain(`provider config  ${paths.providerConfig}  missing`);
    expect(out).toContain(`serve config  ${paths.serveConfig}  missing`);
    expect(out).toContain("unreachable");
    expect(out).not.toContain("launch agent");
  });
});

describe("launchAgentPlist", () => {
  it("renders the keys launchd needs", () => {
    const plist = launchAgentPlist({
      label: "test.label",
      programArguments: ["/usr/bin/node", "/opt/ns-bridge/main.js", "serve"],
      logPath: "/Users/x/.ns-bridge/logs/serve.log",
      envPath: "/usr/local/bin:/usr/bin",
    });
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain("<key>Label</key>\n    <string>test.label</string>");
    expect(plist).toContain("<string>/opt/ns-bridge/main.js</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<key>StandardOutPath</key>\n    <string>/Users/x/.ns-bridge/logs/serve.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("<key>PATH</key>\n        <string>/usr/local/bin:/usr/bin</string>");
  });

  it("escapes XML in paths", () => {
    const plist = launchAgentPlist({ programArguments: ["/a&b/c"], logPath: "/l<x>", envPath: "/p>q" });
    expect(plist).toContain("<string>/a&amp;b/c</string>");
    expect(plist).toContain("<string>/l&lt;x&gt;</string>");
    expect(plist).toContain("<string>/p&gt;q</string>");
  });

  it("adds extraEnv entries after PATH, XML-escaped", () => {
    const plist = launchAgentPlist({
      programArguments: ["/usr/bin/node", "main.js", "serve"],
      logPath: "/l",
      envPath: "/usr/bin",
      extraEnv: { NS_BRIDGE_ZCODE_CONFIG: "/tmp/a&b/zcode.json" },
    });
    expect(plist).toContain("<key>NS_BRIDGE_ZCODE_CONFIG</key>\n        <string>/tmp/a&amp;b/zcode.json</string>");
    expect(plist.indexOf("<key>PATH</key>")).toBeLessThan(plist.indexOf("<key>NS_BRIDGE_ZCODE_CONFIG</key>"));
  });

  it("writes only PATH when there is no extraEnv", () => {
    const plist = launchAgentPlist({ programArguments: ["/n"], logPath: "/l", envPath: "/p" });
    expect(plist).not.toContain("NS_BRIDGE_ZCODE_CONFIG");
  });
});

describe("ns-bridge help", () => {
  it("documents the zcode commands", async () => {
    const io = capture();
    expect(await run(["help"], io)).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain("ns-bridge zcode setup");
    expect(out).toContain("ns-bridge zcode status");
    expect(out).toContain("ns-bridge zcode remove");
    expect(out).toContain("--no-service");
  });

  it("rejects unknown zcode actions and extra arguments", async () => {
    for (const argv of [
      ["zcode"],
      ["zcode", "other"],
      ["zcode", "setup", "extra"],
      ["zcode", "setup", "--vendors", "nope"],
    ]) {
      const io = capture();
      expect(await run(argv, io)).toBe(1);
    }
  });
});
