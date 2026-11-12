#!/usr/bin/env node
// Gate hook for the DSH usage panel.
// `task check` runs this through `pnpm -r self-check`.
// Before this file, the pre-commit gate never ran test-plugin.mjs. That let a
// panel version pass every gate and still throw when the app called it.
// This file keeps that contract test inside the gate.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The contract test reads these variables from the environment. It sets the
// usage directory itself; the other five have no default. A value you export in
// your own shell changes the numbers the test compares against, so remove all
// six. Every run then reads only the fixture the test builds for itself.
const env = { ...process.env };
for (const name of [
	'NS_BRIDGE_USAGE_DIR',
	'NS_BRIDGE_PI_CATALOG',
	'NS_BRIDGE_CREDIT_LIMIT',
	'KIRO_API_KEY',
	'DEVIN_CREDENTIALS_PATH',
	'XDG_DATA_HOME',
]) {
	delete env[name];
}
// A provider quota read needs the network and a real login, so the gate never
// depends on either. The test sets this too; setting it here covers a run of
// self-check on a machine that is signed in.
env.NS_BRIDGE_USAGE_PROVIDER_QUOTA = '0';

const child = spawnSync(process.execPath, [join(HERE, 'test-plugin.mjs')], {
	env,
	stdio: 'inherit',
});

if (child.error) {
	console.error('self-check: cannot start test-plugin.mjs: ' + child.error.message);
	process.exit(1);
}
if (child.status === 2) {
	console.error('self-check: the test could not resolve its peer dependencies.');
	console.error('self-check: run pnpm install in the repository root, then try again.');
}
process.exit(child.status ?? 1);
