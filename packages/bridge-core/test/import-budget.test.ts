import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(join(dir, "packages/kiro-core/package.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`ns-bridge root not found from ${fileURLToPath(import.meta.url)}`);
}

const ROOT = repoRoot();
const RUNS = 5;
const BUDGET_MS = Number(process.env.NS_BRIDGE_IMPORT_BUDGET_MS ?? 150);

// Host registration imports these built entries. A static import of the
// cl100k ranks, or a cold import slower than the budget, fails the gate.
// CI may widen NS_BRIDGE_IMPORT_BUDGET_MS. The test stays on.
const ENTRIES: Record<string, string> = {
  "ns-kiro-core": join(ROOT, "packages/kiro-core/dist/index.js"),
  "ns-devin-core": join(ROOT, "packages/devin-core/dist/index.js"),
  "ns-bridge-core/pi": join(ROOT, "packages/bridge-core/dist/pi/index.js"),
  "ns-dsh-llm-devin": join(ROOT, "packages/dsh-llm-devin/dist/index.js"),
  "ns-dsh-llm-kiro": join(ROOT, "packages/dsh-llm-kiro/dist/index.js"),
};

const CHILD = `
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
const ranks = [];
function heavy(value) {
  const text = String(value);
  return text.includes("cl100k_base") || text.includes("@smithy/");
}
registerHooks({
  resolve(specifier, context, next) {
    if (heavy(specifier)) ranks.push(String(specifier));
    return next(specifier, context);
  },
  load(url, context, next) {
    if (heavy(url)) ranks.push(String(url));
    return next(url, context);
  },
});
const entries = JSON.parse(process.argv[1]);
const times = {};
for (const [name, href] of Object.entries(entries)) {
  const started = performance.now();
  await import(href);
  times[name] = performance.now() - started;
}
process.stdout.write(JSON.stringify({ times, ranks }));
`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe("registration import graph", () => {
  it("stays inside the import budget and does not load cl100k ranks", () => {
    for (const path of Object.values(ENTRIES)) {
      expect(existsSync(path), path).toBe(true);
    }
    const hrefs = Object.fromEntries(Object.entries(ENTRIES).map(([name, path]) => [name, pathToFileURL(path).href]));
    const samples: Array<Record<string, number>> = [];
    const ranks: string[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD, JSON.stringify(hrefs)], {
        encoding: "utf8",
        timeout: 60_000,
      });
      const parsed = JSON.parse(stdout) as { times: Record<string, number>; ranks: string[] };
      samples.push(parsed.times);
      ranks.push(...parsed.ranks);
    }
    expect(ranks, "cl100k ranks or Smithy loaded during import").toEqual([]);
    const load = loadavg()[0];
    const cores = availableParallelism();
    for (const name of Object.keys(ENTRIES)) {
      const medianMs = median(samples.map((sample) => sample[name]));
      expect(
        medianMs,
        `${name} median ${medianMs.toFixed(1)}ms over ${RUNS} processes; loadavg=${load.toFixed(2)} cores=${cores}`,
      ).toBeLessThanOrEqual(BUDGET_MS);
    }
  }, 120_000);
});
