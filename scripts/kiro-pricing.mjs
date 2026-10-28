#!/usr/bin/env node
// Check the fitted Kiro price constants against what Kiro bills now.
//
// Kiro publishes one number per model: `rate_multiplier`, from `kiro-cli chat --list-models`.
// The per-1k rates behind it (`KIRO_CREDIT_RATES` in cache-from-credits.ts) are fitted, so
// they cannot be downloaded. This script takes the live multipliers, replays every Kiro turn
// in the usage ledger through `deriveKiroCacheFromCredits`, and reports:
//
//   - a modeled model whose bills the constants no longer explain (Kiro repriced);
//   - an unmeasured model with enough turns to fit, with its measured floor and a verdict;
//   - catalog models the ledger has never seen (they need the live measurement protocol).
//
// It edits nothing. A constant is a measurement: a person reads this report, then edits
// cache-from-credits.ts and its fixtures by hand (see the comment above KIRO_CREDIT_RATES).
//
// Exit 0: every modeled model still fits. Exit 1: at least one drifted. Exit 2: no rates or no ledger.
//
// Usage: node scripts/kiro-pricing.mjs [--days N] [--min-turns N]
// Needs Node >= 22.18 (it imports the TypeScript source directly) and kiro-cli on PATH.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const { KIRO_CREDIT_RATES, KIRO_UNCAPPED_MODELS, deriveKiroCacheFromCredits, KIRO_MIN_PROMPT_TOKENS } = await import(
  pathToFileURL(join(ROOT, "packages/kiro-core/src/cache-from-credits.ts")).href
);

/** Share of a modeled model's turns the constants may refuse before the script calls it drift. */
const MAX_REFUSED = 0.15;
/** The measured warm floor may sit this far from `cachedPer1k` and still count as the same rate. */
const FLOOR_TOLERANCE = 0.1;
/** Turns below this prompt size are noise: the fixed per-request cost swamps the prompt term. */
const FIT_MIN_PROMPT = 20_000;
/** A turn whose output estimate is over this share of the bill says little about the prompt. */
const FIT_MAX_OUTPUT_SHARE = 0.1;

function parseArgs(argv) {
  const out = { days: undefined, minTurns: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = Number(argv[i + 1]);
    if ((flag === "--days" || flag === "--min-turns") && Number.isInteger(value) && value > 0) {
      if (flag === "--days") out.days = value;
      else out.minTurns = value;
      i += 1;
    } else {
      console.error(`unknown or incomplete argument ${flag}\nusage: kiro-pricing.mjs [--days N] [--min-turns N]`);
      process.exit(2);
    }
  }
  return out;
}

function liveRates() {
  let raw;
  try {
    raw = execFileSync("kiro-cli", ["chat", "--list-models", "--format", "json"], {
      encoding: "utf8",
      timeout: 15_000,
    });
  } catch (error) {
    console.error(`kiro-cli chat --list-models failed: ${error.message}`);
    process.exit(2);
  }
  const rates = new Map();
  for (const model of JSON.parse(raw).models ?? []) {
    if (typeof model.model_id !== "string" || !(model.rate_multiplier > 0)) continue;
    // Same id mapping as the catalog: 4.5 -> 4-5.
    const id = model.model_id.replace(/(\d)\.(\d)/g, "$1-$2");
    rates.set(id, { multiplier: model.rate_multiplier, unit: model.rate_unit });
  }
  return rates;
}

