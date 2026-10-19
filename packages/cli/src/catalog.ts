/**
 * Read the catalog files the hosts already use. This module does not import
 * the vendor cores, so `ns-bridge status` and `models list` stay off the network.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Vendor = "kiro" | "devin" | "grok";

export interface CatalogPaths {
  kiro: string;
  devin: string;
  grok: string;
}

export interface CatalogGroup {
  label: string;
  ids: string[];
  fetchedAt?: number;
}

export interface CatalogReport {
  vendor: Vendor;
  path: string;
  state: "missing" | "unreadable" | "ready";
  groups: CatalogGroup[];
}

const VENDORS: readonly Vendor[] = ["kiro", "devin", "grok"];

export function parseVendors(target: string | undefined): Vendor[] | { error: string } {
  if (!target || target === "all") return [...VENDORS];
  if (target === "kiro" || target === "devin" || target === "grok") return [target];
  return { error: `unknown vendor ${target} (expected kiro, devin, grok, or all)` };
}

/** Same files the provider packages write. Overrides match those packages. */
export function catalogPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): CatalogPaths {
  const dataHome = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return {
    kiro: join(home, ".ns-kiro-provider-models-cache.json"),
    devin: env.NS_DEVIN_MODEL_CACHE ?? join(dataHome, "ns-devin-provider", "models.json"),
    grok: join(home, ".pi", "agent", "cache", "ns-pi-provider", "grok.models.json"),
  };
}

export function readCatalogs(paths: CatalogPaths, vendors: readonly Vendor[] = VENDORS): CatalogReport[] {
  return vendors.map((vendor) => readOne(vendor, paths[vendor]));
}

function readOne(vendor: Vendor, path: string): CatalogReport {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { vendor, path, state: "missing", groups: [] };
    return { vendor, path, state: "unreadable", groups: [] };
  }
  const groups = vendor === "kiro" ? parseKiro(raw) : parseModelList(raw, vendor);
  if (!groups) return { vendor, path, state: "unreadable", groups: [] };
  return { vendor, path, state: "ready", groups };
}

function parseKiro(raw: string): CatalogGroup[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.regions)) return undefined;
  const groups: CatalogGroup[] = [];
  for (const [region, entry] of Object.entries(parsed.regions)) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) return undefined;
    const ids = idsFrom(entry.models);
    if (ids.length === 0) continue;
    groups.push({
      label: region,
      ids,
      ...(typeof entry.fetchedAt === "number" ? { fetchedAt: entry.fetchedAt } : {}),
    });
  }
  return groups;
}

function parseModelList(raw: string, label: string): CatalogGroup[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
  return [
    {
      label,
      ids: idsFrom(parsed.models),
      ...(typeof parsed.fetchedAt === "number" ? { fetchedAt: parsed.fetchedAt } : {}),
    },
  ];
}

function idsFrom(models: unknown[]): string[] {
  const ids: string[] = [];
  for (const entry of models) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    ids.push(entry.id);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatCatalog(report: CatalogReport, mode: "list" | "status", now = Date.now()): string[] {
  if (report.state === "missing") return [`${report.vendor}  no cache file  ${report.path}`];
  if (report.state === "unreadable") return [`${report.vendor}  unreadable cache  ${report.path}`];

  const ids = report.groups.flatMap((group) => group.ids);
  const fetched = report.groups.find((group) => group.fetchedAt !== undefined)?.fetchedAt;
  const when = fetched === undefined ? "" : `  fetched ${age(fetched, now)}`;

  if (mode === "status") {
    const lines = [`${report.vendor}  ${ids.length} model(s)${when}  ${report.path}`];
    for (const group of report.groups) {
      const shown = group.ids.slice(0, 8);
      const extra = group.ids.length - shown.length;
      const body = extra > 0 ? `${shown.join(", ")}, … (${extra} more)` : shown.join(", ");
      const prefix = report.vendor === "kiro" ? `${group.label}: ` : "";
      if (body) lines.push(`  ${prefix}${body}`);
    }
    return lines;
  }

  const lines = [`${report.vendor}  ${report.path}${when}`];
  for (const group of report.groups) {
    if (report.vendor === "kiro") {
      const regionWhen = group.fetchedAt === undefined ? "" : `  fetched ${age(group.fetchedAt, now)}`;
      lines.push(`  ${group.label}${regionWhen}`);
    }
    for (const id of group.ids) lines.push(report.vendor === "kiro" ? `    ${id}` : `  ${id}`);
  }
  return lines;
}

function age(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
