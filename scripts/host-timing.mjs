#!/usr/bin/env node
// Measure what ns-bridge adds to Pi, OMP, and DSH startup.
//
// Exit 0: five kept samples, medians inside the budgets below.
// Exit 1: a kept median missed a budget. The artifact dir still has the logs.
// Exit 2: the machine was too busy, a host was already open, or a sample never
//         became ready. Nothing is written when this happens before the first
//         sample. A spike after the directory exists discards that sample only.
//
// Numbers in the artifact are not source. Do not commit /tmp/ns-bridge-host-timing.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const SAMPLES = 5;
const EXTRA_ATTEMPTS = 3;
const BUDGET = {
  piRuntimeDeltaMs: 200,
  piImportMs: 150,
  piFactoryMs: 50,
  piSessionStartMs: 50,
  ompLoadExtensionsMs: 200,
  ompWallAfterPluginWalkMs: 400,
  dshListMs: 50,
  dshResolveMs: 50,
};

const PTY_PY = String.raw`
import json, os, pty, select, signal, sys, time
cfg = json.load(open(sys.argv[1]))
log = open(cfg["log"], "wb")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg["cwd"])
    env = os.environ.copy()
    env.update(cfg.get("env") or {})
    os.execvpe(cfg["cmd"], [cfg["cmd"], *cfg["args"]], env)
open(cfg["pidFile"], "w").write(str(pid))
start = time.monotonic()
ready_at = None
status = "exit"
exit_code = None
hay = b""
needle = cfg["ready"].encode()
try:
    while True:
        now = time.monotonic()
        if ready_at is None and now - start > cfg["timeout"]:
            os.kill(pid, signal.SIGKILL)
            status = "timeout"
            break
        if ready_at is not None and now - ready_at > cfg["grace"]:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.3)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            status = "hung"
            break
        readable, _, _ = select.select([fd], [], [], 0.2)
        if fd in readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            log.write(chunk)
            log.flush()
            if ready_at is None:
                hay = (hay + chunk)[-1000000:]
                if needle in hay:
                    ready_at = time.monotonic()
            continue
        wpid, st = os.waitpid(pid, os.WNOHANG)
        if wpid:
            exit_code = os.waitstatus_to_exitcode(st)
            break
finally:
    if exit_code is None:
        try:
            wpid, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wpid = 0
        if wpid:
            exit_code = os.waitstatus_to_exitcode(st)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                _, st = os.waitpid(pid, 0)
                exit_code = os.waitstatus_to_exitcode(st)
            except ChildProcessError:
                pass
    log.close()
end = time.monotonic()
json.dump({
    "status": status,
    "exitCode": exit_code,
    "ready": ready_at is not None,
    "hung": status == "hung",
    "wallReadyMs": None if ready_at is None else round((ready_at - start) * 1000),
    "wallExitMs": round((end - start) * 1000),
}, sys.stdout)
`;

function cores() {
  return typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
}

function load1() {
  return loadavg()[0];
}

function machineIsBusy() {
  return load1() >= cores();
}

function hostKind(command) {
  if (command.includes("host-timing.mjs")) return null;
  const exe = command.trim().split(/\s+/)[0] ?? "";
  const base = exe.split("/").pop();
  if (base === "pi") return "pi";
  if (base === "omp") return "omp";
  if (command.includes("@earendil-works/pi-coding-agent/dist/")) return "pi";
  if (command.includes("@oh-my-pi/pi-coding-agent/dist/cli.js")) return "omp";
  if (command.includes("DeepSeek Harness.app") || command.includes("DSH Computer Use.app")) return "dsh-desktop";
  return null;
}

function runningHosts() {
  const out = execFileSync("ps", ["-ax", "-o", "pid=", "-o", "command="], { encoding: "utf8" });
  const hits = [];
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const kind = hostKind(match[2]);
    if (!kind) continue;
    hits.push({ pid: Number(match[1]), kind, command: match[2].slice(0, 160) });
  }
  return hits;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseTimingLines(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
    const match = line.match(/^(.*?):\s*([\d.]+)ms\b(?:\s*\(self\s*([\d.]+)ms\))?(.*)$/);
    if (!match) continue;
    rows.push({
      label: match[1].trim(),
      ms: Number(match[2]),
      selfMs: match[3] === undefined ? null : Number(match[3]),
      rest: match[4].trim(),
    });
  }
  return rows;
}

function pick(rows, pred) {
  return rows.filter((row) => pred(row.label));
}

