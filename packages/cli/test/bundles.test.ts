import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/selection.js";

/**
 * Loads the bundles `ns-bridge install` registers, outside a real host.
 *
 * Each host serves its own modules in-process (`@earendil-works/*` for Pi,
 * `@oh-my-pi/*` for OMP, `@deepseek-ai/*` peers for DSH), so the test copies
 * every bundle into a temp `node_modules` and writes a Proxy-backed stub for
 * each bare import it makes. That is enough to run the registration paths: the
 * extensions only call into the host API and their own bundled cores.
 */

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostsRoot = join(cliRoot, "dist", "hosts");
const HOST_DIRS = ["pi", "omp", ...PROVIDERS.map((provider) => join("dsh", provider))];

const SAFE_COMMON = [/^@smithy\//, /^js-tiktoken(\/.*)?$/];
const ALLOWED: Record<string, RegExp[]> = {
  pi: [/^@earendil-works\//, ...SAFE_COMMON],
  omp: [/^@oh-my-pi\//, ...SAFE_COMMON],
  dsh: [/^@deepseek-ai\/(cordis|dsh-attachment|dsh-credentials|dsh-llm)(\/.*)?$/, ...SAFE_COMMON],
};

let sandbox: string;
const savedEnv: Record<string, string | undefined> = {};

function bundleSource(dir: string): string {
  return readFileSync(join(hostsRoot, dir, "dist", "index.js"), "utf8");
}

function manifestOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(hostsRoot, dir, "package.json"), "utf8"));
}

function hostOf(dir: string): string {
  return dir.split("/")[0] ?? dir;
}

/** `import { a, b as c } from "x"` → x → {a, b}. Default and node: imports are skipped. */
function importsOf(source: string): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const specifier = match[2] ?? "";
    if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
    const names = imports.get(specifier) ?? new Set<string>();
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.add(name);
    }
    imports.set(specifier, names);
  }
  return imports;
}

const STUB = `const make = () => new Proxy(function () {}, {
  get(target, key) {
    if (key === "then") return undefined;
    if (!(key in target)) target[key] = make();
    return target[key];
  },
  apply() {
    return make();
  },
});
`;

function stubSource(names: Iterable<string>): string {
  return `${STUB}${[...names].map((name) => `export const ${name} = make();`).join("\n")}\nexport default make();\n`;
}

