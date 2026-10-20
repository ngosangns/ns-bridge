#!/usr/bin/env node
// Where does wall-clock time go in DeepSeek Harness (dsh) sessions?
//
// Reads ~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd (needs `zstdcat`),
// skips archived sessions (~/.dsh/storages/workspace.json .global.archivedSessionIds),
// and prints per-session and aggregate timing: model TTFT/streaming, tool time by name,
// compaction count/duration/tokens, retries/errors, redundant tool calls, tool output size,
// turns without edits and time to first edit.
//
// Usage:
//   node scripts/dsh-trajectory.mjs [--since-hours 24] [--ids 431826bf,b09bd7c6] [--loaded] [--json out.json]
//   --loaded  only sessions whose session.lock the running app holds open (lsof)
//
// Every interval between two consecutive events is charged to exactly one bucket, so the
// buckets add up to the session's wall time:
//   model       request sent (step start / header / retry start) → assistant message
//   tool        tool/call → tool/result (as the log orders them)
//   compaction  compaction/start → compaction/end (an LLM summary call inside dsh)
//   idle        turn/end → next turn/start (waiting for the user)
//   harness     everything else (dsh bookkeeping between events)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : dflt;
};
const DSH = opt("dsh-home", join(homedir(), ".dsh"));
const SINCE_H = Number(opt("since-hours", 24));
const IDS = String(opt("ids", "") || "").split(",").filter(Boolean);
const LOADED = args.includes("--loaded");
const JSON_OUT = opt("json", "");

const MUTATING = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit"]);
const MUTATING_BASH = /\b(git (commit|apply|mv|rm)|sed -i|perl -pi|mv |cp |rm |tee |cat >|> ?[\w./~-]+\.(\w+))/;

export function loadArchived(dsh = DSH) {
  try {
    const ws = JSON.parse(readFileSync(join(dsh, "storages", "workspace.json"), "utf8"));
    return new Set((ws?.global?.archivedSessionIds ?? []).map((id) => String(id).replace(/^session-/, "")));
  } catch {
    return new Set();
  }
}

