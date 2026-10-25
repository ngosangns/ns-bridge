/**
 * `ns-bridge zcode setup|status|remove` — register the ns-bridge serve
 * endpoints as personal providers in the ZCode app.
 *
 * ZCode stores personal providers in ~/.zcode/v2/provider_config.json and
 * keeps that file in memory while the desktop app runs, so an edit while it
 * runs is lost on the app's next save. setup and remove refuse --apply while
 * ZCode runs unless --force. The file can hold other providers' entries and
 * secrets, so its contents are never printed — only ids and counts we own.
 *
 * On darwin setup also installs a launchd agent that keeps `ns-bridge serve`
 * running, pinned to the globally installed CLI when one is on PATH and to
 * this checkout otherwise.
 */

import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CatalogEntry,
  type CatalogPaths,
  type CatalogReport,
  catalogPaths,
  readCatalogs,
  type Vendor,
} from "./catalog.js";
import type { Runner } from "./cli.js";
import { formatCommand } from "./hosts.js";
import { PROVIDERS, readSelectionFile, resolveSelection, selectionPath } from "./selection.js";
import { DEFAULT_ZCODE_PORT, ensureZcodeServeConfig, readZcodeServeConfig } from "./zcode-config.js";

/** Every provider id we write starts with this; anything else in the file is left alone. */
export const PROVIDER_ID_PREFIX = "ns-bridge-";
export const ZCODE_LAUNCH_AGENT_LABEL = "dev.ngosangns.ns-bridge.serve";

const SCHEMA_VERSION = 1;
const HEALTH_TIMEOUT_MS = 2000;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const VENDOR_LABEL: Record<Vendor, string> = { kiro: "Kiro", devin: "Devin", grok: "Grok" };

export function zcodeProviderConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (override) return override;
  return join(home, ".zcode", "v2", "provider_config.json");
}

