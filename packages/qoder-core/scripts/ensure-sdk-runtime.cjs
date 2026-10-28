// Ensures @qoder-ai/qoder-agent-sdk worker runtime exists after pnpm install.
const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const requireFromHere = createRequire(__filename);
let sdkPkg;
try {
  sdkPkg = requireFromHere.resolve("@qoder-ai/qoder-agent-sdk/package.json");
} catch {
  process.exit(0);
}

const sdkRoot = dirname(sdkPkg);
const worker = join(sdkRoot, "dist", "_worker", "qoder-worker-runtime.obf.mjs");
if (existsSync(worker)) process.exit(0);

const postinstall = join(sdkRoot, "scripts", "postinstall.cjs");
if (!existsSync(postinstall)) {
  console.warn("[ns-qoder-core] @qoder-ai/qoder-agent-sdk postinstall script missing");
  process.exit(0);
}

const result = spawnSync(process.execPath, [postinstall], { stdio: "inherit", cwd: sdkRoot });
process.exit(result.status ?? 1);