function loadedLocks() {
  try {
    const pid = execFileSync("pgrep", ["-f", "MacOS/DeepSeek Harness --expose-internals"], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    const out = execFileSync("lsof", ["-p", pid], { encoding: "utf8", maxBuffer: 64 << 20 });
    return new Set([...out.matchAll(/session-([0-9a-f-]{36})\/session\.lock/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

function listSessions() {
  const root = join(DSH, "sessions");
  const archived = loadArchived();
  const loaded = LOADED ? loadedLocks() : null;
  const out = [];
  for (const slug of readdirSync(root)) {
    let dirs;
    try {
      dirs = readdirSync(join(root, slug));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const m = /^session-([0-9a-f-]{36})$/.exec(d);
      if (!m) continue;
      const id = m[1];
      if (archived.has(id)) continue;
      if (loaded && !loaded.has(id)) continue;
      if (IDS.length && !IDS.some((p) => id.startsWith(p))) continue;
      const file = join(root, slug, d, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      out.push({ id, slug, file });
    }
  }
  return out;
}

function readEvents(file) {
  const text = execFileSync("zstdcat", ["--", file], { encoding: "utf8", maxBuffer: 1 << 29 });
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

const textLen = (content) =>
  Array.isArray(content) ? content.reduce((n, c) => n + (typeof c?.text === "string" ? c.text.length : 0), 0) : 0;

function streamBounds(stream) {
  let first = Infinity;
  let last = -Infinity;
  for (const s of stream ?? []) {
    const t = s.time ?? s.time0;
    if (typeof t !== "number") continue;
    first = Math.min(first, t);
    let end = t;
    if (Array.isArray(s.dt)) end = t + s.dt.reduce((a, b) => a + b, 0);
    last = Math.max(last, end);
  }
  return Number.isFinite(first) ? { first, last } : null;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

export function analyse(events, meta = {}) {
  const r = {
    id: meta.id,
    slug: meta.slug,
    title: "",
    model: "",
    buckets: { model: 0, tool: 0, compaction: 0, idle: 0, harness: 0 },
    wallMs: 0,
    activeMs: 0,
    turns: 0,
    steps: 0,
    requests: [],
    tools: {},
    toolOutChars: 0,
    toolOutSizes: [],
    toolErrors: {},
    compactions: { count: 0, failed: 0, ms: 0, summaryOutTokens: 0, shadowedTokens: 0, prunes: 0, failReasons: {} },
    retries: { count: 0, delayMs: 0, codes: {} },
    turnEnds: {},
    turnsWithoutEdit: 0,
    firstEditMs: null,
    redundant: { reads: 0, readFiles: 0, greps: 0, bash: 0, worst: [] },
    titleMs: 0,
    inputTokens: [],
  };
  if (!events.length) return r;
  const timed = events.filter((e) => typeof e.time === "number");
  const t0 = timed[0]?.time ?? 0;
  r.wallMs = (timed.at(-1)?.time ?? t0) - t0;

  // --- interval bucketing ---------------------------------------------------
  let state = "harness";
  let compDepth = 0;
  const openCalls = new Map();
  let prevTime = t0;
  let turnStart = null;
  let turnEdited = false;
  let firstTurnStart = null;
  let lastReqStart = null;
  let compactedSinceLastRequest = false;
  const callArgs = new Map();
  const readCount = new Map();
  const grepCount = new Map();
  const bashCount = new Map();
  const compStart = new Map();

  for (const e of events) {
    const t = e.time;
    if (typeof t === "number") {
      r.buckets[state] += Math.max(0, t - prevTime);
      prevTime = t;
    }
    const d = e.data ?? {};
    switch (e.type) {
      case "session/title":
        r.title = d.title ?? r.title;
        break;
      case "model/selection":
        r.model = `${d.provider}/${d.model}`;
        break;
      case "turn/start":
        r.turns++;
        turnStart = t;
        turnEdited = false;
        firstTurnStart ??= t;
        state = "harness";
        break;
      case "turn/end": {
        const k = d.reason?.kind ?? "unknown";
        r.turnEnds[k] = (r.turnEnds[k] ?? 0) + 1;
        if (!turnEdited) r.turnsWithoutEdit++;
        if (turnStart != null) r.activeMs += t - turnStart;
        turnStart = null;
        state = "idle";
        break;
      }
      case "step/start":
        r.steps++;
        lastReqStart = t;
        if (!compDepth) state = "model";
        break;
      case "request/header":
      case "llm/retry-started":
        lastReqStart = t;
        if (!compDepth) state = "model";
        break;
      case "llm/retry": {
        r.retries.count++;
        r.retries.delayMs += d.delayMs ?? 0;
        const c = d.failure?.code ?? "?";
        r.retries.codes[c] = (r.retries.codes[c] ?? 0) + 1;
        break;
      }
      case "assistant/message": {
        const b = streamBounds(d.stream);
        const u = d.usage ?? {};
        const req = {
          step: d.step,
          start: lastReqStart,
          end: t,
          ttft: b && lastReqStart != null ? b.first - lastReqStart : null,
          streamMs: b ? t - b.first : null,
          totalMs: lastReqStart != null ? t - lastReqStart : null,
          input: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
          cacheRead: u.cacheReadTokens ?? 0,
          output: u.outputTokens ?? 0,
          toolCalls: (d.message?.content ?? []).filter((c) => c.type === "tool-call").length,
          afterCompaction: compactedSinceLastRequest,
        };
        compactedSinceLastRequest = false;
        r.requests.push(req);
        r.inputTokens.push(req.input);
        state = "harness";
        break;
      }
      case "tool/call": {
        openCalls.set(d.callId, { name: d.name, t });
        callArgs.set(d.callId, d.arguments);
        state = "tool";
        let a = {};
        try {
          a = JSON.parse(d.arguments ?? "{}");
        } catch {}
        const mutBash = d.name === "bash" && MUTATING_BASH.test(String(a.command ?? ""));
        if (MUTATING.has(d.name) || mutBash) {
          turnEdited = true;
          if (r.firstEditMs == null && firstTurnStart != null) r.firstEditMs = t - firstTurnStart;
        }
        if (d.name === "read") {
          const k = `${a.path ?? a.file_path}#${a.offset ?? ""}:${a.limit ?? ""}`;
          readCount.set(k, (readCount.get(k) ?? 0) + 1);
          const f = String(a.path ?? a.file_path);
          readCount.set(`FILE:${f}`, (readCount.get(`FILE:${f}`) ?? 0) + 1);
        } else if (d.name === "grep" || d.name === "glob") {
          const k = `${d.name}:${a.pattern}@${a.path ?? ""}:${a.include ?? a.glob ?? ""}`;
          grepCount.set(k, (grepCount.get(k) ?? 0) + 1);
        } else if (d.name === "bash") {
          const k = String(a.command ?? "").slice(0, 200);
          bashCount.set(k, (bashCount.get(k) ?? 0) + 1);
        }
        break;
      }
      case "tool/result": {
        const id = d.message?.toolCallId;
        const open = openCalls.get(id);
        const size = textLen(d.message?.content);
        if (open) {
          openCalls.delete(id);
          const s = (r.tools[open.name] ??= { calls: 0, ms: 0, outChars: 0, errors: 0, durations: [] });
          s.calls++;
          s.ms += t - open.t;
          s.durations.push(t - open.t);
          s.outChars += size;
          r.toolOutChars += size;
          r.toolOutSizes.push(size);
          if (d.message?.isError) {
            s.errors++;
            const code = d.error?.code ?? "isError";
            r.toolErrors[code] = (r.toolErrors[code] ?? 0) + 1;
          }
        }
        if (!openCalls.size && !compDepth) state = "harness";
        break;
      }
      case "compaction/start":
        compDepth++;
        compStart.set(d.compactionId, t);
        state = "compaction";
        r.compactions.count++;
        break;
      case "compaction/summary":
        compactedSinceLastRequest = true;
        r.compactions.summaryOutTokens += d.usage?.outputTokens ?? 0;
        r.compactions.shadowedTokens += d.shadowedTokenCount ?? 0;
        break;
      case "compaction/prune":
        r.compactions.prunes++;
        break;
      case "compaction/end": {
        compDepth = Math.max(0, compDepth - 1);
        const s = compStart.get(d.compactionId);
        if (s != null) r.compactions.ms += t - s;
        if (d.error) {
          r.compactions.failed++;
          const k = String(d.error).replace(/\d+/g, "N").slice(0, 90);
          r.compactions.failReasons[k] = (r.compactions.failReasons[k] ?? 0) + 1;
        }
        if (!compDepth) state = "harness";
        break;
      }
      case "session/title-llm-request":
        r._titleReq = t;
        break;
      default:
        break;
    }
  }
  if (turnStart != null) r.activeMs += prevTime - turnStart; // still running

  const dup = (m, filter = () => true) => [...m].filter(([k, n]) => n > 1 && filter(k)).map(([k, n]) => [k, n]);
  const readDups = dup(readCount, (k) => !k.startsWith("FILE:"));
  const fileDups = dup(readCount, (k) => k.startsWith("FILE:"));
  r.redundant.reads = sum(readDups.map(([, n]) => n - 1));
  r.redundant.readFiles = sum(fileDups.map(([, n]) => n - 1));
  r.redundant.greps = sum(dup(grepCount).map(([, n]) => n - 1));
  r.redundant.bash = sum(dup(bashCount).map(([, n]) => n - 1));
  r.redundant.worst = [...fileDups, ...dup(grepCount), ...dup(bashCount)]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, n]) => `${n}× ${k.replace(/^FILE:/, "read ").slice(0, 110)}`);
  return r;
}

function fmtS(ms) {
  if (ms == null) return "-";
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
}

export function summarise(r) {
  const ttfts = r.requests.map((q) => q.ttft).filter((x) => x != null && x >= 0).sort((a, b) => a - b);
  const streams = r.requests.map((q) => q.streamMs).filter((x) => x != null && x >= 0).sort((a, b) => a - b);
  const totals = r.requests.map((q) => q.totalMs).filter((x) => x != null && x >= 0);
  const outs = r.requests.map((q) => q.output);
  const inputs = [...r.inputTokens].sort((a, b) => a - b);
  const hit = (qs) => sum(qs.map((q) => q.cacheRead)) / Math.max(1, sum(qs.map((q) => q.input)));
  const cacheHit = hit(r.requests);
  const steady = r.requests.filter((q) => !q.afterCompaction);
  const afterComp = r.requests.filter((q) => q.afterCompaction);
  const ttftOf = (qs) => {
    const v = qs.map((q) => q.ttft).filter((x) => x != null && x >= 0).sort((a, b) => a - b);
    return pct(v, 50);
  };
  const work = r.buckets.model + r.buckets.tool + r.buckets.compaction + r.buckets.harness;
  return {
    id: r.id.slice(0, 8),
    title: r.title,
    model: r.model,
    wall: r.wallMs,
    work,
    share: Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, work ? v / work : 0])),
    buckets: r.buckets,
    turns: r.turns,
    steps: r.steps,
    requests: r.requests.length,
    ttftP50: pct(ttfts, 50),
    ttftP90: pct(ttfts, 90),
    streamP50: pct(streams, 50),
    reqTotal: sum(totals),
    ttftTotal: sum(ttfts),
    outTokPerS: sum(outs) / Math.max(1, sum(streams) / 1000),
    inputP50: pct(inputs, 50),
    inputMax: inputs.at(-1) ?? 0,
    cacheHit,
    cacheHitSteady: hit(steady),
    cacheHitAfterCompaction: hit(afterComp),
    requestsAfterCompaction: afterComp.length,
    ttftSteadyP50: ttftOf(steady),
    ttftAfterCompactionP50: ttftOf(afterComp),
    tools: r.tools,
    toolOutChars: r.toolOutChars,
    toolOutP90: pct([...r.toolOutSizes].sort((a, b) => a - b), 90),
    toolErrors: r.toolErrors,
    compactions: r.compactions,
    retries: r.retries,
    turnEnds: r.turnEnds,
    turnsWithoutEdit: r.turnsWithoutEdit,
    firstEditMs: r.firstEditMs,
    redundant: r.redundant,
  };
}

function main() {
  const cutoff = Date.now() - SINCE_H * 3600e3;
  const rows = [];
  for (const s of listSessions()) {
    const events = readEvents(s.file);
    const last = events.findLast((e) => typeof e.time === "number")?.time ?? 0;
    if (!IDS.length && last < cutoff) continue;
    if (!events.some((e) => e.type === "assistant/message")) continue;
    rows.push(summarise(analyse(events, s)));
  }
  rows.sort((a, b) => b.work - a.work);

  const p = (s) => process.stdout.write(`${s}\n`);
  p(`sessions: ${rows.length} (non-archived${LOADED ? ", loaded" : ""}, ${IDS.length ? "by id" : `active in last ${SINCE_H}h`})\n`);
  p("id       work    model%  tool%  compact%  harness%  reqs  TTFTp50  TTFTp90  stream50  tok/s  ctxP50  cache%  comp(fail)  comp time  retries  1st edit  title");
  for (const r of rows) {
    p(
      [
        r.id,
        fmtS(r.work).padStart(6),
        `${(r.share.model * 100).toFixed(0)}%`.padStart(6),
        `${(r.share.tool * 100).toFixed(0)}%`.padStart(5),
        `${(r.share.compaction * 100).toFixed(0)}%`.padStart(8),
        `${(r.share.harness * 100).toFixed(0)}%`.padStart(8),
        String(r.requests).padStart(5),
        fmtS(r.ttftP50).padStart(7),
        fmtS(r.ttftP90).padStart(7),
        fmtS(r.streamP50).padStart(8),
        r.outTokPerS.toFixed(0).padStart(5),
        `${(r.inputP50 / 1000).toFixed(0)}k`.padStart(6),
        `${(r.cacheHit * 100).toFixed(0)}%`.padStart(6),
        `${r.compactions.count}(${r.compactions.failed})`.padStart(10),
        fmtS(r.compactions.ms).padStart(9),
        String(r.retries.count).padStart(7),
        fmtS(r.firstEditMs).padStart(8),
        ` ${r.model} ${r.title}`.slice(0, 60),
      ].join("  "),
    );
  }

  // aggregate
  const agg = { model: 0, tool: 0, compaction: 0, harness: 0, idle: 0 };
  const tools = {};
  const toolErr = {};
  const failReasons = {};
  const retryCodes = {};
  let reqs = 0;
  let ttftTotal = 0;
  let reqTotal = 0;
  let comps = 0;
  let compFail = 0;
  let compMs = 0;
  let compOut = 0;
  let shadow = 0;
  let noEdit = 0;
  let turns = 0;
  let red = { reads: 0, readFiles: 0, greps: 0, bash: 0 };
  let outChars = 0;
  for (const r of rows) {
    for (const k of Object.keys(agg)) agg[k] += r.buckets[k];
    for (const [n, s] of Object.entries(r.tools)) {
      const a = (tools[n] ??= { calls: 0, ms: 0, outChars: 0, errors: 0, durations: [] });
      a.calls += s.calls;
      a.ms += s.ms;
      a.outChars += s.outChars;
      a.errors += s.errors;
      a.durations.push(...s.durations);
    }
    for (const [k, v] of Object.entries(r.toolErrors)) toolErr[k] = (toolErr[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.compactions.failReasons)) failReasons[k] = (failReasons[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.retries.codes)) retryCodes[k] = (retryCodes[k] ?? 0) + v;
    reqs += r.requests;
    ttftTotal += r.ttftTotal;
    reqTotal += r.reqTotal;
    comps += r.compactions.count;
    compFail += r.compactions.failed;
    compMs += r.compactions.ms;
    compOut += r.compactions.summaryOutTokens;
    shadow += r.compactions.shadowedTokens;
    noEdit += r.turnsWithoutEdit;
    turns += r.turns;
    outChars += r.toolOutChars;
    for (const k of Object.keys(red)) red[k] += r.redundant[k];
  }
  const work = agg.model + agg.tool + agg.compaction + agg.harness;
  p(`\n== aggregate (busy time ${fmtS(work)}, idle waiting for user ${fmtS(agg.idle)}) ==`);
  for (const k of ["model", "compaction", "tool", "harness"])
    p(`  ${k.padEnd(11)} ${fmtS(agg[k]).padStart(8)}  ${((agg[k] / Math.max(1, work)) * 100).toFixed(1)}%`);
  p(
    `  model requests ${reqs}: TTFT total ${fmtS(ttftTotal)} (${((ttftTotal / Math.max(1, reqTotal)) * 100).toFixed(0)}% of request time), streaming ${fmtS(reqTotal - ttftTotal)}`,
  );
  p(
    `  compactions ${comps} (${compFail} failed), ${fmtS(compMs)} total, avg ${fmtS(compMs / Math.max(1, comps))}; summary output ${compOut} tok for ${shadow} shadowed tok`,
  );
  for (const [k, v] of Object.entries(failReasons)) p(`    failed: ${v}× ${k}`);
  p(`  retries: ${JSON.stringify(retryCodes)}`);
  p(`  turns without an edit: ${noEdit}/${turns}`);
  p(
    `  redundant: ${red.reads} exact re-reads, ${red.readFiles} same-file re-reads, ${red.greps} repeated grep/glob, ${red.bash} repeated bash`,
  );
  p(`  tool output: ${(outChars / 1e6).toFixed(1)}M chars (~${((outChars / 4) / 1e3).toFixed(0)}k tokens)`);
  p("\n  tool        calls   total    p50     p90    max    out(k chars)  errors");
  for (const [n, s] of Object.entries(tools).sort((a, b) => b[1].ms - a[1].ms).slice(0, 15)) {
    const ds = s.durations.sort((a, b) => a - b);
    p(
      `  ${n.slice(0, 10).padEnd(10)} ${String(s.calls).padStart(6)} ${fmtS(s.ms).padStart(7)} ${fmtS(pct(ds, 50)).padStart(6)} ${fmtS(pct(ds, 90)).padStart(7)} ${fmtS(ds.at(-1)).padStart(6)} ${(s.outChars / 1000).toFixed(0).padStart(12)} ${String(s.errors).padStart(7)}`,
    );
  }
  p(`  tool errors: ${JSON.stringify(toolErr)}`);
  p("\n== prompt cache: steady requests vs first request after a compaction ==");
  p("  id        steady hit  TTFT p50   after-comp n  hit   TTFT p50");
  for (const r of rows)
    p(
      `  ${r.id}  ${`${(r.cacheHitSteady * 100).toFixed(0)}%`.padStart(9)}  ${fmtS(r.ttftSteadyP50).padStart(8)}   ${String(r.requestsAfterCompaction).padStart(11)}  ${`${(r.cacheHitAfterCompaction * 100).toFixed(0)}%`.padStart(4)}  ${fmtS(r.ttftAfterCompactionP50).padStart(8)}`,
    );
  p("\n== redundancy hot spots ==");
  for (const r of rows) if (r.redundant.worst.length) p(`  ${r.id}: ${r.redundant.worst.slice(0, 3).join(" | ")}`);
  if (JSON_OUT) {
    for (const r of rows) for (const s of Object.values(r.tools)) delete s.durations;
    writeFileSync(JSON_OUT, JSON.stringify({ rows, agg }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