export function launchAgentPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${ZCODE_LAUNCH_AGENT_LABEL}.plist`);
}

export function serveLogPath(home: string): string {
  return join(home, ".ns-bridge", "logs", "serve.log");
}

// --- window math ---

export interface ZcodeModelWindow {
  /** The contextWindow ZCode should see so it compacts near the catalog threshold. */
  window: number;
  maxOutputTokens: number;
}

/**
 * Kiro compaction thresholds for models whose catalog entry records none,
 * copied from kiro-core `long-context.ts`. Copied rather than imported: tsc
 * emits dist/zcode.js verbatim, and the published CLI ships no runtime
 * dependency on the cores — scripts/build.mjs bundles the only entries allowed
 * to import them.
 */
const KIRO_CLAUDE_COMPACTION_TARGET = 150000;
const KIRO_LONG_CONTEXT_THRESHOLDS: Readonly<Record<string, number>> = {
  "gpt-5-6-luna": 272000,
  "gpt-5-6-sol": 272000,
  "gpt-5-6-terra": 272000,
};

/**
 * Where ns-bridge's per-model policy compacts a model whose catalog recorded
 * no threshold. Kiro: a Claude model with a window past 200K compacts at the
 * 150K target; everything else compacts where the OMP provider's default rule
 * lands on the model's standard-price window — OMP holds back
 * max(floor(0.15·W), 16384) of a window W (omp-provider-kiro models.ts
 * `ompWindowForThreshold`) — so ZCode compacts where OMP does: 170000 at 200K,
 * 231200 at the 272K GPT-5.6 tier. The other vendors' cores record the window
 * minus its 16384 reservation (ns-core-utils `compactionBudget`).
 */
export function derivedThresholdTokens(vendor: Vendor, entry: CatalogEntry & { contextWindow: number }): number {
  if (vendor === "kiro") {
    if (entry.id.startsWith("claude-") && entry.contextWindow > 200000) return KIRO_CLAUDE_COMPACTION_TARGET;
    const threshold = KIRO_LONG_CONTEXT_THRESHOLDS[entry.id];
    const standard = threshold !== undefined && threshold < entry.contextWindow ? threshold : entry.contextWindow;
    return standard - Math.max(Math.floor(standard * 0.15), 16384);
  }
  return entry.contextWindow - Math.min(entry.maxTokens ?? 16384, 16384);
}

/**
 * ZCode compacts at W - min(min(maxOutputTokens ?? 32000, 21000), W) - 13000
 * for a reported window W. Reporting W = threshold + 13000 +
 * min(maxOutputTokens, 21000), capped at the real window, lands the
 * compaction on the threshold the catalog recorded — or, when it recorded
 * none, where ns-bridge's per-model policy for the vendor compacts.
 */
export function zcodeModelWindow(entry: CatalogEntry & { contextWindow: number }, vendor: Vendor): ZcodeModelWindow {
  const maxOutputTokens = entry.maxTokens ?? 32000;
  const threshold = entry.thresholdTokens ?? derivedThresholdTokens(vendor, entry);
  const window = Math.min(entry.contextWindow, threshold + 13000 + Math.min(maxOutputTokens, 21000));
  return { window, maxOutputTokens };
}

export function supportsImage(entry: CatalogEntry): boolean {
  return entry.input?.includes("image") ?? false;
}

// --- plan ---

/**
 * Reasoning levels every model rule publishes — the BridgeEffort vocabulary
 * the anthropic-messages bridge maps via toBridgeEffort (bridge-core
 * effort.ts accepts each of them). ZCode ignores a defaultModelSelection
 * whose options.reasoningLevel is missing from the selected model's values,
 * so the rules must carry them explicitly.
 */
export const ZCODE_REASONING_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The level --default pins in defaultModelSelection; always in ZCODE_REASONING_LEVELS. */
export const ZCODE_DEFAULT_REASONING_LEVEL = "high";

export interface ZcodeModelRule {
  providerId: string;
  modelId: string;
  config: {
    properties: { contextWindow: number; inputFormat: { supportsImage: boolean } };
    optionSpecs: { maxOutputTokens: { max: number }; reasoningLevel: { values: readonly string[] } };
  };
}

export interface ZcodeProviderPlan {
  vendor: Vendor;
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  modelRules: ZcodeModelRule[];
  /** Catalog entries left out for lacking a context window. */
  skippedModels: string[];
}

export interface ZcodePlan {
  providers: ZcodeProviderPlan[];
  skipped: { vendor: Vendor; reason: string }[];
}

/** One plan per ready catalog; catalogs that are missing or empty are skipped with a reason. */
export function planZcodeProviders(
  catalogs: readonly CatalogReport[],
  serve: { port: number; token: string },
): ZcodePlan {
  const providers: ZcodeProviderPlan[] = [];
  const skipped: { vendor: Vendor; reason: string }[] = [];
  for (const report of catalogs) {
    if (report.state !== "ready") {
      skipped.push({ vendor: report.vendor, reason: `no catalog (${report.state})` });
      continue;
    }
    const entries = dedupeById(report.groups.flatMap((group) => group.entries));
    const usable = entries.filter(
      (entry): entry is CatalogEntry & { contextWindow: number } => entry.contextWindow !== undefined,
    );
    if (usable.length === 0) {
      skipped.push({ vendor: report.vendor, reason: "catalog has no models with a context window" });
      continue;
    }
    const providerId = `${PROVIDER_ID_PREFIX}${report.vendor}`;
    providers.push({
      vendor: report.vendor,
      providerId,
      providerName: `ns-bridge ${VENDOR_LABEL[report.vendor]}`,
      baseUrl: `http://127.0.0.1:${serve.port}/${report.vendor}`,
      apiKey: serve.token,
      modelIds: usable.map((entry) => entry.id),
      modelRules: usable.map((entry) => {
        const { window, maxOutputTokens } = zcodeModelWindow(entry, report.vendor);
        return {
          providerId,
          modelId: entry.id,
          config: {
            properties: { contextWindow: window, inputFormat: { supportsImage: supportsImage(entry) } },
            optionSpecs: {
              maxOutputTokens: { max: maxOutputTokens },
              reasoningLevel: { values: ZCODE_REASONING_LEVELS },
            },
          },
        };
      }),
      skippedModels: entries.filter((entry) => entry.contextWindow === undefined).map((entry) => entry.id),
    });
  }
  return { providers, skipped };
}