function runPty(dir, name, spec) {
  const log = join(dir, `${name}.log`);
  const pidFile = join(dir, `${name}.pid`);
  const cfg = join(dir, `${name}.pty.json`);
  writeFileSync(
    cfg,
    JSON.stringify({
      cmd: spec.cmd,
      args: spec.args,
      cwd: ROOT,
      env: spec.env,
      log,
      pidFile,
      ready: spec.ready,
      timeout: spec.timeout,
      grace: spec.grace,
    }),
  );
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", PTY_PY, cfg], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, (spec.timeout + spec.grace + 15) * 1000);
    child.on("close", () => {
      clearTimeout(killer);
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      resolve({ log, parsed, stderr, stdout });
    });
  });
}

function countPluginFiles(dir) {
  // -H enters the plugin symlink itself. Nested symlinks (workspace
  // node_modules into the pnpm store) stay as links, so the count is the
  // tree OMP can see without walking the store.
  try {
    const out = execFileSync("find", ["-H", "-x", dir], { encoding: "utf8" });
    const lines = out.split("\n").filter((line) => line.length > 0);
    return { dir, entries: lines.length, error: null };
  } catch (error) {
    return { dir, entries: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function keepSamples(dir, spec, accept) {
  const kept = [];
  const discarded = [];
  for (let attempt = 1; kept.length < SAMPLES && attempt <= SAMPLES + EXTRA_ATTEMPTS; attempt += 1) {
    const before = load1();
    if (before >= cores()) {
      discarded.push({ attempt, reason: "load-before", load: before });
      continue;
    }
    const name = `${spec.id}-${attempt}`;
    const run = await runPty(dir, name, spec);
    const after = load1();
    let text = "";
    try {
      text = readFileSync(run.log, "utf8");
    } catch {
      text = "";
    }
    const sample = {
      attempt,
      loadBefore: before,
      loadAfter: after,
      pty: run.parsed,
      stderr: run.stderr.slice(0, 500),
      rows: parseTimingLines(text),
    };
    if (after >= cores()) {
      discarded.push({ ...sample, reason: "load-after" });
      continue;
    }
    if (!run.parsed?.ready) {
      discarded.push({ ...sample, reason: run.parsed?.status ?? "no-ready" });
      continue;
    }
    const accepted = accept(sample);
    if (!accepted.ok) {
      discarded.push({ ...sample, reason: accepted.reason });
      continue;
    }
    kept.push({ ...sample, picked: accepted.picked });
  }
  return { kept, discarded };
}

function dshChildSource(devinHref, kiroHref) {
  return `
import { performance } from "node:perf_hooks";
const hang = () => new Promise(() => {});
const originalFetch = globalThis.fetch;
const fetches = [];
globalThis.fetch = (...args) => {
  fetches.push(String(args[0]));
  return new Promise(() => {});
};
const started = performance.now();
const devin = await import(${JSON.stringify(devinHref)});
const kiro = await import(${JSON.stringify(kiroHref)});
const importMs = performance.now() - started;
const ctx = {
  inject(_names, fn) { fn({ attachments: undefined, effect() {} }); },
  llm: { registerAdapter() {} },
};
devin.apply(ctx, { provider: "devin", displayName: "Devin" });
kiro.apply(ctx, { provider: "kiro", displayName: "Kiro" });
const applyFetches = fetches.length;
globalThis.fetch = originalFetch;
async function timed(run) {
  const start = performance.now();
  try {
    const value = await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);
    return { ms: performance.now() - start, ok: true, value };
  } catch (error) {
    return { ms: performance.now() - start, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
const devinAdapter = new devin.DevinAdapter({ provider: "devin", displayName: "Devin", credentials: hang });
const listed = await timed(() => devinAdapter.listModels("devin"));
const knownId = listed.ok && listed.value.length > 0 ? listed.value[0].id : "swe-1-6";
const resolved = await timed(() => devinAdapter.resolveModel("devin", knownId));
const kiroAdapter = new kiro.KiroAdapter({ provider: "kiro", displayName: "Kiro", credentials: hang });
const kiroListed = await timed(() => kiroAdapter.listModels("kiro"));
const kiroId = kiroListed.ok && kiroListed.value.length > 0 ? kiroListed.value[0].id : null;
const kiroResolved = kiroId ? await timed(() => kiroAdapter.resolveModel("kiro", kiroId)) : null;
process.stdout.write(JSON.stringify({
  importMs,
  applyFetches,
  devin: {
    listMs: listed.ms,
    listOk: listed.ok,
    count: listed.ok ? listed.value.length : 0,
    resolveMs: resolved.ms,
    resolveOk: resolved.ok,
    id: knownId,
    error: listed.error ?? resolved.error ?? null,
  },
  kiro: {
    listMs: kiroListed.ms,
    listOk: kiroListed.ok,
    count: kiroListed.ok ? kiroListed.value.length : 0,
    resolveMs: kiroResolved ? kiroResolved.ms : null,
    resolveOk: kiroResolved ? kiroResolved.ok : false,
    error: kiroListed.error ?? kiroResolved?.error ?? null,
  },
}));
`;
}

function runDshOnce(dir, name) {
  const devinHref = pathToFileURL(join(ROOT, "packages/dsh-llm-devin/dist/index.js")).href;
  const kiroHref = pathToFileURL(join(ROOT, "packages/dsh-llm-kiro/dist/index.js")).href;
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, dshChildSource(devinHref, kiroHref));
  return new Promise((resolve) => {
    const before = load1();
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      const after = load1();
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      resolve({ before, after, code, parsed, stderr: stderr.slice(0, 500) });
    });
  });
}

