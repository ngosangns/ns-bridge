// ABOUTME: Appends one JSON line per model response so cache hit and token counts survive outside the host.
// ABOUTME: Layout is <root>/<day>/<vendor>/<session>.jsonl. Recording never throws into a response stream.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Which coding agent loaded the plugin. Set once per process by the adapter. */
export type UsageHost = "pi" | "omp" | "dsh" | "unknown";

/**
 * Where a record's cache counters came from.
 *
 * - `wire`: the provider sent them.
 * - `credits`: the provider sent none, and the core derived the cached share from the
 *   credits the provider billed for the turn (see `deriveCache`). A calculation, not a count.
 * - `credits-capped`: the bill was on the provider's no-cache ceiling, which a cached
 *   prefix can also reach. The ratio is unknown; `cacheHitMax` is the most it could be.
 * - `none`: neither. A host plugin's own guess is never recorded as any of these.
 */
export type CacheSource = "wire" | "credits" | "credits-capped" | "none";

/** One response. Ratios are `null` when the provider reported no cache counters, never 0. */
export interface UsageRecord {
  ts: string;
  vendor: string;
  host: UsageHost;
  model: string;
  session: string | null;
  step: number | null;
  gapMs: number | null;
  ms: number;
  input: number;
  output: number;
  total: number;
  promptTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheHitRatio: number | null;
  cacheWriteRatio: number | null;
  /** Only with `credits-capped`: the largest cached share the bill allows. */
  cacheHitMax?: number;
  cacheSource: CacheSource;
  credits?: number;
  creditUnit?: string;
  contextWindow?: number;
  contextFill?: number | null;
  contextPercent?: number;
  effort?: string;
  stop?: string;
}

/** What a core knows about the request when it starts streaming. */
export interface UsageContext {
  vendor: string;
  model: string;
  /**
   * For a vendor whose wire carries no cache counters: work them out from what
   * the vendor did report. Called only when no counter arrived. Must not read
   * anything a host plugin estimated.
   */
  deriveCache?: (turn: {
    promptTokens: number;
    outputTokens: number;
    credits?: number;
    creditUnit?: string;
  }) => { exact: true; cacheRead: number } | { exact: false; maxRatio: number } | undefined;
  contextWindow?: number;
  effort?: string;
  sessionId?: string;
}

/** Structural view of a core's usage event. Cores do not share a type, so this stays loose. */
interface UsageLike {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheEstimated?: boolean;
  cacheDerived?: string;
  credits?: number;
  creditUnit?: string;
  contextPercent?: number;
}

export const USAGE_RETENTION_DAYS = 30;
export const USAGE_MAX_BYTES = 50 * 1024 * 1024;
const NO_SESSION_FILE = "_no-session";
const MAX_TRACKED_SESSIONS = 256;
const HOST_KEY = Symbol.for("ns-bridge.usage.host");

// Duplicate copies of this module (a bundled host plus a workspace link) must still agree.
type HostHolder = { [HOST_KEY]?: UsageHost };

/**
 * Name the host once per process. The first caller wins: ns-omp-provider
 * bundles the Pi adapter, which would otherwise relabel an OMP process as Pi.
 */
export function setUsageHost(host: UsageHost): void {
  const holder = globalThis as HostHolder;
  if (holder[HOST_KEY] === undefined) holder[HOST_KEY] = host;
}

export function getUsageHost(): UsageHost {
  return (globalThis as HostHolder)[HOST_KEY] ?? "unknown";
}

/** `NS_BRIDGE_USAGE=0` (or false/off) turns recording off. Read per call so tests can flip it. */
export function usageRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.NS_BRIDGE_USAGE?.trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

export function usageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.NS_BRIDGE_USAGE_DIR?.trim() || join(homedir(), ".ns-bridge", "usage");
}

/** Local calendar day, the folder name. The timestamp inside each line stays UTC. */
export function usageDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A session id comes from the host, so it must never choose a path. Plain ids
 * pass through; anything else (separators, dots, long strings) becomes a hash.
 */
