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
// The six ns-bridge-bin packages (the resolver + five platform binaries) ship
// together at one version: the script refuses mismatched versions, and treats
// a change under go/ as a change to all six (it is what their tarballs carry).
// Topological order already puts the platform packages before ns-bridge-bin,
// whose optionalDependencies pin them.
//
// A package npm has never seen is left out of the CI plan with a warning:
// trusted publishing cannot create a package, so its first version is
// published by hand (2FA) and its trusted publisher registered afterwards.
// A planned package that depends on one is refused until then.
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

/** The six packages that carry the Go sidecar; they ship at one version. */
const BINARY_PACKAGE_DIRS = new Set([
  "packages/bridge-bin",
  "packages/bridge-bin-darwin-arm64",
  "packages/bridge-bin-darwin-x64",
  "packages/bridge-bin-linux-arm64",
  "packages/bridge-bin-linux-x64",
  "packages/bridge-bin-win32-x64",
]);

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = join("packages", entry.name);
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    return { dir, manifest };
  })
  .filter(({ manifest }) => !manifest.private);

const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const binaryPackages = packages.filter(({ dir }) => BINARY_PACKAGE_DIRS.has(dir));

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

/**
 * Whether npm has any version of `name`. Trusted publishing (OIDC) cannot
 * create a package: its first version must be published by hand (with the
 * account's 2FA), and the trusted publisher registered afterwards.
 */
function existsOnNpm(name) {
  try {
    execFileSync("npm", ["view", name, "name"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (stderr.includes("E404") || stderr.includes("404")) return false;
    throw new Error(`npm view ${name} failed: ${stderr || error.message}`);
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
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    }).trim();
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
 *
 * For the binary packages, a change under go/ (or the build script) counts as
 * a change to every one of them: that is what the published tarball actually
 * contains.
 */
function changedSinceRelease(dir, manifest) {
  const base = releaseBase(dir, manifest);
  if (!base) return true;
  const paths = [dir, `:!${dir}/test`, `:!${dir}/tests`, `:!${dir}/**/*.md`];
  if (BINARY_PACKAGE_DIRS.has(dir)) {
    paths.push("go", "scripts/build-sidecar.mjs");
  }
  try {
    execFileSync("git", ["diff", "--quiet", base, "HEAD", "--", ...paths], { cwd: root });
    return false;
  } catch {
    return true;
  }
}

/**
 * The binary packages share one version and ship together. Refuse a plan that
 * would split them: mismatched versions, or some of the six pending while
 * others are already on npm at that version.
 *
 * A go/ change after a release marks all six stale (see changedSinceRelease);
 * like any stale package that is a note, and a blocker for whatever pins
 * ns-bridge-bin in the plan.
 */
function checkBinaryLockstep(plan) {
  if (binaryPackages.length === 0) return;
  const versions = new Set(binaryPackages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    console.error(
      `::error::the ns-bridge-bin packages must share one version; have ${[...versions].sort().join(", ")}. Bump all six together.`,
    );
    process.exit(1);
  }
  const pendingNames = new Set(plan.map((entry) => entry.name));
  const pending = binaryPackages.filter(({ manifest }) => pendingNames.has(manifest.name));
  if (pending.length > 0 && pending.length < binaryPackages.length) {
    const published = binaryPackages.filter(({ manifest }) => !pendingNames.has(manifest.name));
    console.error(
      `::warning::${published.map(({ manifest }) => manifest.name).join(", ")} already on npm at ${[...versions][0]}; ` +
        `publishing only ${pending.map(({ manifest }) => manifest.name).join(", ")} (resuming a partial release)`,
    );
  }
}

const unpublished = topoSort()
  .filter(({ manifest }) => !isPublished(manifest.name, manifest.version))
  .map(({ dir, manifest }) => ({
    dir,
    name: manifest.name,
    version: manifest.version,
    tag: tagFor(manifest.name, manifest.version),
  }));
checkBinaryLockstep(unpublished);

// First releases need a human (see existsOnNpm); everything else goes to CI.
const firstReleases = unpublished.filter((entry) => !existsOnNpm(entry.name));
const firstReleaseNames = new Set(firstReleases.map((entry) => entry.name));
const plan = unpublished.filter((entry) => !firstReleaseNames.has(entry.name));

// A pending package pinning a sibling that is published-but-stale would ship
// against code it was not built with. Refuse rather than publish it broken.
const pendingNames = new Set(unpublished.map((entry) => entry.name));
const stale = packages.filter(
  ({ dir, manifest }) => !pendingNames.has(manifest.name) && changedSinceRelease(dir, manifest),
);
const staleNames = new Set(stale.map(({ manifest }) => manifest.name));
const blockers = [];
for (const entry of plan) {
  const { manifest } = byName.get(entry.name);
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (firstReleaseNames.has(dep)) {
      blockers.push(
        `${entry.name}@${entry.version} depends on ${dep}, which has never been published; publish it by hand first (see below)`,
      );
    }
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
  if (!match && firstReleases.some((entry) => entry.tag === tag)) {
    console.error(`::error::${tag} is a first release, which trusted publishing cannot create; publish it by hand`);
    process.exit(1);
  }
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

if (firstReleases.length > 0) {
  console.error(
    `::warning::not published by CI (never on npm; trusted publishing cannot create a package): ` +
      `${firstReleases.map((entry) => `${entry.name}@${entry.version}`).join(", ")}. ` +
      `Publish each by hand once, in this order (npm publish <dir> --access public, with 2FA), ` +
      `then register the trusted publisher: npm trust github <name> --file publish.yml --repo ngosangns/ns-bridge --allow-publish`,
  );
}
for (const blocker of blockers) console.error(`::error::${blocker}`);
if (!args.includes("--json")) {
  for (const { manifest } of stale) {
    console.error(
      `note: ${manifest.name}@${manifest.version} is on npm but its code changed since; bump it before the next release`,
    );
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
