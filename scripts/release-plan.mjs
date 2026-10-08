#!/usr/bin/env node
// ABOUTME: Lists the workspace packages whose package.json version is not on npm yet,
// ABOUTME: in dependency order, so publish.yml can release them without a broken window.
//
// Every package keeps its own version. A release is "bump the version in the
// package.json files that changed, push, then push one tag" — this script decides
// what that tag actually ships: every public package whose current version npm
// does not have, dependencies before dependents. Publishing a dependent before
// the exact version it pins would leave it briefly uninstallable.
//
//   node scripts/release-plan.mjs            # human-readable plan
//   node scripts/release-plan.mjs --json     # [{dir,name,version}] for CI
//   node scripts/release-plan.mjs --tag ns-kiro-core@0.3.9
//       exits non-zero unless that package is in the plan at that version

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const packagesDir = join(root, "packages");

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = join("packages", entry.name);
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    return { dir, manifest };
  })
  .filter(({ manifest }) => !manifest.private);

const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));

/** Workspace packages this one needs, at any dependency kind (bundled devDeps still order the build). */
function internalDeps(manifest) {
  const all = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
    ...manifest.devDependencies,
  };
  return Object.keys(all).filter((name) => byName.has(name));
}

function topoSort() {
  const ordered = [];
  const state = new Map();
  const visit = (name, trail) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new Error(`dependency cycle: ${[...trail, name].join(" -> ")}`);
    state.set(name, "visiting");
    for (const dep of internalDeps(byName.get(name).manifest)) visit(dep, [...trail, name]);
    state.set(name, "done");
    ordered.push(byName.get(name));
  };
  for (const name of [...byName.keys()].sort()) visit(name, []);
  return ordered;
}

function isPublished(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() === version;
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (stderr.includes("E404") || stderr.includes("404")) return false;
    throw new Error(`npm view ${name}@${version} failed: ${stderr || error.message}`);
  }
}

/** Tag names drop the npm scope: `@ngosangns/ns-pi-provider@0.2.3` is tagged `ns-pi-provider@0.2.3`. */
export function tagFor(name, version) {
  return `${name.replace(/^@[^/]+\//, "")}@${version}`;
}

/**
 * The commit a package's current version was released from: its tag when one
 * exists, else the last commit that touched its version line.
 */
function releaseBase(dir, manifest) {
  const tag = tagFor(manifest.name, manifest.version);
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    const out = execFileSync("git", ["log", "-1", "--format=%H", "-G", '"version"', "--", join(dir, "package.json")], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return out || undefined;
  }
}

/**
 * True when shipped code changed after the released version: a dependent packed
 * now would pin that version and get the old code, missing whatever it imports
 * from the new one. Tests and docs do not ship, so they do not count.
 */
function changedSinceRelease(dir, manifest) {
  const base = releaseBase(dir, manifest);
  if (!base) return true;
  try {
    execFileSync(
      "git",
      ["diff", "--quiet", base, "HEAD", "--", dir, `:!${dir}/test`, `:!${dir}/tests`, `:!${dir}/**/*.md`],
      { cwd: root },
    );
    return false;
  } catch {
    return true;
  }
}

const plan = topoSort()
  .filter(({ manifest }) => !isPublished(manifest.name, manifest.version))
  .map(({ dir, manifest }) => ({ dir, name: manifest.name, version: manifest.version, tag: tagFor(manifest.name, manifest.version) }));

// A pending package pinning a sibling that is published-but-stale would ship
// against code it was not built with. Refuse rather than publish it broken.
const pendingNames = new Set(plan.map((entry) => entry.name));
const stale = packages.filter(
  ({ dir, manifest }) => !pendingNames.has(manifest.name) && changedSinceRelease(dir, manifest),
);
const staleNames = new Set(stale.map(({ manifest }) => manifest.name));
const blockers = [];
for (const entry of plan) {
  const { manifest } = byName.get(entry.name);
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (staleNames.has(dep)) {
      blockers.push(
        `${entry.name}@${entry.version} depends on ${dep}, whose code changed since ${dep}@${byName.get(dep).manifest.version} was released; bump ${dep} too`,
      );
    }
  }
}

const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = args[tagIndex + 1];
  const match = plan.find((entry) => entry.tag === tag);
  if (!match) {
    const known = packages.find(({ manifest }) => tagFor(manifest.name, "") === tag.replace(/@[^@]*$/, "@"));
    console.error(
      known
        ? `::error::${tag} is not pending: ${known.manifest.name} is at ${known.manifest.version} in package.json` +
            (isPublished(known.manifest.name, known.manifest.version) ? " and that version is already on npm" : "")
        : `::error::${tag} names no public package in this workspace`,
    );
    process.exit(1);
  }
}

for (const blocker of blockers) console.error(`::error::${blocker}`);
if (!args.includes("--json")) {
  for (const { manifest } of stale) {
    console.error(`note: ${manifest.name}@${manifest.version} is on npm but its code changed since; bump it before the next release`);
  }
}
if (blockers.length > 0) process.exit(1);

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} else if (plan.length === 0) {
  console.log("nothing to publish: every public package's version is already on npm");
} else {
  console.log("would publish, in order:");
  for (const entry of plan) console.log(`  ${entry.name}@${entry.version}  (${entry.dir}, tag ${entry.tag})`);
}