/** Writes a stub for every external import, keyed by package so subpaths work. */
function writeStubs(imports: Map<string, Set<string>>): void {
  const packages = new Map<string, { names: Set<string>; subpaths: Map<string, Set<string>> }>();
  for (const [specifier, names] of imports) {
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
    const sub = specifier.slice(name.length);
    const entry = packages.get(name) ?? { names: new Set<string>(), subpaths: new Map<string, Set<string>>() };
    const target = sub === "" ? entry.names : entry.subpaths.get(sub);
    if (sub === "") for (const item of names) entry.names.add(item);
    else entry.subpaths.set(sub, new Set([...(target ?? []), ...names]));
    packages.set(name, entry);
  }
  for (const [name, entry] of packages) {
    const dir = join(sandbox, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    const exportsMap: Record<string, string> = { ".": "./index.js" };
    writeFileSync(join(dir, "index.js"), stubSource(entry.names));
    for (const [sub, names] of entry.subpaths) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, "index.js"), stubSource(names));
      exportsMap[`.${sub}`] = `./${sub.slice(1)}/index.js`;
    }
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name, version: "0.0.0", type: "module", exports: exportsMap }, null, 2)}\n`,
    );
  }
}

interface Loaded {
  module: Record<string, unknown>;
}

const loaded = new Map<string, Loaded>();

function load(dir: string): Record<string, unknown> {
  const entry = loaded.get(dir);
  if (!entry) throw new Error(`${dir} was not loaded`);
  return entry.module;
}

beforeAll(async () => {
  for (const dir of HOST_DIRS) {
    if (!existsSync(join(hostsRoot, dir, "dist", "index.js"))) {
      execFileSync("pnpm", ["run", "build"], { cwd: cliRoot, stdio: "ignore" });
      break;
    }
  }
  sandbox = mkdtempSync(join(tmpdir(), "ns-bridge-bundles-"));
  const imports = new Map<string, Set<string>>();
  for (const dir of HOST_DIRS) {
    const source = bundleSource(dir);
    for (const [specifier, names] of importsOf(source)) {
      const merged = imports.get(specifier) ?? new Set<string>();
      for (const name of names) merged.add(name);
      imports.set(specifier, merged);
    }
  }
  writeStubs(imports);
  for (const dir of HOST_DIRS) {
    const manifest = manifestOf(dir) as { name: string };
    const target = join(sandbox, "node_modules", manifest.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(hostsRoot, dir), target, { recursive: true });
  }
  for (const key of ["NS_BRIDGE_PROVIDERS", "NS_BRIDGE_USAGE", "HOME"]) savedEnv[key] = process.env[key];
  process.env.NS_BRIDGE_PROVIDERS = PROVIDERS.join(",");
  process.env.NS_BRIDGE_USAGE = "0";
  // The hosts read their catalogs from the cache under HOME. This fixture is
  // what `ns-bridge models refresh qoder` writes after a real Qoder refresh:
  // an effort ladder and a compaction budget, which the bootstrap ids lack.
  const home = join(sandbox, "home");
  const cacheDir = join(home, ".pi", "agent", "cache", "ns-pi-provider");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "qoder.models.json"),
    JSON.stringify({
      version: "1",
      fetchedAt: Date.now(),
      models: [
        {
          id: "qoder-pro",
          name: "Qoder Pro",
          api: "qoder-cli",
          provider: "qoder",
          baseUrl: "qoder-cli://local",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 64_000,
          compaction: { thresholdTokens: 150_000 },
          efforts: ["low", "medium", "high"],
        },
      ],
    }),
  );
  process.env.HOME = home;
  for (const dir of HOST_DIRS) {
    const name = (manifestOf(dir) as { name: string }).name;
    const module = (await import(
      pathToFileURL(join(sandbox, "node_modules", name, "dist", "index.js")).href
    )) as Record<string, unknown>;
    loaded.set(dir, { module });
  }
}, 300_000);

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("generated manifests", () => {
  it("labels the Pi and OMP bundles the way their hosts discover extensions", () => {
    const cli = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string };
    const pi = manifestOf("pi") as { name: string; version: string; pi: { extensions: string[] } };
    expect(pi.name).toBe("@ngosangns/ns-pi-provider");
    expect(pi.version).toBe(cli.version);
    expect(pi.pi.extensions).toEqual(["./dist/index.js"]);

    const omp = manifestOf("omp") as { name: string; version: string; omp: { extensions: string[] } };
    expect(omp.name).toBe("ns-omp-provider");
    expect(omp.version).toBe(cli.version);
    expect(omp.omp.extensions).toEqual(["./dist/index.js"]);
  });

  it("keeps each DSH bundle's name, version, and peers from its source package", () => {
    for (const provider of PROVIDERS) {
      const source = JSON.parse(readFileSync(join(cliRoot, "..", `dsh-llm-${provider}`, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      const manifest = manifestOf(join("dsh", provider)) as {
        name: string;
        version: string;
        exports: Record<string, unknown>;
        peerDependencies: Record<string, string>;
      };
      expect(manifest.name).toBe(source.name);
      expect(manifest.version).toBe(source.version);
      expect(manifest.exports["."]).toEqual({ default: "./dist/index.js" });
      expect(Object.keys(manifest.peerDependencies)).toContain("@deepseek-ai/dsh-llm");
    }
  });
});

describe("bundle imports", () => {
  it("matches the modules each host already serves", () => {
    for (const dir of HOST_DIRS) {
      const allowed = ALLOWED[hostOf(dir)] ?? [];
      const externals = [...importsOf(bundleSource(dir)).keys()].filter((specifier) => !specifier.startsWith("node:"));
      expect(externals.length).toBeGreaterThan(0);
      for (const specifier of externals) {
        expect(
          allowed.some((pattern) => pattern.test(specifier)),
          `${dir} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("leaves no Pi module in the OMP bundle", () => {
    expect(bundleSource("omp")).not.toContain("@earendil-works/");
  });

  it("names the DSH loader id inside each bundle", () => {
    for (const provider of PROVIDERS) {
      expect(bundleSource(join("dsh", provider))).toContain(`"llm-${provider}"`);
    }
  });

  it("ships every bundle in the CLI tarball and nothing outside dist", () => {
    for (const dir of HOST_DIRS) {
      const files = readdirSync(join(hostsRoot, dir));
      expect(files.sort()).toEqual(["dist", "package.json", "vendor"]);
    }
  });
});