function verdict(ok, detail) {
  return { ok, detail };
}

function finish(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const coreCount = cores();
const initialLoad = load1();
process.stdout.write(`loadavg 1m=${initialLoad.toFixed(2)} cores=${coreCount}\n`);
if (machineIsBusy()) {
  finish(2, "exit 2: loadavg is at or above the core count, so this run would not be trustworthy");
}
const hosts = runningHosts();
if (hosts.length > 0) {
  const listed = hosts.map((hit) => `${hit.kind} pid ${hit.pid}`).join(", ");
  finish(2, `exit 2: a host is already open (${listed})`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join("/tmp/ns-bridge-host-timing", stamp);
mkdirSync(dir, { recursive: true });

const piBin = "/opt/homebrew/bin/pi";
const ompBin = join(homedir(), ".bun/bin/omp");
const pluginDirs = [
  join(homedir(), ".omp/plugins/node_modules/ns-omp-provider"),
  join(homedir(), ".omp/plugins/node_modules/ns-omp-provider-kiro"),
].map(countPluginFiles);
writeFileSync(join(dir, "plugin-files.json"), JSON.stringify(pluginDirs, null, 2));

const piEnv = { PI_TIMING: "1", PI_STARTUP_BENCHMARK: "1" };
const piBase = { cmd: piBin, cwd: ROOT, ready: "TOTAL:", timeout: 45, grace: 3, env: piEnv };
const ompBase = { cmd: ompBin, ready: "since first marker", timeout: 90, grace: 3, env: { PI_TIMING: "full" } };

process.stdout.write(`artifact ${dir}\n`);
process.stdout.write("sampling pi --no-extensions, pi, omp --no-extensions, omp, dsh in-process\n");

const piOff = await keepSamples(dir, { ...piBase, id: "pi-off", args: ["--no-session", "--no-extensions"] }, (sample) => {
  const runtime = pick(sample.rows, (label) => label === "createAgentSessionRuntime")[0];
  if (!runtime) return { ok: false, reason: "no-runtime" };
  return { ok: true, picked: { runtimeMs: runtime.ms, wallReadyMs: sample.pty.wallReadyMs, hung: sample.pty.hung } };
});
const piOn = await keepSamples(dir, { ...piBase, id: "pi-on", args: ["--no-session"] }, (sample) => {
  const runtime = pick(sample.rows, (label) => label === "createAgentSessionRuntime")[0];
  const imported = pick(sample.rows, (label) => label.includes("pi-provider") && label.includes("module import"))[0];
  const factory = pick(sample.rows, (label) => label.includes("pi-provider") && label.endsWith("factory"))[0];
  const sessionStart = pick(sample.rows, (label) => label.includes("session_start"));
  if (!runtime || !imported || !factory) return { ok: false, reason: "missing-pi-labels" };
  return {
    ok: true,
    picked: {
      runtimeMs: runtime.ms,
      importMs: imported.ms,
      factoryMs: factory.ms,
      sessionStartMs: sessionStart.map((row) => row.ms),
      wallReadyMs: sample.pty.wallReadyMs,
      hung: sample.pty.hung,
    },
  };
});
const ompOff = await keepSamples(
  dir,
  { ...ompBase, id: "omp-off", args: ["--no-session", "--no-extensions"] },
  (sample) => {
    const session = pick(sample.rows, (label) => label === "createAgentSession")[0];
    const before = pick(sample.rows, (label) => label === "(before instrumentation)")[0];
    if (!session) return { ok: false, reason: "no-createAgentSession" };
    return {
      ok: true,
      picked: {
        sessionMs: session.ms,
        beforeMs: before?.ms ?? null,
        wallReadyMs: sample.pty.wallReadyMs,
        plugins: pluginRows(sample.rows),
        modifiers: pick(sample.rows, (label) => label.includes("materializeModifier")).map((row) => row.label),
      },
    };
  },
);
const ompOn = await keepSamples(dir, { ...ompBase, id: "omp-on", args: ["--no-session"] }, (sample) => {
  const session = pick(sample.rows, (label) => label === "createAgentSession")[0];
  const extensions = pick(sample.rows, (label) => label === "loadExtensions")[0];
  const before = pick(sample.rows, (label) => label === "(before instrumentation)")[0];
  if (!session || !extensions) return { ok: false, reason: "missing-omp-labels" };
  return {
    ok: true,
    picked: {
      sessionMs: session.ms,
      loadExtensionsMs: extensions.ms,
      beforeMs: before?.ms ?? null,
      wallReadyMs: sample.pty.wallReadyMs,
      plugins: pluginRows(sample.rows),
      modifiers: pick(sample.rows, (label) => label.includes("materializeModifier")).map((row) => ({
        label: row.label,
        ms: row.ms,
      })),
    },
  };
});

function pluginRows(rows) {
  return rows
    .filter((row) => row.label.includes("omp-plugins"))
    .map((row) => ({ label: row.label, ms: row.ms }));
}

const dsh = [];
const dshDiscarded = [];
for (let attempt = 1; dsh.length < SAMPLES && attempt <= SAMPLES + EXTRA_ATTEMPTS; attempt += 1) {
  if (machineIsBusy()) {
    dshDiscarded.push({ attempt, reason: "load-before", load: load1() });
    continue;
  }
  const sample = await runDshOnce(dir, `dsh-${attempt}`);
  if (sample.after >= cores() || sample.before >= cores()) {
    dshDiscarded.push({ attempt, reason: "load", sample });
    continue;
  }
  if (!sample.parsed) {
    dshDiscarded.push({ attempt, reason: "no-json", code: sample.code, stderr: sample.stderr });
    continue;
  }
  dsh.push(sample.parsed);
  writeFileSync(join(dir, `dsh-${attempt}.json`), JSON.stringify(sample.parsed, null, 2));
}

const piRuntimeDelta = diff(median(piOn.kept.map((sample) => sample.picked.runtimeMs)), median(piOff.kept.map((sample) => sample.picked.runtimeMs)));
const piImport = median(piOn.kept.map((sample) => sample.picked.importMs));
const piFactory = median(piOn.kept.map((sample) => sample.picked.factoryMs));
const piSession = median(piOn.kept.flatMap((sample) => sample.picked.sessionStartMs));
const ompExtensions = median(ompOn.kept.map((sample) => sample.picked.loadExtensionsMs));
const ompWallDelta = diff(
  median(ompOn.kept.map((sample) => sample.picked.wallReadyMs)),
  median(ompOff.kept.map((sample) => sample.picked.wallReadyMs)),
);
const pluginWalk = pluginWalkMs(ompOff.kept, ompOn.kept);
const ompWallAfter = ompWallDelta === null || pluginWalk === null ? null : ompWallDelta - pluginWalk;
const modifiers = ompOn.kept.flatMap((sample) => sample.picked.modifiers);
const devinList = median(dsh.map((sample) => sample.devin.listMs));
const devinResolve = median(dsh.map((sample) => sample.devin.resolveMs));
const kiroList = median(dsh.map((sample) => sample.kiro.listMs));
const kiroResolve = median(dsh.map((sample) => (sample.kiro.resolveMs ?? Number.NaN)));
const applyFetches = dsh.reduce((sum, sample) => sum + sample.applyFetches, 0);

const enough =
  piOff.kept.length >= SAMPLES &&
  piOn.kept.length >= SAMPLES &&
  ompOff.kept.length >= SAMPLES &&
  ompOn.kept.length >= SAMPLES &&
  dsh.length >= SAMPLES;

const checks = [
  verdict(modifiers.length === 0, `materializeModifier rows: ${modifiers.length}`),
  verdict(piRuntimeDelta !== null && piRuntimeDelta <= BUDGET.piRuntimeDeltaMs, `pi runtime delta ${fmt(piRuntimeDelta)}ms`),
  verdict(piImport !== null && piImport <= BUDGET.piImportMs, `pi provider import ${fmt(piImport)}ms`),
  verdict(piFactory !== null && piFactory <= BUDGET.piFactoryMs, `pi provider factory ${fmt(piFactory)}ms`),
  verdict(piSession === null || piSession <= BUDGET.piSessionStartMs, `pi session_start ${piSession === null ? "not reported" : `${fmt(piSession)}ms`}`),
  verdict(ompExtensions !== null && ompExtensions <= BUDGET.ompLoadExtensionsMs, `omp loadExtensions ${fmt(ompExtensions)}ms`),
  verdict(
    ompWallAfter !== null && ompWallAfter <= BUDGET.ompWallAfterPluginWalkMs,
    `omp wall delta ${fmt(ompWallDelta)}ms minus plugin walk ${fmt(pluginWalk)}ms = ${fmt(ompWallAfter)}ms`,
  ),
  verdict(devinList !== null && devinList <= BUDGET.dshListMs && devinResolve !== null && devinResolve <= BUDGET.dshResolveMs, `dsh devin list ${fmt(devinList)}ms resolve ${fmt(devinResolve)}ms`),
  verdict(kiroList !== null && kiroList <= BUDGET.dshListMs && kiroResolve !== null && kiroResolve <= BUDGET.dshResolveMs, `dsh kiro list ${fmt(kiroList)}ms resolve ${fmt(kiroResolve)}ms`),
  verdict(applyFetches === 0, `dsh apply fetch calls ${applyFetches}`),
];

const summary = {
  loadAtStart: initialLoad,
  cores: coreCount,
  budgets: BUDGET,
  kept: {
    piOff: piOff.kept.length,
    piOn: piOn.kept.length,
    ompOff: ompOff.kept.length,
    ompOn: ompOn.kept.length,
    dsh: dsh.length,
  },
  hung: {
    piOff: piOff.kept.filter((sample) => sample.picked.hung).length,
    piOn: piOn.kept.filter((sample) => sample.picked.hung).length,
  },
  pluginFiles: pluginDirs,
  pi: { runtimeDeltaMs: piRuntimeDelta, importMs: piImport, factoryMs: piFactory, sessionStartMs: piSession },
  omp: {
    loadExtensionsMs: ompExtensions,
    wallDeltaMs: ompWallDelta,
    pluginWalkMs: pluginWalk,
    wallAfterPluginWalkMs: ompWallAfter,
    materializeModifier: modifiers,
  },
  dsh: { devinListMs: devinList, devinResolveMs: devinResolve, kiroListMs: kiroList, kiroResolveMs: kiroResolve },
  checks,
  discarded: {
    piOff: piOff.discarded.length,
    piOn: piOn.discarded.length,
    ompOff: ompOff.discarded.length,
    ompOn: ompOn.discarded.length,
    dsh: dshDiscarded.length,
  },
};
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
for (const line of checks) process.stdout.write(`${line.ok ? "ok" : "over"}  ${line.detail}\n`);
process.stdout.write(`samples kept pi-off=${piOff.kept.length} pi-on=${piOn.kept.length} omp-off=${ompOff.kept.length} omp-on=${ompOn.kept.length} dsh=${dsh.length}\n`);
if (!enough) finish(2, "exit 2: fewer than five kept samples");
if (checks.some((line) => !line.ok)) finish(1, "exit 1: a median is outside the budget");
finish(0, "exit 0: medians are inside the budget");

function fmt(value) {
  return value === null || Number.isNaN(value) ? "n/a" : value.toFixed(1);
}

function diff(on, off) {
  if (on === null || off === null) return null;
  return on - off;
}

function pluginWalkMs(offKept, onKept) {
  const off = new Map();
  for (const sample of offKept) {
    for (const row of sample.picked.plugins) {
      const list = off.get(row.label) ?? [];
      list.push(row.ms);
      off.set(row.label, list);
    }
  }
  const on = new Map();
  for (const sample of onKept) {
    for (const row of sample.picked.plugins) {
      const list = on.get(row.label) ?? [];
      list.push(row.ms);
      on.set(row.label, list);
    }
  }
  let peak = 0;
  for (const [label, values] of on) {
    const delta = (median(values) ?? 0) - (median(off.get(label) ?? []) ?? 0);
    if (delta > peak) peak = delta;
  }
  return peak;
}