/** Kiro lists the same model per region and profile; the provider wants each id once. */
function dedupeById(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

// --- merge ---

export interface ZcodeMergeOptions {
  /**
   * From --default <vendor>/<model>: replaces defaultModelSelection, carrying
   * the reasoning level ZCode requires for the selection to take effect.
   */
  defaultModel?: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
  /**
   * ns-bridge provider ids whose existing entries stay as-is. setup passes the
   * vendors whose catalog was skipped, so a missing catalog does not unregister
   * a provider that still works.
   */
  keepProviderIds?: string[];
}

export interface ZcodeMergeResult {
  json: Record<string, unknown>;
  changed: boolean;
}

/**
 * Idempotent merge of the ns-bridge providers into ZCode's provider config.
 * Re-registered providers replace their old entries at the same position, ids
 * named by keepProviderIds keep their existing provider, model, and manual
 * model entries and their providerOrder slot untouched, and stale ns-bridge-*
 * entries are dropped, so running it twice changes nothing the second time.
 * Unknown keys and other providers' entries pass through untouched;
 * defaultModelSelection is only touched when mergeOptions names one. An
 * undefined `existing` builds the skeleton ZCode accepts. Throws rather than
 * editing a file whose shape it does not recognize.
 */
export function applyZcodeProviders(
  existing: unknown,
  plan: ZcodePlan,
  mergeOptions: ZcodeMergeOptions = {},
): ZcodeMergeResult {
  if (existing === undefined && plan.providers.length === 0) return { json: {}, changed: false };
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error("provider config is not a JSON object; refusing to overwrite it");
  }
  const next: Record<string, unknown> = existing === undefined ? { schemaVersion: SCHEMA_VERSION } : { ...existing };
  const configIn = isRecord(next.config) ? next.config : undefined;
  if (next.config !== undefined && configIn === undefined) {
    throw new Error("config is not an object; refusing to overwrite the provider config");
  }
  const config: Record<string, unknown> = { ...(configIn ?? {}) };
  const keep = new Set(mergeOptions.keepProviderIds ?? []);

  const providerConfigRules = recordField(config, "providerConfigRules");
  const rulesIn = arrayField(providerConfigRules ?? {}, "providerRules", "config.providerConfigRules");
  const freshProviderRules = new Map(
    plan.providers.map((provider): [string, Record<string, unknown>] => [provider.providerId, providerRule(provider)]),
  );
  if (rulesIn !== undefined || freshProviderRules.size > 0) {
    config.providerConfigRules = {
      ...providerConfigRules,
      providerRules: mergeRules(rulesIn, freshProviderRules, oursProviderKey, keep),
    };
  }

  const modelConfigRules = recordField(config, "modelConfigRules");
  const modelRulesIn = arrayField(modelConfigRules ?? {}, "providerModelRules", "config.modelConfigRules");
  const freshModelRules = new Map<string, unknown>();
  for (const provider of plan.providers) {
    for (const rule of provider.modelRules) freshModelRules.set(`${provider.providerId}/${rule.modelId}`, rule);
  }
  if (modelRulesIn !== undefined || freshModelRules.size > 0) {
    config.modelConfigRules = {
      ...modelConfigRules,
      providerModelRules: mergeRules(modelRulesIn, freshModelRules, oursModelKey, keep),
    };
  }
  const manualIn = arrayField(modelConfigRules ?? {}, "manualProviderModelRules", "config.modelConfigRules");
  if (manualIn !== undefined) {
    const merged = mergeRules(manualIn, new Map(), oursModelKey, keep);
    if (merged.length !== manualIn.length) {
      const base = (config.modelConfigRules ?? modelConfigRules ?? {}) as Record<string, unknown>;
      config.modelConfigRules = { ...base, manualProviderModelRules: merged };
    }
  }

  if (Array.isArray(config.providerOrder)) {
    const freshOrderIds = new Map(
      plan.providers.map((provider): [string, string] => [provider.providerId, provider.providerId]),
    );
    config.providerOrder = mergeRules(config.providerOrder as unknown[], freshOrderIds, oursOrderKey, keep);
  }

  if (mergeOptions.defaultModel) config.defaultModelSelection = { ...mergeOptions.defaultModel };

  if (configIn !== undefined || configHasEntries(config)) next.config = config;

  return { json: next, changed: JSON.stringify(next) !== JSON.stringify(existing) };
}

function providerRule(provider: ZcodeProviderPlan): Record<string, unknown> {
  return {
    providerId: provider.providerId,
    providerName: provider.providerName,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: provider.apiKey },
      api: { type: "anthropic-messages", baseUrl: provider.baseUrl },
      personalModelIds: [...provider.modelIds],
      modelOrder: [...provider.modelIds],
    },
  };
}