export function usageFileName(sessionId: string | undefined): string {
  const id = sessionId?.trim();
  if (!id) return NO_SESSION_FILE;
  if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) return id;
  return `h-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

function ratio(part: number | undefined, whole: number): number | null {
  if (part === undefined || whole <= 0) return null;
  return part / whole;
}

/**
 * Strip a plugin's own cache guess back out. Kiro sends no cache counters, so the
 * estimator moves repeated prompt tokens from `input` to `cacheRead` and sets
 * `cacheEstimated`; it changes no total. Moving them back gives what Kiro sent.
 * The estimator only runs when the provider reported no cache, so `cacheRead`
 * here is entirely the guess.
 */
function providerUsage(usage: UsageLike): UsageLike {
  if (!usage.cacheEstimated && usage.cacheDerived === undefined) return usage;
  // A core's credits-derived figure is moved back too: `deriveCache` recomputes it
  // from the same bill, and keeping it would mislabel the record as `wire`.
  const { cacheRead, cacheEstimated: _guess, cacheDerived: _derived, ...rest } = usage;
  return { ...rest, input: usage.input + (cacheRead ?? 0) };
}

function isUsage(value: unknown): value is UsageLike {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.input === "number" && typeof usage.output === "number";
}

/** Pure: turn one usage event into a record. Exported so the CLI and tests share the arithmetic. */
export function buildUsageRecord(input: {
  context: UsageContext;
  usage: UsageLike;
  host: UsageHost;
  at: number;
  ms: number;
  step: number | null;
  gapMs: number | null;
  stop?: string;
}): UsageRecord {
  const { context } = input;
  let usage = providerUsage(input.usage);
  const promptTokens = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  let cacheHitMax: number | undefined;
  let cacheSource: CacheSource = usage.cacheRead !== undefined || usage.cacheWrite !== undefined ? "wire" : "none";
  if (cacheSource === "none" && context.deriveCache) {
    let derived: ReturnType<NonNullable<UsageContext["deriveCache"]>>;
    try {
      derived = context.deriveCache({
        promptTokens,
        outputTokens: usage.output,
        credits: usage.credits,
        creditUnit: usage.creditUnit,
      });
    } catch {
      derived = undefined;
    }
    if (derived?.exact) {
      cacheSource = "credits";
      usage = { ...usage, input: promptTokens - derived.cacheRead, cacheRead: derived.cacheRead };
    } else if (derived) {
      cacheSource = "credits-capped";
      cacheHitMax = derived.maxRatio;
    }
  }
  const hasCache = cacheSource === "wire" || cacheSource === "credits";
  const contextFill =
    context.contextWindow !== undefined && context.contextWindow > 0 ? promptTokens / context.contextWindow : null;
  return {
    ts: new Date(input.at).toISOString(),
    vendor: context.vendor,
    host: input.host,
    model: context.model,
    session: context.sessionId?.trim() || null,
    step: input.step,
    gapMs: input.gapMs,
    ms: input.ms,
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    promptTokens,
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
    cacheHitRatio: hasCache ? ratio(usage.cacheRead ?? 0, promptTokens) : null,
    cacheWriteRatio: cacheSource === "wire" ? ratio(usage.cacheWrite, promptTokens) : null,
    cacheSource,
    ...(cacheHitMax !== undefined ? { cacheHitMax } : {}),
    ...(usage.credits !== undefined ? { credits: usage.credits } : {}),
    ...(usage.creditUnit !== undefined ? { creditUnit: usage.creditUnit } : {}),
    ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
    ...(contextFill !== null ? { contextFill } : {}),
    ...(usage.contextPercent !== undefined ? { contextPercent: usage.contextPercent } : {}),
    ...(context.effort ? { effort: context.effort } : {}),
    ...(input.stop ? { stop: input.stop } : {}),
  };
}

interface SessionState {
  step: number;
  lastEndedAt: number;
}

const sessions = new Map<string, SessionState>();
let lastPrunedDay: string | undefined;
let failedWrites = 0;

/** How many appends failed (read-only home, full disk). Recording drops them silently. */
export function usageWriteFailures(): number {
  return failedWrites;
}

/** Clear per-process state between tests. */
export function resetUsageLedgerForTests(): void {
  sessions.clear();
  lastPrunedDay = undefined;
  failedWrites = 0;
}

/**
 * Where this session left off in today's file. A resumed session (`pi -p
 * --session-id x` twice) is a new process with an empty map, and without this it
 * would count from step 1 again. Only today's file is read, so a session that
 * crosses midnight restarts its count in the new day's folder.
 */
function resumeFromDisk(path: string): SessionState | undefined {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim());
    if (lines.length === 0) return undefined;
    const last = JSON.parse(lines[lines.length - 1] as string) as { ts?: string };
    const endedAt = typeof last.ts === "string" ? Date.parse(last.ts) : Number.NaN;
    return { step: lines.length, lastEndedAt: Number.isFinite(endedAt) ? endedAt : Number.NaN };
  } catch {
    return undefined;
  }
}

function nextStep(
  vendor: string,
  sessionId: string | undefined,
  now: number,
  env: NodeJS.ProcessEnv,
): { step: number | null; gapMs: number | null } {
  const id = sessionId?.trim();
  if (!id) return { step: null, gapMs: null };
  const key = `${vendor}\u0000${id}`;
  const previous =
    sessions.get(key) ??
    resumeFromDisk(join(usageRoot(env), usageDay(now), usageFileName(vendor), `${usageFileName(id)}.jsonl`));
  const state: SessionState = { step: (previous?.step ?? 0) + 1, lastEndedAt: now };
  // Refresh insertion order so the map stays a bounded least-recently-used set.
  sessions.delete(key);
  sessions.set(key, state);
  if (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  const gapMs = previous && Number.isFinite(previous.lastEndedAt) ? Math.max(0, now - previous.lastEndedAt) : null;
  return { step: state.step, gapMs };
}

function dirBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? dirBytes(child) : statSync(child).size;
  }
  return total;
}

/**
 * Drop whole day folders older than `maxAgeDays`, then the oldest remaining
 * ones while the tree is over `maxBytes`. The newest day folder always stays.
 */
export function pruneUsage(
  root: string,
  options: { now?: number; maxAgeDays?: number; maxBytes?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? USAGE_RETENTION_DAYS;
  const maxBytes = options.maxBytes ?? USAGE_MAX_BYTES;
  const removed: string[] = [];
  let days: string[];
  try {
    days = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return removed;
  }
  const cutoff = usageDay(now - maxAgeDays * 86_400_000);
  const drop = (day: string) => {
    rmSync(join(root, day), { recursive: true, force: true });
    removed.push(day);
  };
  while (days.length > 1 && (days[0] as string) < cutoff) drop(days.shift() as string);
  const sizes = new Map(days.map((day) => [day, dirBytes(join(root, day))]));
  let total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  while (days.length > 1 && total > maxBytes) {
    const oldest = days.shift() as string;
    total -= sizes.get(oldest) ?? 0;
    drop(oldest);
  }
  return removed;
}

/** Append one record. Swallows every error: a failed write must not fail a response. */
export function writeUsageRecord(record: UsageRecord, at: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const root = usageRoot(env);
    const day = usageDay(at);
    if (lastPrunedDay !== day) {
      lastPrunedDay = day;
      try {
        pruneUsage(root, { now: at });
      } catch {
        // Pruning is housekeeping; the append below still runs.
      }
    }
    const dir = join(root, day, usageFileName(record.vendor));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${usageFileName(record.session ?? undefined)}.jsonl`), `${JSON.stringify(record)}\n`);
  } catch {
    failedWrites++;
  }
}

