// ABOUTME: Tests for the usage ledger: record arithmetic, file layout, path safety, pruning, and failure isolation.
// ABOUTME: Every write goes to a temp dir through NS_BRIDGE_USAGE_DIR; the real home is never touched.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildUsageRecord,
  pruneUsage,
  recordUsage,
  resetUsageLedgerForTests,
  setUsageHost,
  type UsageRecord,
  usageDay,
  usageFileName,
  usageRecordingEnabled,
  usageWriteFailures,
} from "../src/usage-ledger.js";

let root: string;
const saved = { dir: process.env.NS_BRIDGE_USAGE_DIR, flag: process.env.NS_BRIDGE_USAGE };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ns-usage-"));
  process.env.NS_BRIDGE_USAGE_DIR = root;
  process.env.NS_BRIDGE_USAGE = "1";
  resetUsageLedgerForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [
    ["NS_BRIDGE_USAGE_DIR", saved.dir],
    ["NS_BRIDGE_USAGE", saved.flag],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function* events(...items: Array<{ type: string } & Record<string, unknown>>) {
  for (const item of items) yield item;
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

function readLines(path: string): UsageRecord[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as UsageRecord);
}

const context = { vendor: "grok", model: "grok-4.7", contextWindow: 256_000, effort: "high", sessionId: "sess-1" };
const wire = { input: 1000, output: 50, totalTokens: 9050, cacheRead: 8000 };

describe("buildUsageRecord", () => {
  const base = { context, host: "dsh" as const, at: Date.UTC(2026, 9, 21, 5, 0, 0), ms: 1200, step: 2, gapMs: 8000 };

  it("splits prompt tokens from output and computes the hit ratio over the prompt only", () => {
    const record = buildUsageRecord({ ...base, usage: { ...wire, cost: undefined } as never });
    expect(record.promptTokens).toBe(9000);
    expect(record.cacheHitRatio).toBeCloseTo(8000 / 9000);
    expect(record.cacheSource).toBe("wire");
    expect(record.contextFill).toBeCloseTo(9000 / 256_000);
  });

  it("counts cache writes in the prompt and reports their ratio", () => {
    const record = buildUsageRecord({
      ...base,
      usage: { input: 100, output: 10, totalTokens: 1110, cacheRead: 700, cacheWrite: 200 },
    });
    expect(record.promptTokens).toBe(1000);
    expect(record.cacheHitRatio).toBeCloseTo(0.7);
    expect(record.cacheWriteRatio).toBeCloseTo(0.2);
  });

  it("uses null, not 0, when the provider reported no cache counters", () => {
    const record = buildUsageRecord({ ...base, usage: { input: 500, output: 20, totalTokens: 520 } });
    expect(record.cacheSource).toBe("none");
    expect(record.cacheHitRatio).toBeNull();
    expect(record.cacheWriteRatio).toBeNull();
    expect(record).not.toHaveProperty("cacheRead");
  });

  it("keeps a provider-reported zero as 0", () => {
    const zero = buildUsageRecord({ ...base, usage: { input: 500, output: 20, totalTokens: 520, cacheRead: 0 } });
    expect(zero.cacheHitRatio).toBe(0);
    expect(zero.cacheSource).toBe("wire");
  });

  it("never records a plugin's own cache estimate as a provider number", () => {
    // Kiro sends no counters; the estimator moved 1000 of 1100 prompt tokens into cacheRead.
    const record = buildUsageRecord({
      ...base,
      usage: { input: 100, output: 20, totalTokens: 1120, cacheRead: 1000, cacheEstimated: true },
    });
    expect(record.cacheSource).toBe("none");
    expect(record.cacheHitRatio).toBeNull();
    expect(record.cacheWriteRatio).toBeNull();
    expect(record).not.toHaveProperty("cacheRead");
    // The tokens return to input, so the prompt size is still the real one.
    expect(record.input).toBe(1100);
    expect(record.promptTokens).toBe(1100);
    expect(record.total).toBe(1120);
  });

  it("omits context fill when the model has no window", () => {
    const record = buildUsageRecord({
      ...base,
      context: { vendor: "kiro", model: "m" },
      usage: { input: 1, output: 1, totalTokens: 2 },
    });
    expect(record).not.toHaveProperty("contextFill");
    expect(record).not.toHaveProperty("contextWindow");
  });

  it("does not divide by an empty prompt", () => {
    const record = buildUsageRecord({ ...base, usage: { input: 0, output: 5, totalTokens: 5, cacheRead: 0 } });
    expect(record.cacheHitRatio).toBeNull();
  });
});

describe("deriveCache", () => {
  const base = { context, host: "dsh" as const, at: Date.UTC(2026, 9, 21, 5, 0, 0), ms: 10, step: 1, gapMs: null };
  const kiro = { input: 20000, output: 10, totalTokens: 20010, credits: 0.0137, creditUnit: "credit" };
  const derive = (turn: { promptTokens: number }) => ({
    exact: true as const,
    cacheRead: Math.round(turn.promptTokens * 0.9),
  });

  it("fills the counters from the derivation when the provider sent none, and labels them", () => {
    const record = buildUsageRecord({ ...base, context: { ...context, deriveCache: derive }, usage: kiro });
    expect(record.cacheSource).toBe("credits");
    expect(record.cacheRead).toBe(18000);
    expect(record.input).toBe(2000);
    expect(record.promptTokens).toBe(20000);
    expect(record.cacheHitRatio).toBeCloseTo(0.9);
    // Credits say nothing about writes.
    expect(record.cacheWriteRatio).toBeNull();
  });

  it("is not asked, and cannot overwrite, a counter the provider did send", () => {
    let asked = false;
    const record = buildUsageRecord({
      ...base,
      context: {
        ...context,
        deriveCache: () => {
          asked = true;
          return { exact: true as const, cacheRead: 1 };
        },
      },
      usage: wire,
    });
    expect(asked).toBe(false);
    expect(record.cacheSource).toBe("wire");
    expect(record.cacheRead).toBe(8000);
  });

  it("derives from the provider's input, never from a plugin's own estimate", () => {
    let seen = 0;
    buildUsageRecord({
      ...base,
      context: {
        ...context,
        deriveCache: (turn) => {
          seen = turn.promptTokens;
          return undefined;
        },
      },
      usage: { ...kiro, input: 500, cacheRead: 19500, cacheEstimated: true },
    });
    expect(seen).toBe(20000);
  });

  it("re-derives a core's credits figure from the bill instead of recording it as a wire counter", () => {
    const record = buildUsageRecord({
      ...base,
      context: { ...context, deriveCache: derive },
      usage: { ...kiro, input: 1000, cacheRead: 19000, cacheDerived: "credits" },
    });
    expect(record.cacheSource).toBe("credits");
    expect(record.promptTokens).toBe(20000);
    expect(record.cacheRead).toBe(18000);
  });

  it("records a capped derivation as an upper bound and puts nothing in cacheRead", () => {
    const record = buildUsageRecord({
      ...base,
      context: { ...context, deriveCache: () => ({ exact: false as const, maxRatio: 0.9 }) },
      usage: kiro,
    });
    expect(record.cacheSource).toBe("credits-capped");
    expect(record.cacheHitMax).toBe(0.9);
    expect(record.cacheHitRatio).toBeNull();
    expect(record).not.toHaveProperty("cacheRead");
    expect(record.input).toBe(20000);
  });

  it("falls back to no cache data when the derivation declines or throws", () => {
    const declined = buildUsageRecord({ ...base, context: { ...context, deriveCache: () => undefined }, usage: kiro });
    expect(declined.cacheSource).toBe("none");
    expect(declined.cacheHitRatio).toBeNull();
    const thrown = buildUsageRecord({
      ...base,
      context: {
        ...context,
        deriveCache: () => {
          throw new Error("boom");
        },
      },
      usage: kiro,
    });
    expect(thrown.cacheSource).toBe("none");
  });
});

describe("usageFileName", () => {
  it("keeps plain ids and hashes anything that could steer a path", () => {
    expect(usageFileName("5633f9f5-dbdf-435b-9630-673603b4e51d")).toBe("5633f9f5-dbdf-435b-9630-673603b4e51d");
    expect(usageFileName(undefined)).toBe("_no-session");
    expect(usageFileName("  ")).toBe("_no-session");
    for (const hostile of ["../../etc/passwd", "a/b", "..", "a.b", "x".repeat(81), "id with space", "é"]) {
      const name = usageFileName(hostile);
      expect(name).toMatch(/^h-[0-9a-f]{16}$/);
    }
    expect(usageFileName("a/b")).toBe(usageFileName("a/b"));
    expect(usageFileName("a/b")).not.toBe(usageFileName("a/c"));
  });
});

describe("recordUsage", () => {
  it("writes day/vendor/session.jsonl and passes every event through in order", async () => {
    setUsageHost("dsh");
    const input = [
      { type: "start" },
      { type: "text_delta", delta: "hi" },
      { type: "usage", usage: wire },
      { type: "done", stopReason: "stop" },
    ];
    const out = await drain(recordUsage(events(...input), context));
    expect(out).toEqual(input);

    const file = join(root, usageDay(Date.now()), "grok", "sess-1.jsonl");
    expect(existsSync(file)).toBe(true);
    const [record] = readLines(file);
    expect(record).toMatchObject({
      vendor: "grok",
      model: "grok-4.7",
      session: "sess-1",
      step: 1,
      gapMs: null,
      stop: "stop",
      effort: "high",
      promptTokens: 9000,
      cacheSource: "wire",
    });
    expect(record?.host).toBe("dsh");
  });

  it("numbers steps per vendor and session and records the gap", async () => {
    for (let i = 0; i < 3; i++) {
      await drain(recordUsage(events({ type: "usage", usage: wire }, { type: "done", stopReason: "stop" }), context));
    }
    await drain(
      recordUsage(events({ type: "usage", usage: wire }), { ...context, vendor: "devin", sessionId: "sess-1" }),
    );
    const grok = readLines(join(root, usageDay(Date.now()), "grok", "sess-1.jsonl"));
    expect(grok.map((r) => r.step)).toEqual([1, 2, 3]);
    expect(grok[0]?.gapMs).toBeNull();
    expect(grok[1]?.gapMs).toBeGreaterThanOrEqual(0);
    const devin = readLines(join(root, usageDay(Date.now()), "devin", "sess-1.jsonl"));
    expect(devin[0]?.step).toBe(1);
  });

  it("continues the step count when a later process resumes the same session", async () => {
    await drain(recordUsage(events({ type: "usage", usage: wire }, { type: "done", stopReason: "stop" }), context));
    await drain(recordUsage(events({ type: "usage", usage: wire }, { type: "done", stopReason: "stop" }), context));
    // A new process has an empty in-memory map; the file is all it has.
    resetUsageLedgerForTests();
    await drain(recordUsage(events({ type: "usage", usage: wire }, { type: "done", stopReason: "stop" }), context));
    const lines = readLines(join(root, usageDay(Date.now()), "grok", "sess-1.jsonl"));
    expect(lines.map((r) => r.step)).toEqual([1, 2, 3]);
    expect(lines[2]?.gapMs).not.toBeNull();
  });

  it("starts at step 1 when the existing file is unreadable", async () => {
    const dir = join(root, usageDay(Date.now()), "grok");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-1.jsonl"), "{not json\n");
    await drain(recordUsage(events({ type: "usage", usage: wire }), context));
    const lines = readFileSync(join(dir, "sess-1.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1) as string).step).toBe(1);
  });

  it("uses the last usage event when a vendor re-sends counters", async () => {
    await drain(
      recordUsage(
        events(
          { type: "usage", usage: { input: 1, output: 1, totalTokens: 2 } },
          { type: "usage", usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 90 } },
        ),
        context,
      ),
    );
    const [record] = readLines(join(root, usageDay(Date.now()), "grok", "sess-1.jsonl"));
    expect(record?.input).toBe(10);
    expect(record?.cacheRead).toBe(90);
  });

  it("writes a session-less request to _no-session.jsonl", async () => {
    await drain(recordUsage(events({ type: "usage", usage: wire }), { ...context, sessionId: undefined }));
    const file = join(root, usageDay(Date.now()), "grok", "_no-session.jsonl");
    const [record] = readLines(file);
    expect(record?.session).toBeNull();
    expect(record?.step).toBeNull();
  });

  it("never lets a hostile session id leave the vendor folder", async () => {
    await drain(recordUsage(events({ type: "usage", usage: wire }), { ...context, sessionId: "../../../evil" }));
    const dir = join(root, usageDay(Date.now()), "grok");
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^h-[0-9a-f]{16}\.jsonl$/);
    expect(existsSync(join(root, "..", "evil.jsonl"))).toBe(false);
  });

  it("writes nothing when the stream carried no usage", async () => {
    await drain(recordUsage(events({ type: "start" }, { type: "done", stopReason: "stop" }), context));
    expect(readdirSync(root)).toEqual([]);
  });

  it("writes nothing when recording is off", async () => {
    process.env.NS_BRIDGE_USAGE = "0";
    expect(usageRecordingEnabled()).toBe(false);
    await drain(recordUsage(events({ type: "usage", usage: wire }), context));
    expect(readdirSync(root)).toEqual([]);
  });

  it("still records usage when the stream throws afterwards, and rethrows", async () => {
    async function* broken() {
      yield { type: "usage", usage: wire };
      throw new Error("socket closed");
    }
    await expect(drain(recordUsage(broken(), context))).rejects.toThrow("socket closed");
    expect(existsSync(join(root, usageDay(Date.now()), "grok", "sess-1.jsonl"))).toBe(true);
  });

  it("does not fail the response when the ledger cannot be written", async () => {
    // A file where the root directory should be: every mkdir under it fails.
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    process.env.NS_BRIDGE_USAGE_DIR = blocked;
    const input = [
      { type: "usage", usage: wire },
      { type: "done", stopReason: "stop" },
    ];
    const out = await drain(recordUsage(events(...input), context));
    expect(out).toEqual(input);
    expect(usageWriteFailures()).toBe(1);
  });
});

describe("pruneUsage", () => {
  function seed(day: string, bytes = 10) {
    const dir = join(root, day, "grok");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), "x".repeat(bytes));
  }
  const now = Date.UTC(2026, 9, 21, 5, 0, 0);

  it("removes whole day folders older than the retention window", () => {
    seed("2026-08-01");
    seed("2026-10-01");
    seed("2026-10-21");
    const removed = pruneUsage(root, { now, maxAgeDays: 30 });
    expect(removed).toEqual(["2026-08-01"]);
    expect(readdirSync(root).sort()).toEqual(["2026-10-01", "2026-10-21"]);
  });

  it("drops the oldest days first while over the size cap, and keeps the newest", () => {
    seed("2026-10-18", 400);
    seed("2026-10-19", 400);
    seed("2026-10-21", 400);
    const removed = pruneUsage(root, { now, maxAgeDays: 30, maxBytes: 500 });
    expect(removed).toEqual(["2026-10-18", "2026-10-19"]);
    expect(readdirSync(root)).toEqual(["2026-10-21"]);
  });

  it("keeps the only day even when it alone is over the cap", () => {
    seed("2026-10-21", 900);
    expect(pruneUsage(root, { now, maxBytes: 10 })).toEqual([]);
  });

  it("ignores folders that are not day folders", () => {
    mkdirSync(join(root, "notes"), { recursive: true });
    seed("2026-10-21");
    expect(pruneUsage(root, { now, maxBytes: 1 })).toEqual([]);
    expect(existsSync(join(root, "notes"))).toBe(true);
  });

  it("returns nothing for a missing root", () => {
    expect(pruneUsage(join(root, "missing"))).toEqual([]);
  });
});