/**
 * Slot-preserving merge of our rules into an existing array: rules named by
 * `fresh` are replaced where they stand, rules whose vendor is named by `keep`
 * survive as-is, stale ns-bridge-* rules are dropped, brand-new ones are
 * appended, and foreign rules pass through.
 */
function mergeRules(
  rulesIn: readonly unknown[] | undefined,
  fresh: ReadonlyMap<string, unknown>,
  keyOf: (rule: unknown) => { key: string; providerId: string } | undefined,
  keep: ReadonlySet<string>,
): unknown[] {
  const out: unknown[] = [];
  const replaced = new Set<string>();
  for (const rule of rulesIn ?? []) {
    const id = keyOf(rule);
    if (id === undefined) {
      out.push(rule);
    } else if (fresh.has(id.key)) {
      if (!replaced.has(id.key)) {
        replaced.add(id.key);
        out.push(fresh.get(id.key));
      }
    } else if (keep.has(id.providerId)) {
      out.push(rule);
    }
  }
  for (const [key, rule] of fresh) {
    if (!replaced.has(key)) out.push(rule);
  }
  return out;
}

function oursProviderKey(rule: unknown): { key: string; providerId: string } | undefined {
  return isRecord(rule) && typeof rule.providerId === "string" && rule.providerId.startsWith(PROVIDER_ID_PREFIX)
    ? { key: rule.providerId, providerId: rule.providerId }
    : undefined;
}

function oursModelKey(rule: unknown): { key: string; providerId: string } | undefined {
  if (!isRecord(rule) || typeof rule.providerId !== "string" || !rule.providerId.startsWith(PROVIDER_ID_PREFIX))
    return undefined;
  return {
    key: `${rule.providerId}/${typeof rule.modelId === "string" ? rule.modelId : ""}`,
    providerId: rule.providerId,
  };
}

function oursOrderKey(id: unknown): { key: string; providerId: string } | undefined {
  return typeof id === "string" && id.startsWith(PROVIDER_ID_PREFIX) ? { key: id, providerId: id } : undefined;
}

function configHasEntries(config: Record<string, unknown>): boolean {
  return Object.keys(config).length > 0;
}

