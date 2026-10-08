#!/usr/bin/env node
/**
 * Smoke: load dist/index.js under a real `omp models` with an isolated HOME
 * (never touches ~/.omp or ~/.pi). Expects `omp` on PATH and a prior `npm run build`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = join(root, "dist/index.js");
const home = mkdtempSync(join(tmpdir(), "ns-omp-smoke-"));
const agentDir = join(home, ".omp", "agent");

try {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), "# ns-omp-provider smoke\n");

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_CONFIG_DIR: ".omp",
    // Keep the smoke hermetic: no live credentials / binaries.
    GROK_BIN: join(home, "no-such-grok"),
  };
  for (const key of [
    "XAI_API_KEY",
    "GROK_API_KEY",
    "KIRO_API_KEY",
    "KIRO_ACCESS_TOKEN",
    "AMAZON_Q_TOKEN",
    "DEVIN_API_KEY",
    "DEVIN_SESSION_TOKEN",
    "WINDSURF_API_KEY",
  ]) {
    delete env[key];
  }

  const result = spawnSync("omp", ["models", "--no-extensions", "-e", entry, "--json"], {
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || `omp exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  const payload = JSON.parse(result.stdout);
  const models = Array.isArray(payload) ? payload : (payload.models ?? []);
  const byProvider = {};
  for (const model of models) {
    const provider = model.provider ?? model.providerId ?? "?";
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
  }
  // OMP reports extension load failures as warnings and keeps going, so prove
  // the extension ran: grok registers with a literal apiKey ("grok-cli") and
  // fallback models, so it is visible even with no credentials. (kiro/devin
  // are hidden by OMP until authenticated; tests/bundle.test.ts covers them.)
  if (!byProvider.grok || !byProvider["grok-sdk"]) {
    console.error(result.stderr);
    console.error(`smoke FAILED: grok provider missing; providers: ${JSON.stringify(byProvider)}`);
    process.exit(1);
  }
  if (/not found in module|Failed to load extension|registration failed/i.test(result.stderr)) {
    console.error(result.stderr);
    console.error("smoke FAILED: extension load errors on stderr");
    process.exit(1);
  }
  console.log(`smoke ok: ${models.length} model(s) visible; providers: ${JSON.stringify(byProvider)}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
