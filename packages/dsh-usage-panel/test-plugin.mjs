// Flow test for the dsh-usage-panel plugin.
//
// It checks ten sections:
//   1. Package shape: what the plugin manager and the Cordis loader read.
//   2. Fixture: a fixed ledger with hand-computed answers, no checks.
//   3. Cordis registration: the exact constructor call a fiber makes.
//   4. Summary contract: the object shape the client renders.
//   5. Credit math: billed, estimated, tokens and cache ratios.
//   6. Budgets and limits: where a limit comes from and what is left.
//   7. Window and empty paths: config days, missing ledger, no budget file.
//   8. RPC payload safety: numbers and keys the gateway accepts.
//   9. Client contract: endpoint, failure envelope, fields, locale keys.
//  10. Silence: the host must not warn during any run above.
//
// Run it from OUTSIDE the repo, through the profile symlink, so bare imports
// resolve the same way the app resolves them:
//
//   cd /tmp && node --preserve-symlinks-main --preserve-symlinks \
//     "$HOME/.dsh/profiles/desktop/node_modules/@local/dsh-usage-panel/test-plugin.mjs"
//
// A green run is NOT the final proof. The final proof is the panel rendering
// at http://127.0.0.1:53675 with no "Failed to load usage". Step 10 prints that
// manual check.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'node:assert/strict';

const HERE = import.meta.url;
const PKG_DIR = dirname(fileURLToPath(HERE));
const RUN_COMMAND =
	'  cd /tmp && node --preserve-symlinks-main --preserve-symlinks \\\n' +
	'    "$HOME/.dsh/profiles/desktop/node_modules/@local/dsh-usage-panel/test-plugin.mjs"';
let passed = 0;
const failures = [];

// `getUsageSummary` is async, so a check may return a promise. It is awaited
// here, so a rejected call lands in the failure list and not in an unhandled
// rejection. Every call site below uses `await check(...)`.
async function check(name, fn) {
	try {
		const detail = await fn();
		passed += 1;
		console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	} catch (error) {
		failures.push(name + ': ' + (error && error.message ? error.message : String(error)));
		console.log('  FAIL ' + name + '\n         ' + (error && error.message ? error.message : error));
	}
}