function recordField(container: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = container[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${key} is not an object; refusing to overwrite the provider config`);
  return value;
}

function arrayField(container: Record<string, unknown>, key: string, what: string): unknown[] | undefined {
  const value = container[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error(`${what}.${key} is not an array; refusing to overwrite the provider config`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- file IO ---

export function readProviderConfig(
  path: string,
): { state: "missing" } | { state: "unreadable" } | { state: "ready"; json: unknown } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
  try {
    return { state: "ready", json: JSON.parse(raw) };
  } catch {
    return { state: "unreadable" };
  }
}

export function backupPathFor(path: string, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
  return `${path}.bak-ns-bridge-${stamp}`;
}

export function backupProviderConfig(path: string, now: Date): string {
  const base = backupPathFor(path, now);
  for (let attempt = 0; ; attempt++) {
    const backup = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      // COPYFILE_EXCL: a same-second rerun gets -1, -2, ... instead of clobbering a backup.
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function writeProviderConfigAtomic(path: string, json: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.provider_config.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// --- launch agent ---

export interface ServeProgram {
  node: string;
  script: string;
  /** "global": the ns-bridge found on PATH; "fallback": the running checkout. */
  source: "global" | "fallback";
}

export interface ResolveServeProgramInputs {
  /** Colon-separated PATH to walk for an ns-bridge bin. */
  envPath: string;
  /** Script to pin when PATH has no ns-bridge. */
  fallbackScript: string;
  /** Node to run when the found bin has no node beside it. */
  execPath: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}

/**
 * The agent outlives this process and repo checkouts move, so it pins the
 * installed CLI: the first ns-bridge on PATH via its realpath, run by the node
 * sitting next to the bin (a version-managed install keeps its matching
 * runtime there) when present, else execPath.
 */
export function resolveServeProgram(inputs: ResolveServeProgramInputs): ServeProgram {
  const exists = inputs.exists ?? existsSync;
  const realpath = inputs.realpath ?? realpathSync;
  for (const dir of inputs.envPath.split(":")) {
    if (!dir) continue;
    const bin = join(dir, "ns-bridge");
    if (!exists(bin)) continue;
    return {
      script: realpath(bin),
      node: exists(join(dir, "node")) ? join(dir, "node") : inputs.execPath,
      source: "global",
    };
  }
  return { node: inputs.execPath, script: inputs.fallbackScript, source: "fallback" };
}

export interface LaunchAgentInputs {
  label?: string;
  programArguments: readonly string[];
  logPath: string;
  envPath: string;
  /** Extra EnvironmentVariables, e.g. NS_BRIDGE_ZCODE_CONFIG when the serve config is off its default path. */
  extraEnv?: Record<string, string>;
}

export function launchAgentPlist(inputs: LaunchAgentInputs): string {
  const label = inputs.label ?? ZCODE_LAUNCH_AGENT_LABEL;
  const args = inputs.programArguments.map((arg) => `        <string>${escapeXml(arg)}</string>`).join("\n");
  const env: [string, string][] = [["PATH", inputs.envPath], ...Object.entries(inputs.extraEnv ?? {})];
  const envXml = env
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(inputs.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(inputs.logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// --- argument parsing ---

export function parseVendorList(value: string): Vendor[] | { error: string } {
  const out: Vendor[] = [];
  for (const item of value.split(/[\s,]+/)) {
    if (!item) continue;
    if (item !== "kiro" && item !== "devin" && item !== "grok") {
      return { error: `unknown vendor ${item} (expected kiro, devin, or grok)` };
    }
    if (!out.includes(item)) out.push(item);
  }
  if (out.length === 0) return { error: "--vendors needs at least one of kiro, devin, grok" };
  return out;
}

export function parseDefaultModel(value: string): { vendor: Vendor; modelId: string } | { error: string } {
  const slash = value.indexOf("/");
  if (slash <= 0) return { error: `--default needs <vendor>/<model> (got ${value})` };
  const vendor = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (vendor !== "kiro" && vendor !== "devin" && vendor !== "grok") {
    return { error: `--default: unknown vendor ${vendor} (expected kiro, devin, or grok)` };
  }
  if (!modelId) return { error: `--default needs <vendor>/<model> (got ${value})` };
  return { vendor, modelId };
}

// --- command ---

export interface ZcodeCommandOptions {
  action: "setup" | "status" | "remove";
  apply: boolean;
  force: boolean;
  noService: boolean;
  runner: Runner;
  log: (line: string) => void;
  err: (line: string) => void;
  /** --vendors kiro,devin: narrows the provider selection further. */
  vendors?: string;
  /** --default <vendor>/<model>: also set ZCode's defaultModelSelection. */
  default?: string;
  /** HOME for the launch agent, logs, and default paths. Tests point this at a temp dir. */
  home?: string;
  /** Platform override so tests can exercise the darwin-only service. */
  platform?: NodeJS.Platform;
  catalogPaths?: CatalogPaths;
  providerConfigPath?: string;
  serveConfigPath?: string;
  selectionFilePath?: string;
  now?: Date;
}

export async function runZcode(options: ZcodeCommandOptions): Promise<number> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  if (options.action === "status") return zcodeStatus(options, home, platform);
  if (options.action === "remove") return zcodeRemove(options, home, platform);
  return zcodeSetup(options, home, platform);
}

function resolveProviderConfigPath(options: ZcodeCommandOptions, home: string): string {
  return options.providerConfigPath ?? zcodeProviderConfigPath(process.env, home);
}

function defaultServeConfigPath(home: string): string {
  return join(home, ".ns-bridge", "zcode.json");
}

function resolveServeConfigPath(options: ZcodeCommandOptions, home: string): string {
  if (options.serveConfigPath) return options.serveConfigPath;
  const override = process.env.NS_BRIDGE_ZCODE_CONFIG?.trim();
  if (override) return override;
  return defaultServeConfigPath(home);
}

/** launchd serve would read the default path; a moved config must be named in the plist env. */
function serveEnvFor(servePath: string, home: string): Record<string, string> | undefined {
  return servePath === defaultServeConfigPath(home) ? undefined : { NS_BRIDGE_ZCODE_CONFIG: servePath };
}

function resolveSelectionFilePath(options: ZcodeCommandOptions, home: string): string {
  return options.selectionFilePath ?? selectionPath(process.env, home);
}

function selectVendors(options: ZcodeCommandOptions, home: string): Vendor[] | { error: string } {
  const selection = resolveSelection(readSelectionFile(resolveSelectionFilePath(options, home)), process.env);
  let vendors: Vendor[] = PROVIDERS.filter((provider) => selection[provider]);
  if (options.vendors !== undefined) {
    const wanted = parseVendorList(options.vendors);
    if ("error" in wanted) return wanted;
    vendors = vendors.filter((vendor) => wanted.includes(vendor));
  }
  return vendors;
}

export async function isZcodeRunning(runner: Runner): Promise<boolean> {
  const result = await runner(["pgrep", "-x", "ZCode"]);
  return result.code === 0;
}

/** The darwin-only launchctl paths need the console user's uid. */
function uid(): number {
  return process.getuid?.() ?? 0;
}

async function refuseWhileZcodeRuns(options: ZcodeCommandOptions, providerConfigPath: string): Promise<boolean> {
  if (options.apply && !options.force && (await isZcodeRunning(options.runner))) {
    options.err(
      `ZCode is running; it keeps ${providerConfigPath} in memory and would overwrite this change on its next save`,
    );
    options.err("quit ZCode and run this again, or pass --force. Restart ZCode afterwards to pick up the change.");
    return true;
  }
  return false;
}

async function zcodeSetup(options: ZcodeCommandOptions, home: string, platform: NodeJS.Platform): Promise<number> {
  const { log, err, apply } = options;
  const now = options.now ?? new Date();
  const vendors = selectVendors(options, home);
  if ("error" in vendors) {
    err(vendors.error);
    return 1;
  }
  if (vendors.length === 0) {
    err("no vendors to register; check ~/.ns-bridge/providers.json and --vendors");
    return 1;
  }

  const providerConfigPath = resolveProviderConfigPath(options, home);
  const servePath = resolveServeConfigPath(options, home);
  if (await refuseWhileZcodeRuns(options, providerConfigPath)) return 1;

  // The serve config (and with it the token) is only created on --apply, so a
  // preview uses a placeholder key that never reaches a file or the terminal.
  const serve = apply ? ensureZcodeServeConfig(servePath) : readZcodeServeConfig(servePath);
  const plan = planZcodeProviders(readCatalogs(options.catalogPaths ?? catalogPaths(), vendors), {
    port: serve?.port ?? DEFAULT_ZCODE_PORT,
    token: serve?.token ?? "",
  });

  const file = readProviderConfig(providerConfigPath);
  if (file.state === "unreadable") {
    err(`cannot read ${providerConfigPath}; not overwriting it`);
    return 1;
  }

  let defaultModel: { providerId: string; modelId: string; options: { reasoningLevel: string } } | undefined;
  if (options.default !== undefined) {
    const wanted = parseDefaultModel(options.default);
    if ("error" in wanted) {
      err(wanted.error);
      return 1;
    }
    const provider = plan.providers.find((candidate) => candidate.vendor === wanted.vendor);
    if (!provider) {
      err(`--default ${wanted.vendor}: that vendor is not being registered (check --vendors and ns-bridge providers)`);
      return 1;
    }
    if (!provider.modelIds.includes(wanted.modelId)) {
      err(`--default: ${wanted.modelId} is not in the ${provider.providerId} model list`);
      return 1;
    }
    defaultModel = {
      providerId: provider.providerId,
      modelId: wanted.modelId,
      options: { reasoningLevel: ZCODE_DEFAULT_REASONING_LEVEL },
    };
  }

  let merged: ZcodeMergeResult;
  try {
    merged = applyZcodeProviders(file.state === "ready" ? file.json : undefined, plan, {
      defaultModel,
      // A skipped vendor keeps its registered provider; a planned one is refreshed.
      keepProviderIds: plan.skipped.map((skip) => `${PROVIDER_ID_PREFIX}${skip.vendor}`),
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const service = platform === "darwin" && !options.noService;
  const plistPath = launchAgentPlistPath(home);

  if (!apply) {
    log("# dry-run (pass --apply to run)");
    for (const provider of plan.providers) {
      log(`register ${provider.providerId}  ${provider.modelIds.length} model(s)  ${provider.baseUrl}`);
      const summary = modelSummary(provider.modelIds);
      if (summary) log(`  ${summary}`);
      if (provider.skippedModels.length > 0) {
        log(`  # skipped ${provider.skippedModels.length} model(s) without a context window`);
      }
    }
    for (const skip of plan.skipped) log(`# skipped ${skip.vendor}: ${skip.reason}`);
    if (serve === undefined) log(`# create ${servePath} (token generated on --apply)`);
    if (merged.changed) {
      const note = file.state === "ready" ? `  (backup ${backupPathFor(providerConfigPath, now)})` : "  (new file)";
      log(`write ${providerConfigPath}${note}`);
    } else {
      log(`${providerConfigPath} is already up to date`);
    }
    if (service) {
      const consoleUid = uid();
      log(`write ${plistPath}`);
      log(formatCommand(["launchctl", "bootout", `gui/${consoleUid}/${ZCODE_LAUNCH_AGENT_LABEL}`]));
      log(formatCommand(["launchctl", "bootstrap", `gui/${consoleUid}`, plistPath]));
    }
    return 0;
  }

  if (merged.changed) {
    if (file.state === "ready") log(`backup ${backupProviderConfig(providerConfigPath, now)}`);
    writeProviderConfigAtomic(providerConfigPath, merged.json);
    log(`wrote ${providerConfigPath}`);
  } else {
    log(`${providerConfigPath} is already up to date`);
  }
  for (const provider of plan.providers) {
    log(`registered ${provider.providerId}  ${provider.modelIds.length} model(s)`);
    if (provider.skippedModels.length > 0) {
      log(`  # skipped ${provider.skippedModels.length} model(s) without a context window`);
    }
  }
  for (const skip of plan.skipped) log(`# skipped ${skip.vendor}: ${skip.reason}`);

  if (!service) {
    log("# start the server: ns-bridge serve");
    log("# restart ZCode to pick up the new providers");
    return 0;
  }
  const loaded = await installLaunchAgent(options, home, plistPath, serveEnvFor(servePath, home));
  log(`# the launch agent runs ns-bridge serve; logs go to ${serveLogPath(home)}`);
  log("# restart ZCode to pick up the new providers");
  return loaded;
}

