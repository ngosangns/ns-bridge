/**
 * `ns-bridge usage`: read the usage ledger the provider cores write.
 *
 * Layout: <root>/<day>/<vendor>/<session>.jsonl, one JSON line per response.
 * This module only reads. It shares no code with the writer, so the published
 * CLI keeps no runtime dependency on the provider packages; the record shape
 * below is the contract between them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageLine {
  ts: string;
  vendor: string;
  host: string;
  model: string;
  session: string | null;
  step: number | null;
  gapMs: number | null;
  input: number;
  output: number;
  promptTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheHitRatio: number | null;
  cacheWriteRatio: number | null;
  cacheSource: "wire" | "credits" | "credits-capped" | "none";
  cacheHitMax?: number;
  contextFill?: number;
  effort?: string;
  /** What the provider billed for the step, denominated in `creditUnit` (arnict: "USD"). */
  credits?: number;
  creditUnit?: string;
}

export interface UsageQuery {
  /** Newest N day folders. Ignored when `day` is set, or when `session` is set without `days`. */
  days?: number;
  day?: string;
  vendor?: string;
  session?: string;
}

export const DEFAULT_USAGE_DAYS = 10;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function usageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.NS_BRIDGE_USAGE_DIR?.trim() || join(homedir(), ".ns-bridge", "usage");
}

function dayFolders(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DAY_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function parseLine(text: string): UsageLine | undefined {
  try {
    const value = JSON.parse(text) as Partial<UsageLine>;
    if (typeof value.vendor !== "string" || typeof value.promptTokens !== "number") return undefined;
    if (!["wire", "credits", "credits-capped", "none"].includes(value.cacheSource as string)) return undefined;
    return value as UsageLine;
  } catch {
    // A torn last line from a crashed process is not worth failing the report.
    return undefined;
  }
}

/** Records for the query, oldest first. `skipped` counts lines that did not parse. */
export function readUsage(
  root: string,
  query: UsageQuery = {},
): { records: UsageLine[]; skipped: number; days: string[] } {
  const all = dayFolders(root);
  let days: string[];
  if (query.day) days = all.filter((day) => day === query.day);
  else if (query.session && query.days === undefined) days = all;
  else days = all.slice(0, query.days ?? DEFAULT_USAGE_DAYS);

  const records: UsageLine[] = [];
  let skipped = 0;
  for (const day of [...days].reverse()) {
    const dayPath = join(root, day);
    let vendors: string[];
    try {
      vendors = readdirSync(dayPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && (!query.vendor || entry.name === query.vendor))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const vendor of vendors) {
      const vendorPath = join(dayPath, vendor);
      for (const file of readdirSync(vendorPath)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()) {
        const text = readFileSync(join(vendorPath, file), "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const record = parseLine(line);
          if (!record) {
            skipped += 1;
            continue;
          }
          // Match on the recorded id, not the file name: hostile ids are hashed in the name only.
          if (query.session && record.session !== query.session) continue;
          records.push(record);
        }
      }
    }
  }
  records.sort((a, b) => a.ts.localeCompare(b.ts));
  return { records, skipped, days };
}

export interface UsageRow {
  day: string;
  vendor: string;
  steps: number;
  promptTokens: number;
  /** cacheRead over prompt tokens, summed. Steps with no cache counters are left out of both sides. */
  hit: number | null;
  write: number | null;
  wire: number;
  credits: number;
  capped: number;
  none: number;
}

/** Group by local day (the folder the writer used is not on the record, so derive it the same way) and vendor. */
export function summarize(records: readonly UsageLine[], dayOf: (ts: string) => string): UsageRow[] {
  const groups = new Map<string, UsageLine[]>();
  for (const record of records) {
    const key = `${dayOf(record.ts)}\u0000${record.vendor}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  const rows: UsageRow[] = [];
  for (const [key, list] of groups) {
    const [day = "", vendor = ""] = key.split("\u0000");
    const withCache = list.filter((record) => record.cacheHitRatio !== null);
    const hitPrompt = withCache.reduce((sum, record) => sum + record.promptTokens, 0);
    const hitRead = withCache.reduce((sum, record) => sum + (record.cacheRead ?? 0), 0);
    const withWrite = list.filter((record) => record.cacheWriteRatio !== null);
    const writePrompt = withWrite.reduce((sum, record) => sum + record.promptTokens, 0);
    const writeTokens = withWrite.reduce((sum, record) => sum + (record.cacheWrite ?? 0), 0);
    rows.push({
      day,
      vendor,
      steps: list.length,
      promptTokens: list.reduce((sum, record) => sum + record.promptTokens, 0),
      hit: hitPrompt > 0 ? hitRead / hitPrompt : null,
      write: writePrompt > 0 ? writeTokens / writePrompt : null,
      wire: list.filter((record) => record.cacheSource === "wire").length,
      credits: list.filter((record) => record.cacheSource === "credits").length,
      capped: list.filter((record) => record.cacheSource === "credits-capped").length,
      none: list.filter((record) => record.cacheSource === "none").length,
    });
  }
  return rows.sort((a, b) => b.day.localeCompare(a.day) || a.vendor.localeCompare(b.vendor));
}

export function localDay(ts: string): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function gap(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/** A USD bill reads as dollars; other units stay bare numbers so two units are never summed or confused. */
function cost(record: UsageLine): string {
  if (record.credits === undefined) return "-";
  return record.creditUnit === "USD" ? `$${record.credits}` : String(record.credits);
}

function pad(columns: readonly string[][], widths?: number[]): string[] {
  const sizes =
    widths ?? columns[0]?.map((_, index) => Math.max(...columns.map((row) => (row[index] ?? "").length))) ?? [];
  return columns.map((row) =>
    row
      .map((cell, index) => cell.padEnd(sizes[index] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function sourceLabel(row: UsageRow): string {
  const parts: string[] = [];
  const mixed = row.wire > 0 && (row.credits > 0 || row.capped > 0 || row.none > 0);
  if (row.wire > 0) parts.push(mixed ? `wire ${row.wire}` : "wire");
  if (row.credits > 0) parts.push(`from credits ${row.credits}`);
  if (row.capped > 0) parts.push(`credits cap ${row.capped}`);
  if (row.none > 0) parts.push(`no cache data ${row.none}`);
  return parts.join(", ") || "-";
}

export function formatSummary(rows: readonly UsageRow[]): string[] {
  if (rows.length === 0) return ["no usage recorded"];
  const table = [
    ["day", "vendor", "steps", "prompt", "hit", "write", "source"],
    ...rows.map((row) => [
      row.day,
      row.vendor,
      String(row.steps),
      tokens(row.promptTokens),
      percent(row.hit),
      percent(row.write),
      sourceLabel(row),
    ]),
  ];
  return pad(table);
}

export function formatSession(records: readonly UsageLine[]): string[] {
  if (records.length === 0) return ["no usage recorded for that session"];
  const table = [
    ["step", "vendor", "model", "prompt", "hit", "gap", "ctx", "cost"],
    ...records.map((record, index) => [
      String(record.step ?? index + 1),
      record.vendor,
      record.model,
      tokens(record.promptTokens),
      record.cacheSource === "credits"
        ? `${percent(record.cacheHitRatio)}*`
        : record.cacheSource === "credits-capped"
          ? `<=${percent(record.cacheHitMax)}*`
          : percent(record.cacheHitRatio),
      gap(record.gapMs),
      percent(record.contextFill),
      cost(record),
    ]),
  ];
  return pad(table);
}

export function usageRootExists(root: string): boolean {
  return existsSync(root);
}
