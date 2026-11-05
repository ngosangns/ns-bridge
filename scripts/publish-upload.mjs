#!/usr/bin/env node
// Uploads the tarballs scripts/publish-pack.mjs just verified. The machine
// must already be logged in to npm. This does not log in and does not push a tag.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const plan = JSON.parse(readFileSync(join(root, "tarballs", "plan.json"), "utf8"));
for (const entry of plan) {
  const file = `${entry.name.replace("@", "").replace("/", "-")}-${entry.version}.tgz`;
  console.log(`publishing ${file}`);
  execFileSync("npm", ["publish", `./tarballs/${file}`, "--access", "public", "--no-provenance"], {
    cwd: root,
    stdio: "inherit",
  });
}