async function installLaunchAgent(
  options: ZcodeCommandOptions,
  home: string,
  plistPath: string,
  extraEnv: Record<string, string> | undefined,
): Promise<number> {
  const { log, err, runner } = options;
  // This file sits next to main.js in dist/ (src/ under tsx or a test run).
  const mainJs = join(dirname(fileURLToPath(import.meta.url)), "main.js");
  const envPath = process.env.PATH?.trim() || FALLBACK_PATH;
  const program = resolveServeProgram({ envPath, fallbackScript: mainJs, execPath: process.execPath });
  if (program.source === "fallback") {
    log(`# launch agent pinned to ${mainJs}; install ns-bridge globally to pin the installed CLI`);
  }
  log(`# launch agent runs ${program.node} ${program.script} serve`);
  const logPath = serveLogPath(home);
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(
    plistPath,
    launchAgentPlist({
      programArguments: [program.node, program.script, "serve"],
      logPath,
      envPath,
      extraEnv,
    }),
  );
  log(`wrote ${plistPath}`);

  const bootout = ["launchctl", "bootout", `gui/${uid()}/${ZCODE_LAUNCH_AGENT_LABEL}`];
  log(formatCommand(bootout));
  await runner(bootout); // Not running yet is fine; the result does not matter.
  const bootstrap = ["launchctl", "bootstrap", `gui/${uid()}`, plistPath];
  log(formatCommand(bootstrap));
  const result = await runner(bootstrap);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exited ${result.code}`;
    err(`launchctl bootstrap failed: ${detail}`);
    err("start the server by hand with: ns-bridge serve");
    return 2;
  }
  return 0;
}

async function zcodeStatus(options: ZcodeCommandOptions, home: string, platform: NodeJS.Platform): Promise<number> {
  const { log } = options;
  const providerConfigPath = resolveProviderConfigPath(options, home);
  const servePath = resolveServeConfigPath(options, home);
  const file = readProviderConfig(providerConfigPath);
  log(`provider config  ${providerConfigPath}  ${file.state}`);
  if (file.state === "ready") {
    const registered = listRegistered(file.json);
    for (const vendor of PROVIDERS) {
      const found = registered.find((entry) => entry.providerId === `${PROVIDER_ID_PREFIX}${vendor}`);
      log(`  ns-bridge-${vendor}  ${found ? `present, ${found.modelCount} model(s)` : "absent"}`);
    }
  }
  const serve = readZcodeServeConfig(servePath);
  const port = serve?.port ?? DEFAULT_ZCODE_PORT;
  log(`serve config  ${servePath}  ${serve ? `present, port ${port}` : "missing"}`);
  log(`server  http://127.0.0.1:${port}/healthz  ${await healthLine(port)}`);
  if (platform === "darwin") {
    const plistPath = launchAgentPlistPath(home);
    log(
      `launch agent  ${ZCODE_LAUNCH_AGENT_LABEL}  ${existsSync(plistPath) ? `installed (${plistPath})` : "not installed"}`,
    );
  }
  return 0;
}