/**
 * Wrap a core's event stream and write one line when it ends. The last usage
 * event wins (Devin re-sends counters as they move), and the stop reason comes
 * from the `done` event. A stream that throws before any usage writes nothing.
 * Events pass through untouched, in order.
 */
export async function* recordUsage<E extends { type: string }>(
  events: AsyncIterable<E>,
  context: UsageContext,
): AsyncGenerator<E, void, undefined> {
  const startedAt = Date.now();
  let usage: UsageLike | undefined;
  let stop: string | undefined;
  try {
    for await (const event of events) {
      const candidate = event as unknown as { usage?: unknown; stopReason?: unknown };
      if (event.type === "usage" && isUsage(candidate.usage)) usage = candidate.usage;
      else if (event.type === "done" && typeof candidate.stopReason === "string") stop = candidate.stopReason;
      yield event;
    }
  } finally {
    if (usage && usageRecordingEnabled()) {
      try {
        const now = Date.now();
        const { step, gapMs } = nextStep(context.vendor, context.sessionId, now, process.env);
        writeUsageRecord(
          buildUsageRecord({
            context,
            usage,
            host: getUsageHost(),
            at: now,
            ms: now - startedAt,
            step,
            gapMs,
            stop,
          }),
          now,
        );
      } catch {
        failedWrites++;
      }
    }
  }
}