function readLedger(days) {
  const root = process.env.NS_BRIDGE_USAGE_DIR?.trim() || join(homedir(), ".ns-bridge", "usage");
  if (!existsSync(root)) {
    console.error(`no ledger at ${root}`);
    process.exit(2);
  }
  let folders = readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  if (days) folders = folders.slice(-days);
  const turns = [];
  for (const day of folders) {
    const dir = join(root, day, "kiro");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.vendor === "kiro" && typeof record.model === "string") turns.push(record);
        } catch {
          // A torn last line from a crashed process.
        }
      }
    }
  }
  return { turns, root, folders };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const pct = (n, d) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(0)}%`);
const rate = (n) => (n === undefined ? "-" : n.toPrecision(4));

function replay(model, rate, turns) {
  const counts = { exact: 0, capped: 0, refused: 0 };
  for (const turn of turns) {
    const derived = deriveKiroCacheFromCredits({
      model,
      promptTokens: turn.promptTokens,
      outputTokens: turn.output ?? 0,
      credits: turn.credits,
      rateMultiplier: rate.multiplier,
      creditUnit: turn.creditUnit,
    });
    if (!derived) counts.refused += 1;
    else if (derived.exact) counts.exact += 1;
    else counts.capped += 1;
  }
  return counts;
}

/** Normalised bill per 1k prompt tokens per multiplier unit, the figure the constants are fitted on. */
function normalised(turns, multiplier) {
  const values = [];
  for (const turn of turns) {
    if (!(turn.promptTokens >= FIT_MIN_PROMPT) || !(turn.credits > 0)) continue;
    const outputCredits = (turn.output ?? 0) * KIRO_CREDIT_RATES.perOutputToken * multiplier;
    if (outputCredits > turn.credits * FIT_MAX_OUTPUT_SHARE) continue;
    values.push({
      r: (turn.credits - outputCredits) / multiplier / (turn.promptTokens / 1000),
      first: turn.step === 1,
    });
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const rates = liveRates();
const { turns, root, folders } = readLedger(args.days);
if (turns.length === 0) {
  console.error(`no Kiro turns under ${root}`);
  process.exit(2);
}

const byModel = new Map();
for (const turn of turns) {
  if (!(turn.credits > 0) || !(turn.promptTokens >= KIRO_MIN_PROMPT_TOKENS)) continue;
  const list = byModel.get(turn.model) ?? [];
  list.push(turn);
  byModel.set(turn.model, list);
}

console.log(`# ledger ${root}, ${folders.length} day folders, ${turns.length} Kiro turns`);
console.log(
  `# constants: cached ${KIRO_CREDIT_RATES.cachedPer1k}, fresh ${KIRO_CREDIT_RATES.freshPer1k}, per 1k tokens per multiplier unit\n`,
);

let drifted = 0;
const rows = [];
const notes = [];
for (const [model, list] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
  const live = rates.get(model);
  const modeled =
    Object.hasOwn(KIRO_CREDIT_RATES.coldPer1k, model) || Object.hasOwn(KIRO_UNCAPPED_MODELS, model);
  if (!live) {
    rows.push([model, "-", modeled ? "modeled" : "unmeasured", String(list.length), "-", "-", "-", "-", "model not in kiro-cli"]);
    continue;
  }
  const counts = replay(model, live, list);
  const values = normalised(list, live.multiplier);
  const sorted = values.map((v) => v.r).sort((a, b) => a - b);
  const floor = sorted.length > 0 ? quantile(sorted, 0.03) : undefined;
  const floorFits = floor !== undefined && Math.abs(floor / KIRO_CREDIT_RATES.cachedPer1k - 1) <= FLOOR_TOLERANCE;

  let verdict;
  if (modeled) {
    const refused = counts.refused / list.length;
    if (refused > MAX_REFUSED || (sorted.length >= args.minTurns && !floorFits)) {
      verdict = "DRIFT: constants no longer explain the bills";
      drifted += 1;
    } else {
      verdict = "ok";
    }
  } else if (sorted.length < args.minTurns) {
    verdict = `unmeasured: ${sorted.length} usable turns, need ${args.minTurns}`;
  } else if (!floorFits) {
    verdict = "unmeasured: warm floor is not the cached rate, model does not follow the formula";
  } else {
    const first = values.filter((v) => v.first).map((v) => v.r).sort((a, b) => a - b);
    const cold = first.length >= 3 ? quantile(first, 0.5) : undefined;
    verdict = `fit candidate: floor matches cached${cold === undefined ? "" : `, cold first-turn median ${rate(cold)} (${first.length} turns)`}; verify by hand`;
    notes.push(model);
  }
  rows.push([
    model,
    String(live.multiplier),
    modeled ? "modeled" : "unmeasured",
    String(list.length),
    pct(counts.exact, list.length),
    pct(counts.capped, list.length),
    pct(counts.refused, list.length),
    rate(floor),
    verdict,
  ]);
}

const header = ["model", "mult", "state", "turns", "exact", "capped", "refused", "floor/1k", "verdict"];
const table = [header, ...rows];
const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)));
for (const row of table) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());

const unseen = [...rates.keys()].filter((id) => !byModel.has(id)).sort();
if (unseen.length > 0) {
  console.log(`\n# in kiro-cli, no ledger turns (need the live measurement protocol): ${unseen.join(", ")}`);
}
if (notes.length > 0) {
  console.log(`# fit candidates: ${notes.join(", ")}. Add to coldPer1k only after checking cold turns by hand.`);
}
if (drifted > 0) {
  console.log(`\n# ${drifted} modeled model(s) drifted. Re-measure, then edit KIRO_CREDIT_RATES and the fixtures.`);
  process.exit(1);
}