async function zcodeRemove(options: ZcodeCommandOptions, home: string, platform: NodeJS.Platform): Promise<number> {
  const { log, err, apply } = options;
  const now = options.now ?? new Date();
  const providerConfigPath = resolveProviderConfigPath(options, home);
  const file = readProviderConfig(providerConfigPath);
  if (file.state === "missing") {
    log(`nothing to remove: ${providerConfigPath} does not exist`);
    return 0;
  }
  if (file.state === "unreadable") {
    err(`cannot read ${providerConfigPath}; not overwriting it`);
    return 1;
  }
  const registered = listRegistered(file.json);
  if (await refuseWhileZcodeRuns(options, providerConfigPath)) return 1;

  let merged: ZcodeMergeResult;
  try {
    merged = applyZcodeProviders(file.json, { providers: [], skipped: [] });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (!apply) {
    log("# dry-run (pass --apply to run)");
    for (const entry of registered) log(`remove ${entry.providerId}  ${entry.modelCount} model(s)`);
    if (registered.length === 0) log(`${providerConfigPath} has no ns-bridge providers`);
    if (merged.changed) log(`write ${providerConfigPath}  (backup ${backupPathFor(providerConfigPath, now)})`);
    if (platform === "darwin") {
      log(formatCommand(["launchctl", "bootout", `gui/${uid()}/${ZCODE_LAUNCH_AGENT_LABEL}`]));
      log(`remove ${launchAgentPlistPath(home)}`);
    }
    log(`# ${resolveServeConfigPath(options, home)} stays`);
    return 0;
  }

  if (merged.changed) {
    log(`backup ${backupProviderConfig(providerConfigPath, now)}`);
    writeProviderConfigAtomic(providerConfigPath, merged.json);
    log(`wrote ${providerConfigPath}`);
  } else {
    log(`${providerConfigPath} has no ns-bridge providers`);
  }
  if (platform === "darwin") {
    const plistPath = launchAgentPlistPath(home);
    const bootout = ["launchctl", "bootout", `gui/${uid()}/${ZCODE_LAUNCH_AGENT_LABEL}`];
    log(formatCommand(bootout));
    await options.runner(bootout); // Not loaded is fine.
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      log(`removed ${plistPath}`);
    }
  }
  if (defaultModelIsOurs(file.json)) {
    err("# defaultModelSelection still points at an ns-bridge provider; pick another default in ZCode");
  }
  return 0;
}