describe("Pi bundle", () => {
  it("registers qoder with an effort ladder and Pi's own context window", async () => {
    const registration = piApi();
    const plugin = load("pi") as { default: (pi: unknown) => Promise<void> };
    await plugin.default(registration.api);
    const qoder = registration.providers.get("qoder") as { models?: Array<Record<string, unknown>> } | undefined;
    const model = qoder?.models?.[0];
    expect(model?.id).toBe("qoder-pro");
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.thinkingLevelMap).toMatchObject({ medium: "medium", high: "high" });
    expect(model).toHaveProperty("efforts");
    expect(registration.commands).toContain("qoder");
  });
});

describe("OMP bundle", () => {
  it("registers qoder with OMP's effort and compaction window shapes", async () => {
    const registration = piApi();
    const plugin = load("omp") as { default: (pi: unknown) => Promise<void> };
    await plugin.default(registration.api);
    const qoder = registration.providers.get("qoder") as { models?: Array<Record<string, unknown>> } | undefined;
    const model = qoder?.models?.[0];
    expect(model?.id).toBe("qoder-pro");
    expect(model?.thinking).toMatchObject({ mode: "effort", efforts: ["low", "medium", "high"] });
    expect(model).not.toHaveProperty("thinkingLevelMap");
    expect(model).not.toHaveProperty("efforts");
    // OMP compacts at max(15%, 16384) of contextWindow, so it gets the smallest
    // window whose threshold still reaches the catalog's 150K budget.
    expect(model?.contextWindow).toBeLessThan(200_000);
    expect(
      (model?.contextWindow as number) - Math.max(Math.floor((model?.contextWindow as number) * 0.15), 16_384),
    ).toBeGreaterThanOrEqual(150_000);
    expect(model?.contextWindow as number).toBeLessThanOrEqual(
      (model?.maxContextWindow as number | undefined) ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe("DSH bundles", () => {
  for (const provider of PROVIDERS) {
    it(`registers ${provider} as llm-${provider}`, () => {
      const module = load(join("dsh", provider));
      expect(module.name).toBe(`llm-${provider}`);
      expect(typeof module.apply).toBe("function");
      const registered: Array<{ providers: string[]; adapter: unknown }> = [];
      const ctx = {
        inject: (_deps: string[], callback: (scope: Record<string, unknown>) => void) =>
          callback({ effect: () => undefined }),
        llm: { registerAdapter: (providers: string[], adapter: unknown) => registered.push({ providers, adapter }) },
      };
      (module.apply as (ctx: unknown, config: unknown) => void)(ctx, { provider, displayName: provider });
      expect(registered).toHaveLength(1);
      expect(registered[0]?.providers).toEqual([provider]);
      expect(registered[0]?.adapter).toBeDefined();
    });
  }
});

function piApi() {
  const providers = new Map<string, unknown>();
  const commands: string[] = [];
  const api = {
    registerProvider: (name: string, config: unknown) => providers.set(name, config),
    registerCommand: (name: string) => commands.push(name),
    on: () => undefined,
  };
  return { api, providers, commands };
}
