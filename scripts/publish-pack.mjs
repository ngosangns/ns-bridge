#!/usr/bin/env node
// Packs the release plan into ./tarballs and refuses a manifest that would
// publish a workspace: range or a repository url npm would reject.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedRepo = "https://github.com/ngosangns/ns-bridge";

export function manifestProblems(manifest, { file, pending, siblings, npmHas }) {
  const problems = [];
  const url = ((manifest.repository || {}).url || "").replace(/^git\+/, "").replace(/\.git$/, "");
  if (url !== expectedRepo) problems.push(`${file} declares repository "${url}", expected ${expectedRepo}`);
  const runtime = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  const optionalPeers = new Set(
    Object.entries(manifest.peerDependenciesMeta || {})
      .filter(([, meta]) => meta && meta.optional)
      .map(([dep]) => dep),
  );
  for (const [dep, range] of Object.entries(runtime)) {
    if (String(range).startsWith("workspace:")) {
      problems.push(`${file} still carries ${dep}@${range}`);
      continue;
    }
    if (optionalPeers.has(dep) && !(manifest.dependencies || {})[dep] && !(manifest.optionalDependencies || {})[dep]) {
      continue;
    }
    if (!dep.startsWith("ns-") && !dep.startsWith("@ngosangns/")) continue;
    if (pending.has(`${dep}@${range}`)) continue;
    if (npmHas(dep, range)) continue;
    if (!siblings.has(dep)) problems.push(`${file} pins ${dep}@${range}, which is neither on npm nor in this run`);
  }
  return problems;
}

function npmHas(dep, range) {
  try {
    execFileSync("npm", ["view", `${dep}@${range}`, "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const plan = JSON.parse(
    execFileSync(process.execPath, ["scripts/release-plan.mjs", "--json"], { cwd: root, encoding: "utf8" }),
  );
  if (plan.length === 0) {
    console.error("nothing to publish: every public package's version is already on npm");
    process.exit(1);
  }

  const out = join(root, "tarballs");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);

  for (const entry of plan) {
    execFileSync("pnpm", ["pack", "--pack-destination", out], {
      cwd: join(root, entry.dir),
      stdio: "inherit",
    });
  }

  const pending = new Set(plan.map((entry) => `${entry.name}@${entry.version}`));
  const siblings = new Set(plan.map((entry) => entry.name));
  let failures = 0;

  for (const file of readdirSync(out)) {
    if (!file.endsWith(".tgz")) continue;
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", join(out, file), "package/package.json"], { encoding: "utf8" }),
    );
    const problems = manifestProblems(manifest, { file, pending, siblings, npmHas });
    for (const problem of problems) console.error(problem);
    if (problems.length === 0) console.log(`${file}: ok`);
    failures += problems.length;
  }

  if (failures > 0) process.exit(1);
  writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan)}\n`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) main();