/** What the config currently registers under our prefix; ids and counts only. */
function listRegistered(json: unknown): { providerId: string; modelCount: number }[] {
  if (!isRecord(json) || !isRecord(json.config)) return [];
  const rules = json.config.providerConfigRules;
  if (!isRecord(rules) || !Array.isArray(rules.providerRules)) return [];
  const out: { providerId: string; modelCount: number }[] = [];
  for (const rule of rules.providerRules) {
    if (!isRecord(rule) || typeof rule.providerId !== "string" || !rule.providerId.startsWith(PROVIDER_ID_PREFIX))
      continue;
    const config = isRecord(rule.config) ? rule.config : undefined;
    const ids = config?.personalModelIds;
    out.push({
      providerId: rule.providerId,
      modelCount: Array.isArray(ids) ? ids.filter((id) => typeof id === "string").length : 0,
    });
  }
  return out;
}

function defaultModelIsOurs(json: unknown): boolean {
  if (!isRecord(json) || !isRecord(json.config)) return false;
  const selection = json.config.defaultModelSelection;
  return (
    isRecord(selection) &&
    typeof selection.providerId === "string" &&
    selection.providerId.startsWith(PROVIDER_ID_PREFIX)
  );
}

async function healthLine(port: number): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok ? "ok" : `http ${response.status}`;
  } catch {
    return "unreachable";
  }
}

function modelSummary(ids: readonly string[]): string {
  const shown = ids.slice(0, 8);
  const extra = ids.length - shown.length;
  if (shown.length === 0) return "";
  return extra > 0 ? `${shown.join(", ")}, … (${extra} more)` : shown.join(", ");
}