// ---------------------------------------------------------------------------
// 0. Resolution guard. Without the flags above, index.js cannot import tp.
// ---------------------------------------------------------------------------
const tpResolvable = (() => {
	try {
		createRequire(HERE).resolve('@deepseek-ai/dsh-typert-protocol');
		return true;
	} catch {
		return false;
	}
})();
if (!tpResolvable) {
	console.error('Cannot resolve @deepseek-ai/dsh-typert-protocol from ' + PKG_DIR);
	console.error('Run it through the profile symlink with --preserve-symlinks:');
	console.error(RUN_COMMAND);
	process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. Package shape: what the plugin manager and the loader read.
// ---------------------------------------------------------------------------
console.log('1. package shape');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const patchText = readFileSync(join(PKG_DIR, 'cordis.patch.yml'), 'utf8');
const indexText = readFileSync(join(PKG_DIR, 'index.js'), 'utf8');
const clientText = readFileSync(join(PKG_DIR, 'client.js'), 'utf8');

await check('exports maps every shipped entry point', async () => {
	const need = { '.': './index.js', './client': './client.js', './package.json': './package.json' };
	for (const [key, value] of Object.entries(need)) {
		assert.equal(pkg.exports[key], value, 'exports[' + key + ']');
	}
	assert.ok(pkg.exports['./cordis.patch.yml'], 'exports ./cordis.patch.yml missing');
	return Object.keys(pkg.exports).length + ' exports';
});
await check('files covers the runtime and the patch', async () => {
	for (const f of ['index.js', 'quota.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
		assert.ok(pkg.files.includes(f), 'files missing ' + f);
	}
	return pkg.files.join(',');
});
await check('dsh.bundle.patch is present so install_bundle accepts the dir', async () => {
	assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
	return 'ok';
});
await check('cordis.patch.yml inserts this plugin by its package name', async () => {
	assert.match(patchText, /id:\s*dsh-usage-panel/);
	assert.match(patchText, /name:\s*'@local\/dsh-usage-panel'/);
	return 'ok';
});
await check('runtime imports are declared as peers', async () => {
	const imported = [...indexText.matchAll(/from\s+'(@[^']+)'/g)].map((m) => m[1]);
	for (const spec of imported) {
		assert.ok(pkg.peerDependencies[spec], spec + ' imported but not declared');
	}
	return imported.join(',');
});
await check('no peer is pinned to an exact version', async () => {
	for (const [name, range] of Object.entries(pkg.peerDependencies)) {
		assert.match(range, /(\^|>=)/, name + ' must stay a range: the app bundle differs from disk');
	}
	return 'ok';
});
await check('host half uses the Form B service-class idiom', async () => {
	assert.match(indexText, /export default class \w+ extends TypertRemoteService/);
	assert.ok(!/export const inject/.test(indexText), 'export const inject in host half');
	assert.ok(!/ctx\.provide\s*\(/.test(indexText), 'ctx.provide does not exist on a Cordis ctx');
	return 'ok';
});
await check('host half has no tsconfig or build step to go stale', async () => {
	assert.ok(!existsSync(join(PKG_DIR, 'tsconfig.json')), 'tsconfig.json still present');
	return 'ok';
});

// ---------------------------------------------------------------------------
// 2. Fixture: a fixed ledger with hand-computed answers.
//    Day folders, newest first: 12 11 10 9 8 6 5 4 3 2 | 1
//    The default window is 10 folders, so day 1 stays outside it.
//    Days 6 and 2 are empty folders: a day with no steps.
// ---------------------------------------------------------------------------
console.log('2. fixture');
const RUN_ROOT = join(tmpdir(), 'dsh-usage-panel-test-' + process.pid);
const USAGE_DIR = join(RUN_ROOT, 'usage');
const DAY = (n) => '2026-01-' + String(n).padStart(2, '0');
const dayDir = (n) => join(USAGE_DIR, DAY(n));
const dayFile = (n, vendor) => {
	const dir = join(dayDir(n), vendor);
	mkdirSync(dir, { recursive: true });
	return join(dir, 'steps.jsonl');
};
const append = (path, lines) => {
	const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
	writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + text : text, 'utf8');
};

// kiro: one native credit step, one USD step, one priced estimate, one empty model.
append(dayFile(12, 'kiro'), [{ vendor: 'kiro', model: 'claude-opus-5-5', promptTokens: 1000, input: 1000, cacheRead: 0, output: 100, credits: 5, creditUnit: 'credit', cacheSource: 'none', session: 's1' }]);
append(dayFile(11, 'kiro'), [{ vendor: 'kiro', model: 'claude-haiku-4-5', promptTokens: 1000, input: 1000, cacheRead: 0, output: 0, credits: 0.5, creditUnit: 'usd', cacheSource: 'none', session: 's1' }]);
// 200000*2 + 1000*10 = 410000 per 1M = 0.41 USD = 10.25 credits.
append(dayFile(10, 'kiro'), [{ vendor: 'kiro', model: 'claude-sonnet-5-5', promptTokens: 200000, input: 200000, cacheRead: 0, output: 1000, cacheSource: 'none', session: 's2' }]);
append(dayFile(3, 'kiro'), [{ vendor: 'kiro', model: '', promptTokens: 1000, input: 1000, output: 0, cacheSource: 'none', session: 's5' }]);
// grok: the long-context band applies at promptTokens 300000 (threshold 200000, inclusive).
// 100000*4 + 1000*12 + 200000*1 = 612000 per 1M = 0.612 USD = 15.3 credits.
append(dayFile(9, 'grok'), [{ vendor: 'grok', model: 'grok-4.7', promptTokens: 300000, input: 100000, cacheRead: 200000, output: 1000, cacheSource: 'wire', session: 's3' }]);
// qoder: a tier label with no real underlying model must price to 0, never a guess.
append(dayFile(8, 'qoder'), [
	{ vendor: 'qoder', model: 'ultimate', promptTokens: 5000, input: 5000, cacheRead: 0, output: 100, cacheSource: 'none', session: 's4' },
	'not json at all',
	JSON.stringify({ model: 'x', promptTokens: 10, cacheSource: 'none' }), // no vendor
	JSON.stringify({ vendor: 'bad', model: 'x', promptTokens: '10', cacheSource: 'none' }), // promptTokens not a number
	JSON.stringify({ vendor: 'bad', model: 'x', promptTokens: 10, cacheSource: 'bogus' }), // bad cacheSource
	'',
]);
// old: day 5 names a credit unit the panel cannot map, day 4 sits inside the window,
// day 1 sits outside it and must never reach a row.
append(dayFile(5, 'old'), [{ vendor: 'old', model: 'weird', promptTokens: 1000, input: 1000, output: 0, credits: 3, creditUnit: 'tokens', cacheSource: 'none', session: 's6' }]);
append(dayFile(4, 'old'), [{ vendor: 'old', model: 'x', promptTokens: 1000, input: 1000, output: 0, cacheSource: 'none', session: 's6' }]);
append(dayFile(1, 'old'), [{ vendor: 'old', model: 'gone', promptTokens: 900000, input: 900000, output: 0, credits: 500, creditUnit: 'credit', cacheSource: 'none', session: 's0' }]);
// Two day folders with no steps at all.
mkdirSync(join(dayDir(6), 'kiro'), { recursive: true });
mkdirSync(dayDir(2), { recursive: true });

// Budgets: a nested map, one object per vendor. `used` is stale and must be
// ignored. A budget of 0 and a non-object entry are skipped, so the vendor
// keeps no row at all.
const BUDGETS = { kiro: { budget: 100, used: 999 }, devin: { budget: 50 }, qoder: { budget: 5, used: 0 }, broken: { budget: 0 }, nope: 'string' };
const BUDGET_PATH = join(RUN_ROOT, 'credit-budgets.json');
writeFileSync(BUDGET_PATH, JSON.stringify(BUDGETS), 'utf8');
process.env.NS_BRIDGE_USAGE_DIR = USAGE_DIR;
// Provider quota needs the network and real credentials, so the suite turns it
// off. Every row then keeps its file, env or none limit, exactly as before.
process.env.NS_BRIDGE_USAGE_PROVIDER_QUOTA = '0';

// ---------------------------------------------------------------------------
// 3. Service construction: the exact call the Cordis fiber makes.
// ---------------------------------------------------------------------------
console.log('3. cordis registration');
const mod = await import(new URL('./index.js', HERE).href);
const tp = await import('@deepseek-ai/dsh-typert-protocol');
const UsageService = mod.default;
const provided = [];
const logs = [];
function makeCtx() {
	return {
		baseUrl: pathToFileURL(PKG_DIR + '/').href,
		reflect: {
			provide(name, impl) {
				provided.push({ name, impl });
				return { name, impl };
			},
		},
		log() {
			return { warn: (m) => logs.push('warn: ' + m), error: (m) => logs.push('error: ' + m) };
		},
	};
}
const ctx = makeCtx();
const service = new UsageService(ctx, { days: 10 });

await check('service key is usage', async () => {
	assert.equal(service.name, 'usage');
	return 'ok';
});
await check('registered once on ctx.reflect.provide under usage', async () => {
	assert.equal(provided.length, 1, 'expected one provide, got ' + provided.length);
	assert.equal(provided[0].name, 'usage');
	assert.equal(provided[0].impl, service, 'provide must receive the instance');
	return 'ok';
});
await check('gateway namespace is usage', async () => {
	assert.equal(service.typertRemote && service.typertRemote.namespace, 'usage');
	return 'namespace=' + service.typertRemote.namespace;
});
await check('getUsageSummary is visible to the gateway reader', async () => {
	// remoteMethods is the same public reader the RPC gateway uses. A missing
	// marker makes usage/getUsageSummary fail and the panel shows panel.error.
	const marks = tp.remoteMethods(service);
	const names = marks.map((m) => m?.exportName ?? m?.method);
	assert.ok(names.includes('getUsageSummary'), 'remoteMethods returned: ' + JSON.stringify(names));
	assert.deepEqual(logs, [], 'constructor logged: ' + logs.join(' | '));
	return names.join(',');
});

// ---------------------------------------------------------------------------
// 4. Summary contract: the object the client renders.
//    Every number here comes from the fixture above and was checked by hand.
// ---------------------------------------------------------------------------
console.log('4. summary contract');
const summary = await service.getUsageSummary();

const USAGE_FIELD_NAMES = [
	'steps',
	'sessionCount',
	'totalTokens',
	'promptTokens',
	'outputTokens',
	'cacheReadTokens',
	'cacheHitRatio',
	'cacheWriteRatio',
	'totalCredits',
	'billedCredits',
	'estimatedCredits',
];
const QUOTA_KEYS = ['source', 'unit', 'used', 'limit', 'remaining', 'resetAtMs', 'label', 'account', 'warning'];
const VENDOR_KEYS = [
	'vendor',
	...USAGE_FIELD_NAMES,
	'limit',
	'limitSource',
	'remainingCredits',
	'overLimit',
	'quota',
];
const MODEL_KEYS = ['vendor', 'model', ...USAGE_FIELD_NAMES];
const DAY_KEYS = ['day', 'vendor', 'model', ...USAGE_FIELD_NAMES];

function findOne(list, label, test) {
	const hits = list.filter(test);
	assert.equal(hits.length, 1, 'expected exactly one ' + label + ', got ' + hits.length);
	return hits[0];
}
const vendorRow = (vendor) => findOne(summary.vendors, 'vendor ' + vendor, (r) => r.vendor === vendor);
const modelRow = (vendor, model) =>
	findOne(summary.models, 'model ' + vendor + '/' + model, (r) => r.vendor === vendor && r.model === model);
const dayRow = (day, vendor, model) =>
	findOne(summary.days, 'day row ' + day, (r) => r.day === day && r.vendor === vendor && r.model === model);

await check('summary is a versioned object, not an array', async () => {
	assert.equal(summary.schemaVersion, 3, 'schemaVersion must match the client CLIENT_SCHEMA');
	assert.equal(typeof summary.window, 'object', 'window must be an object');
	assert.equal(typeof summary.totals, 'object', 'totals must be an object');
	for (const key of ['vendors', 'days', 'models']) {
		assert.ok(Array.isArray(summary[key]), key + ' must be an array');
	}
	return 'schemaVersion=' + summary.schemaVersion;
});
await check('window reports the days read and the folders found', async () => {
	assert.deepEqual(summary.window, {
		days: 10,
		choices: [1, 3, 7, 10, 30],
		from: '2026-01-03',
		to: '2026-01-12',
		folders: 10,
	});
	return summary.window.from + '..' + summary.window.to;
});
await check('every row type has one key list in a fixed order', async () => {
	assert.deepEqual(Object.keys(summary.totals), USAGE_FIELD_NAMES);
	assert.deepEqual(Object.keys(summary.vendors[0]), VENDOR_KEYS);
	assert.deepEqual(Object.keys(summary.models[0]), MODEL_KEYS);
	assert.deepEqual(Object.keys(summary.days[0]), DAY_KEYS);
	return 'vendors ' + VENDOR_KEYS.length + ', models ' + MODEL_KEYS.length + ' keys';
});
await check('day rows are newest first and empty folders add no row', async () => {
	assert.deepEqual(summary.days.map((r) => r.day), [
		'2026-01-12',
		'2026-01-11',
		'2026-01-10',
		'2026-01-09',
		'2026-01-08',
		'2026-01-05',
		'2026-01-04',
		'2026-01-03',
	]);
	return summary.days.length + ' rows, days 6 and 2 absent';
});
await check('model rows sort by vendor, then credits, then model', async () => {
	assert.deepEqual(
		summary.models.map((r) => r.vendor + '/' + r.model),
		[
			'grok/grok-4.7',
			'kiro/claude-haiku-4-5',
			'kiro/claude-sonnet-5-5',
			'kiro/claude-opus-5-5',
			'kiro/unknown',
			'old/weird',
			'old/x',
			'qoder/ultimate',
		],
	);
	return summary.models.length + ' rows';
});
await check('billed plus estimated equals total on every row', async () => {
	const rows = [{ what: 'totals', row: summary.totals }];
	for (const list of ['vendors', 'models', 'days']) {
		for (const row of summary[list]) rows.push({ what: list + ' ' + (row.model || row.vendor), row });
	}
	for (const { what, row } of rows) {
		const sum = Math.round((row.billedCredits + row.estimatedCredits) * 1e6) / 1e6;
		assert.equal(sum, row.totalCredits, what + ': billed+estimated must equal total');
	}
	return rows.length + ' rows add up';
});

// ---------------------------------------------------------------------------
// 5. Credit math: what the ledger turns into credits.
// ---------------------------------------------------------------------------
console.log('5. credit math');
await check('a native credit amount is billed as it is', async () => {
	const r = modelRow('kiro', 'claude-opus-5-5');
	assert.equal(r.billedCredits, 5);
	assert.equal(r.estimatedCredits, 0);
	assert.equal(r.totalCredits, 5);
	return 'credits 5 -> billed 5';
});
await check('a usd credit amount is divided by USD_PER_CREDIT', async () => {
	// 0.5 USD / 0.04 = 12.5 credits, all billed, nothing estimated.
	const r = modelRow('kiro', 'claude-haiku-4-5');
	assert.equal(r.billedCredits, 12.5);
	assert.equal(r.estimatedCredits, 0);
	assert.equal(r.totalCredits, 12.5);
	return '0.5 usd -> 12.5 credits';
});
await check('a priced model without a billed amount is estimated', async () => {
	const r = modelRow('kiro', 'claude-sonnet-5-5');
	assert.equal(r.billedCredits, 0);
	assert.equal(r.estimatedCredits, 10.25);
	assert.equal(r.totalCredits, 10.25);
	return 'kiro sonnet -> 10.25';
});
await check('the long-context band applies to grok', async () => {
	const r = modelRow('grok', 'grok-4.7');
	assert.equal(r.estimatedCredits, 15.3);
	assert.equal(r.promptTokens, 300000);
	assert.equal(r.input === undefined, true, 'input is not part of the payload');
	return '300k prompt -> 15.3 credits';
});
await check('a tier label with no priced model costs nothing', async () => {
	const r = modelRow('qoder', 'ultimate');
	assert.equal(r.totalCredits, 0);
	assert.equal(r.billedCredits, 0);
	assert.equal(r.estimatedCredits, 0);
	assert.equal(r.totalTokens, 5100);
	return 'never a guessed price';
});
await check('a credit unit the panel cannot name is not a credit amount', async () => {
	const r = modelRow('old', 'weird');
	assert.equal(r.billedCredits, 0, 'credits 3 with unit tokens must be ignored');
	assert.equal(r.totalCredits, 0);
	return 'unit tokens -> 0';
});
await check('an empty model id becomes unknown and is not priced', async () => {
	const r = modelRow('kiro', 'unknown');
	assert.equal(r.model, 'unknown');
	assert.equal(r.totalCredits, 0);
	assert.equal(r.steps, 1);
	return 'model "" -> unknown';
});
await check('totalTokens is prompt plus output, cache read is separate', async () => {
	// The grok step read 200000 cached tokens. They must not double count.
	const grok = modelRow('grok', 'grok-4.7');
	assert.equal(grok.totalTokens, 301000);
	assert.equal(grok.cacheReadTokens, 200000);
	assert.equal(grok.totalTokens, grok.promptTokens + grok.outputTokens);
	const sonnet = modelRow('kiro', 'claude-sonnet-5-5');
	assert.equal(sonnet.totalTokens, 201000);
	return 'cache read not added to total';
});
await check('cache hit ratio uses cached read over cached prompt', async () => {
	const totals = summary.totals;
	assert.equal(totals.cacheReadTokens, 200000);
	assert.equal(totals.cacheHitRatio, 0.392157);
	assert.equal(totals.cacheWriteRatio, 0);
	assert.equal(modelRow('grok', 'grok-4.7').cacheHitRatio, 0.666667);
	assert.equal(vendorRow('kiro').cacheHitRatio, 0);
	// A vendor with no usage has no ratio at all: RPC rejects a missing key only
	// when the value is undefined, so the host sends null.
	assert.equal(vendorRow('devin').cacheHitRatio, null);
	assert.equal(vendorRow('devin').cacheWriteRatio, null);
	return 'totals 0.392157';
});
await check('sessions are counted once per vendor and once in total', async () => {
	assert.equal(summary.totals.sessionCount, 6, 's1..s6; s0 is outside the window');
	assert.equal(vendorRow('kiro').sessionCount, 3, 's1, s2, s5');
	assert.equal(vendorRow('old').sessionCount, 1, 's6 twice on one vendor');
	assert.equal(summary.totals.steps, 8);
	assert.equal(summary.totals.totalCredits, 43.05);
	return '6 sessions, 8 steps';
});

// ---------------------------------------------------------------------------
// 6. Budgets and limits: the limit columns.
// ---------------------------------------------------------------------------
console.log('6. budgets and limits');
await check('vendors with a declared budget keep a row even with no usage', async () => {
	assert.deepEqual(summary.vendors.map((r) => r.vendor), ['devin', 'grok', 'kiro', 'old', 'qoder']);
	const devin = vendorRow('devin');
	assert.equal(devin.steps, 0);
	assert.equal(devin.totalCredits, 0);
	assert.equal(devin.limit, 50);
	assert.equal(devin.remainingCredits, 50);
	return 'budget 0 and a non-object entry are skipped';
});
await check('a file budget is the limit and spent comes from the ledger', async () => {
	const kiro = vendorRow('kiro');
	assert.equal(kiro.limit, 100);
	assert.equal(kiro.limitSource, 'file');
	assert.equal(kiro.totalCredits, 27.75);
	assert.equal(kiro.remainingCredits, 72.25);
	assert.equal(kiro.remainingCredits, 100 - kiro.totalCredits);
	assert.equal(kiro.overLimit, false);
	return 'stale used:999 ignored';
});
await check('a vendor with no declared limit reports null', async () => {
	for (const vendor of ['grok', 'old']) {
		const r = vendorRow(vendor);
		assert.equal(r.limit, null, vendor + ' limit');
		assert.equal(r.limitSource, 'none', vendor + ' limitSource');
		assert.equal(r.remainingCredits, null, vendor + ' remainingCredits');
		assert.equal(r.overLimit, false, vendor + ' overLimit');
	}
	return 'no invented limit';
});
await check('a full budget reports zero left and is not over', async () => {
	const qoder = vendorRow('qoder');
	assert.equal(qoder.limit, 5);
	assert.equal(qoder.totalCredits, 0);
	assert.equal(qoder.remainingCredits, 5);
	assert.equal(qoder.overLimit, false);
	return 'spent 0 of 5';
});
await check('overLimit is true only when the remaining amount is negative', async () => {
	// The same ledger against a limit lower than the spend, so the negative
	// number must stay visible and must not be clamped to zero. The file wins
	// over NS_BRIDGE_CREDIT_LIMIT, so the low limit goes in the file.
	writeFileSync(BUDGET_PATH, JSON.stringify({ kiro: { budget: 3 } }), 'utf8');
	try {
		const out = await new UsageService(makeCtx(), { days: 1 }).getUsageSummary();
		const kiro = findOne(out.vendors, 'over limit kiro', (r) => r.vendor === 'kiro');
		assert.equal(kiro.limitSource, 'file');
		assert.equal(kiro.limit, 3);
		assert.equal(kiro.totalCredits, 5);
		assert.equal(kiro.remainingCredits, -2, 'remaining must not be clamped at 0');
		assert.equal(kiro.overLimit, true);
		return 'limit 3, spent 5, left -2';
	} finally {
		writeFileSync(BUDGET_PATH, JSON.stringify(BUDGETS), 'utf8');
	}
});
await check('env limit is used only when the budget file omits the vendor', async () => {
	// limitFor checks the file first, so an env-only run needs a file with no kiro.
	writeFileSync(BUDGET_PATH, JSON.stringify({ devin: { budget: 50 } }), 'utf8');
	process.env.NS_BRIDGE_CREDIT_LIMIT = '30';
	try {
		const out = await new UsageService(makeCtx(), { days: 1 }).getUsageSummary();
		const kiro = findOne(out.vendors, 'env kiro', (r) => r.vendor === 'kiro');
		assert.equal(kiro.limit, 30);
		assert.equal(kiro.limitSource, 'env');
		assert.equal(kiro.totalCredits, 5);
		assert.equal(kiro.remainingCredits, 25);
		assert.equal(kiro.overLimit, false);
		// A vendor named by the file still reports the file, never the env value.
		const devin = findOne(out.vendors, 'env devin', (r) => r.vendor === 'devin');
		assert.equal(devin.limitSource, 'file');
		assert.equal(devin.limit, 50);
		return 'kiro 30 env, devin 50 file';
	} finally {
		delete process.env.NS_BRIDGE_CREDIT_LIMIT;
		writeFileSync(BUDGET_PATH, JSON.stringify(BUDGETS), 'utf8');
	}
});
await check('provider quota stays off the network for the whole suite', async () => {
	const q = await import(new URL('./quota.js', HERE).href);
	assert.equal(q.isProviderVendor('kiro'), false, 'the kill switch must disable kiro');
	assert.equal(q.isProviderVendor('devin'), false, 'the kill switch must disable devin');
	assert.equal(await q.refreshQuota('kiro'), null, 'a disabled provider answers null');
	delete process.env.NS_BRIDGE_USAGE_PROVIDER_QUOTA;
	try {
		assert.equal(q.isProviderVendor('Kiro'), true, 'the vendor name is matched case first');
		assert.equal(q.isProviderVendor(' grok '), false, 'grok has no quota endpoint');
		assert.equal(q.isProviderVendor('qoder'), false, 'qoder has no quota endpoint');
	} finally {
		process.env.NS_BRIDGE_USAGE_PROVIDER_QUOTA = '0';
	}
	return 'kiro and devin only';
});
await check('normalizeKiro picks the credit bucket over any other unit', async () => {
	const q = await import(new URL('./quota.js', HERE).href);
	const quota = q.normalizeKiro({
		subscriptionTitle: 'KIRO PRO+',
		usageBuckets: [
			{ id: 'tokens', label: 'Token', used: 1200, limit: 5000, unitKind: 'tokens' },
			{ id: 'invocations', label: 'Credit', used: 640.65, limit: 2000, unitKind: 'credits', resetAtMs: 1796083200000 },
		],
	});
	assert.deepEqual(Object.keys(quota), QUOTA_KEYS, 'a quota has one key list');
	assert.equal(quota.source, 'provider');
	assert.equal(quota.unit, 'credits', 'a bought allowance wins over a token bucket');
	assert.equal(quota.used, 640.65);
	assert.equal(quota.limit, 2000);
	assert.equal(quota.remaining, 1359.35);
	assert.equal(quota.resetAtMs, 1796083200000);
	assert.equal(quota.label, 'Credit');
	assert.equal(quota.account, 'KIRO PRO+');
	assert.equal(quota.warning, null, 'the caller owns the budget file tick');
	return '640.65 of 2000 credits';
});
await check('normalizeKiro returns null unless a bucket carries a real bar', async () => {
	const q = await import(new URL('./quota.js', HERE).href);
	assert.equal(q.normalizeKiro(undefined), null, 'no response at all');
	assert.equal(q.normalizeKiro({}), null, 'no buckets at all');
	assert.equal(q.normalizeKiro({ usageBuckets: [] }), null, 'an empty bucket list');
	assert.equal(q.normalizeKiro({ usageBuckets: [{ label: 'Credit', used: 0 }] }), null, 'used with no limit and no reset is not a bar');
	assert.equal(q.normalizeKiro({ usageBuckets: [{ label: 'Credit', used: 'x', limit: 10 }] }), null, 'a used that is not a number');
	const bonus = q.normalizeKiro({
		subscriptionTitle: 'FREE',
		usageBuckets: [{ label: 'Bonus', used: 3, unitKind: 'credits' }],
		resetAtMs: 1796083200000,
	});
	assert.equal(bonus.limit, null, 'a bucket with no allowance has no limit');
	assert.equal(bonus.remaining, null, 'no limit means no remaining');
	assert.equal(bonus.resetAtMs, 1796083200000, 'the response reset is the fallback');
	return 'five null paths, one fallback';
});
await check('normalizeDevin adds the credit windows into one allowance', async () => {
	const q = await import(new URL('./quota.js', HERE).href);
	const quota = q.normalizeDevin({
		planName: 'Free',
		limits: [
			{ id: 'devin:credits:prompt', label: 'Prompt credits', window: 'month', unit: 'credits', used: 0, limit: 2500 },
			{ id: 'devin:credits:flow', label: 'Flow credits', window: 'month', unit: 'credits', used: 12.5, limit: 500 },
			{ id: 'devin:quota:daily', label: 'Daily', window: 'day', unit: 'percent', used: 20, limit: 100, resetsAt: 1796000000000 },
			{ id: 'devin:quota:weekly', label: 'Weekly', window: 'week', unit: 'percent', used: 75, limit: 100, resetsAt: 1796000001000 },
		],
	});
	assert.deepEqual(Object.keys(quota), QUOTA_KEYS, 'a quota has one key list');
	assert.equal(quota.unit, 'credits', 'the plan allowance is the number a person reads');
	assert.equal(quota.used, 12.5, '0 + 12.5');
	assert.equal(quota.limit, 3000, '2500 + 500');
	assert.equal(quota.remaining, 2987.5);
	assert.equal(quota.resetAtMs, null, 'these credit rows carry no reset');
	assert.equal(quota.label, 'Free');
	assert.equal(quota.account, 'Free');
	return 'two credit windows summed';
});
await check('normalizeDevin picks the fullest percent window, not the first', async () => {
	const q = await import(new URL('./quota.js', HERE).href);
	const quota = q.normalizeDevin({
		planName: 'Team',
		limits: [
			{ id: 'daily', label: 'Daily', unit: 'percent', used: 20, limit: 100, resetsAt: 1796000000000 },
			{ id: 'open', label: 'No allowance', unit: 'percent', used: 5, resetsAt: 1796000002000 },
			{ id: 'weekly', label: 'Weekly', unit: 'percent', used: 90, limit: 100, resetsAt: 1796000001000 },
		],
	});
	assert.equal(quota.label, 'Weekly', 'the fullest window is the honest bar');
	assert.equal(quota.unit, 'percent');
	assert.equal(quota.used, 90);
	assert.equal(quota.limit, 100, 'a percent window is already out of one hundred');
	assert.equal(quota.remaining, 10);
	assert.equal(quota.resetAtMs, 1796000001000);
	return 'max share wins';
});
await check('normalizeDevin returns null when no row carries an allowance', async () => {
	const q = await import(new URL('./quota.js', HERE).href);
	assert.equal(q.normalizeDevin(undefined), null, 'no response at all');
	assert.equal(q.normalizeDevin({}), null, 'no limits at all');
	assert.equal(q.normalizeDevin({ limits: [] }), null, 'an empty limit list');
	assert.equal(q.normalizeDevin({ limits: [{ unit: 'credits', used: 3, limit: 0 }] }), null, 'a zero allowance is not a cap');
	assert.equal(q.normalizeDevin({ limits: [{ unit: 'credits', used: 3, limit: -5 }] }), null, 'a negative allowance is not a cap');
	return 'five null paths';
});

// ---------------------------------------------------------------------------
// 7. Window and empty paths: config and missing files.
// ---------------------------------------------------------------------------
console.log('7. window and empty paths');
await check('a one day window reads only the newest folder', async () => {
	const out = await new UsageService(makeCtx(), { days: 1 }).getUsageSummary();
	assert.deepEqual(out.window, { days: 1, choices: [1, 3, 7, 10, 30], from: '2026-01-12', to: '2026-01-12', folders: 1 });
	assert.deepEqual(out.vendors.map((r) => r.vendor), ['devin', 'kiro', 'qoder']);
	assert.deepEqual(out.models.map((r) => r.vendor + '/' + r.model), ['kiro/claude-opus-5-5']);
	assert.equal(out.days.length, 1);
	const kiro = findOne(out.vendors, 'kiro day 12', (r) => r.vendor === 'kiro');
	assert.equal(kiro.totalCredits, 5);
	assert.equal(kiro.remainingCredits, 95, '100 - 5');
	return 'grok and old drop out of the window';
});
await check('the window comes from config, not from an env var', async () => {
	process.env.NS_BRIDGE_USAGE_DAYS = '30';
	try {
		const out = await new UsageService(makeCtx(), { days: 3 }).getUsageSummary();
		assert.equal(out.window.days, 3, 'the panel must ignore NS_BRIDGE_USAGE_DAYS');
		const dflt = await new UsageService(makeCtx()).getUsageSummary();
		assert.equal(dflt.window.days, 10, 'no config must give DEFAULT_USAGE_DAYS');
		return 'config wins';
	} finally {
		delete process.env.NS_BRIDGE_USAGE_DAYS;
	}
});
await check('a missing ledger gives no rows but keeps the declared limits', async () => {
	process.env.NS_BRIDGE_USAGE_DIR = join(RUN_ROOT, 'nope');
	try {
		const out = await new UsageService(makeCtx(), { days: 10 }).getUsageSummary();
		assert.deepEqual(out.models, []);
		assert.deepEqual(out.days, []);
		assert.deepEqual(out.vendors.map((r) => r.vendor), ['devin', 'kiro', 'qoder']);
		for (const r of out.vendors) {
			assert.equal(r.totalCredits, 0, r.vendor + ' spent');
			assert.equal(r.limitSource, 'file', r.vendor + ' limit source');
			assert.equal(r.overLimit, false);
			assert.equal(r.quota, null, r.vendor + ' quota');
		}
		assert.deepEqual(out.window, { days: 10, choices: [1, 3, 7, 10, 30], from: null, to: null, folders: 0 });
		return '3 budgeted vendors still visible';
	} finally {
		process.env.NS_BRIDGE_USAGE_DIR = USAGE_DIR;
	}
});
await check('no ledger and no budget file gives an empty summary, not an error', async () => {
	// Two levels below a directory that has no credit-budgets.json, so
	// budgetPath() finds nothing and every vendor has no limit.
	const emptyRoot = join(RUN_ROOT, 'empty');
	process.env.NS_BRIDGE_USAGE_DIR = join(emptyRoot, 'usage');
	try {
		const out = await new UsageService(makeCtx(), { days: 10 }).getUsageSummary();
		assert.deepEqual(out.vendors, []);
		assert.deepEqual(out.models, []);
		assert.deepEqual(out.days, []);
		assert.deepEqual(out.totals, {
			steps: 0,
			sessionCount: 0,
			totalTokens: 0,
			promptTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheHitRatio: null,
			cacheWriteRatio: null,
			totalCredits: 0,
			billedCredits: 0,
			estimatedCredits: 0,
		});
		return 'empty totals are complete';
	} finally {
		process.env.NS_BRIDGE_USAGE_DIR = USAGE_DIR;
	}
});
await check('an unreadable price catalog does not change billed credits', async () => {
	const before = vendorRow('kiro');
	process.env.NS_BRIDGE_PI_CATALOG = join(RUN_ROOT, 'no-catalog.json');
	try {
		const out = await new UsageService(makeCtx(), { days: 10 }).getUsageSummary();
		assert.equal(out.vendors.length, 5);
		const kiro = findOne(out.vendors, 'kiro no catalog', (r) => r.vendor === 'kiro');
		assert.equal(kiro.totalCredits, before.totalCredits);
		assert.equal(kiro.remainingCredits, before.remainingCredits);
		return 'kiro 27.75 with and without the catalog';
	} finally {
		delete process.env.NS_BRIDGE_PI_CATALOG;
	}
});

// ---------------------------------------------------------------------------
// 8. RPC payload safety: the gateway rejects -0, NaN, undefined and cycles.
// ---------------------------------------------------------------------------
console.log('8. rpc payload safety');
await check('payload is strict JSON with finite numbers', async () => {
	const visit = (value, seen) => {
		if (value === null) return;
		const type = typeof value;
		if (type === 'string' || type === 'boolean') return;
		if (type === 'number') {
			assert.ok(Number.isFinite(value), 'non-finite number');
			assert.ok(!Object.is(value, -0), '-0 is rejected by the gateway');
			return;
		}
		assert.equal(type, 'object', 'unsupported rpc type ' + type);
		assert.ok(!seen.has(value), 'cycle in payload');
		seen.add(value);
		for (const [k, v] of Object.entries(value)) {
			assert.ok(v !== undefined, 'undefined at key ' + k);
			const d = Object.getOwnPropertyDescriptor(value, k);
			assert.ok(d.enumerable, 'non-enumerable descriptor at ' + k);
			visit(v, seen);
		}
		seen.delete(value);
	};
	visit(summary, new Set());
	const text = JSON.stringify(summary);
	assert.ok(!text.includes('undefined'), 'stringify contains undefined');
	assert.ok(!/"folders":\[/.test(text), 'window.folders must not be a list');
	assert.equal(typeof summary.window.days, 'number', 'window.days must be a number');
	return text.length + ' bytes';
});
await check('every row carries the shared usage fields', async () => {
	const rows = [[summary.totals], summary.vendors, summary.models, summary.days];
	for (const list of rows) {
		assert.ok(list.length > 0, 'an empty list makes this check vacuous');
	}
	for (const list of rows) {
		for (const row of list) {
			for (const key of USAGE_FIELD_NAMES) {
				assert.ok(key in row, 'row missing ' + key);
			}
		}
	}
	for (const row of summary.vendors) {
		assert.ok(['provider', 'file', 'env', 'none'].includes(row.limitSource), 'bad limitSource ' + row.limitSource);
		assert.equal(typeof row.overLimit, 'boolean');
		if (row.limitSource === 'none') {
			assert.equal(row.limit, null);
			assert.equal(row.remainingCredits, null);
		}
	}
	return USAGE_FIELD_NAMES.length + ' shared fields on ' + (1 + summary.vendors.length + summary.models.length + summary.days.length) + ' rows';
});

// ---------------------------------------------------------------------------
// 9. Client contract: endpoint, failure envelope, fields, locale keys.
// ---------------------------------------------------------------------------
console.log('9. client contract');
await check('client calls the endpoint the host registers', async () => {
	assert.match(clientText, /usage\/getUsageSummary/);
	assert.match(clientText, /rpc\.call\(\s*['"]\/api['"]/);
	return 'ok';
});
await check('client passes an empty args object', async () => {
	assert.match(clientText, /getUsageSummary['"],\s*\{\s*args:\s*\{\}\s*\}/, 'rpc args shape changed');
	return 'ok';
});
await check('client treats a failed call as an outcome, not as a throw', async () => {
	// The gateway resolves { ok: false, error } instead of throwing, so a client
	// that only catches would show a generic error with no code.
	assert.match(clientText, /result\.ok\s*!==\s*true/, 'client must check result.ok');
	assert.match(clientText, /result\.value/, 'client must read the value out of the envelope');
	assert.match(clientText, /error\.code/, 'client must report the stable remote code');
	assert.match(clientText, /state\.detail/, 'client must show the code to the user');
	return 'ok';
});
await check('a bar with no provider quota draws no budget mark', async () => {
	// Number(null) is 0. A raw cast put a mark at 0% on every row, even grok
	// and qoder, which have no provider quota at all.
	assert.match(clientText, /const given = props\.warningRatio;/, 'MeterBar must read the mark into a named local');
	assert.match(clientText, /typeof given === 'number' \|\| typeof given === 'string' \? Number\(given\) : null/, 'MeterBar must reject a missing mark before it casts');
	assert.doesNotMatch(clientText, /Number\(props\.warningRatio\)/, 'MeterBar must not cast a missing mark');
	return 'ok';
});
await check('client reads only fields the host returns', async () => {
	// Locale dictionaries write keys as strings, for example 'totals.tokens'.
	// Those are labels, not reads, so blank every single-quoted string first.
	const code = clientText.replace(/'[^'\n]*'/g, "''");
	// `quota` is a nested object, so a local named quota counts as a read too.
	const read = new Set([...code.matchAll(/(?<!\.)\b(?:row|item|r|entry|vendor|model|day|part|totals|quota)\.([A-Za-z][\w]*)/g)].map((m) => m[1]));
	const schema = new Set([
		...Object.keys(summary.totals),
		...Object.keys(summary.vendors[0]),
		...Object.keys(summary.models[0]),
		...Object.keys(summary.days[0]),
		// A provider is offline here, so every row quota is null. Read the
		// nested names from the list the host builds, not from the payload.
		...QUOTA_KEYS,
	]);
	assert.ok(read.size > 8, 'the field reader found only ' + read.size + ' fields; the regex is too narrow');
	for (const field of read) {
		assert.ok(schema.has(field), 'client reads ' + field + ' which the host never returns');
	}
	for (const field of [...VENDOR_KEYS, ...MODEL_KEYS, ...QUOTA_KEYS, 'day']) {
		assert.ok(schema.has(field), field + ' missing from the payload');
	}
	return read.size + ' fields used';
});
await check('every locale key the client asks for is defined', async () => {
	const used = new Set([...clientText.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1]));
	const defined = new Set([...clientText.matchAll(/['"]([a-z][\w.]*\.[\w.]+)['"]\s*:/g)].map((m) => m[1]));
	const missing = [...used].filter((k) => !defined.has(k));
	assert.deepEqual(missing, [], 'keys used but not registered: ' + missing.join(','));
	return used.size + ' keys, all defined';
});
await check('locale files still carry the plugin meta strings', async () => {
	for (const lang of ['en', 'vi']) {
		const data = JSON.parse(readFileSync(join(PKG_DIR, 'locale', lang + '.json'), 'utf8'));
		assert.equal(typeof data.meta.title, 'string', lang + '.meta.title');
		assert.equal(typeof data.meta.description, 'string', lang + '.meta.description');
	}
	return 'ok';
});
await check('client half declares its inject list', async () => {
	assert.match(clientText, /inject:\s*\[[^\]]*'slots'[^\]]*\]/);
	assert.match(clientText, /inject:\s*\[[^\]]*'connection'[^\]]*\]/, 'the body needs connection for rpc');
	assert.match(clientText, /locale:\s*NS/, 'the slot must set locale so it receives t');
	return 'ok';
});

// ---------------------------------------------------------------------------
// 10. Silence and cleanup.
// ---------------------------------------------------------------------------
console.log('10. no warnings');
await check('no run above made the host log a warning', async () => {
	assert.deepEqual(logs, [], 'host logged: ' + logs.join(' | '));
	return passed + ' checks, ' + logs.length + ' log lines';
});

rmSync(RUN_ROOT, { recursive: true, force: true });
delete process.env.NS_BRIDGE_USAGE_DIR;

console.log('');
if (failures.length) {
	console.log('FAILED ' + failures.length + ' of ' + (passed + failures.length));
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}
console.log('PASSED ' + passed + ' checks, fixture cleaned from ' + RUN_ROOT);
console.log('');
console.log('Manual app proof, in this order:');
console.log('  1. Quit DeepSeek Harness completely, then open it again. The host half is');
console.log('     cached, so an edit to index.js does not take effect until a restart.');
console.log('  2. Open the panel in the right sidebar at http://127.0.0.1:53675.');
console.log('  3. The panel must show rows. It must not show "Failed to load usage".');
console.log('  4. Check the credit numbers against: ns-bridge usage --days 10');
