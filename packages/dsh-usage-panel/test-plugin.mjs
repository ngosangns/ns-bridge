// Flow test for the dsh-usage-panel plugin.
//
// It checks four areas:
//   1. Package shape: what the plugin manager and the Cordis loader read.
//   2. Cordis registration: the exact constructor call a fiber makes.
//   3. Numbers: credit math and budget rows on a fixed fixture.
//   4. RPC contract: payload safety and the client endpoint.
//
// Run it from OUTSIDE the repo, through the profile symlink, so bare imports
// resolve the same way the app resolves them:
//
//   cd /tmp && node --preserve-symlinks-main --preserve-symlinks \
//     "$HOME/.dsh/profiles/desktop/node_modules/@local/dsh-usage-panel/test-plugin.mjs"
//
// A green run is NOT the final proof. The final proof is the panel rendering
// at http://127.0.0.1:64043 with no "Failed to load usage". Step 9 prints that
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

function check(name, fn) {
	try {
		const detail = fn();
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

check('exports maps every shipped entry point', () => {
	const need = { '.': './index.js', './client': './client.js', './package.json': './package.json' };
	for (const [key, value] of Object.entries(need)) {
		assert.equal(pkg.exports[key], value, 'exports[' + key + ']');
	}
	assert.ok(pkg.exports['./cordis.patch.yml'], 'exports ./cordis.patch.yml missing');
	return Object.keys(pkg.exports).length + ' exports';
});
check('files covers the runtime and the patch', () => {
	for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
		assert.ok(pkg.files.includes(f), 'files missing ' + f);
	}
	return pkg.files.join(',');
});
check('dsh.bundle.patch is present so install_bundle accepts the dir', () => {
	assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
	return 'ok';
});
check('cordis.patch.yml inserts this plugin by its package name', () => {
	assert.match(patchText, /id:\s*dsh-usage-panel/);
	assert.match(patchText, /name:\s*'@local\/dsh-usage-panel'/);
	return 'ok';
});
check('runtime imports are declared as peers', () => {
	const imported = [...indexText.matchAll(/from\s+'(@[^']+)'/g)].map((m) => m[1]);
	for (const spec of imported) {
		assert.ok(pkg.peerDependencies[spec], spec + ' imported but not declared');
	}
	return imported.join(',');
});
check('no peer is pinned to an exact version', () => {
	for (const [name, range] of Object.entries(pkg.peerDependencies)) {
		assert.match(range, /(\^|>=)/, name + ' must stay a range: the app bundle differs from disk');
	}
	return 'ok';
});
check('host half uses the Form B service-class idiom', () => {
	assert.match(indexText, /export default class \w+ extends TypertRemoteService/);
	assert.ok(!/export const inject/.test(indexText), 'export const inject in host half');
	assert.ok(!/ctx\.provide\s*\(/.test(indexText), 'ctx.provide does not exist on a Cordis ctx');
	return 'ok';
});
check('host half has no tsconfig or build step to go stale', () => {
	assert.ok(!existsSync(join(PKG_DIR, 'tsconfig.json')), 'tsconfig.json still present');
	return 'ok';
});

// ---------------------------------------------------------------------------
// 2. Fixture: a fixed ledger with hand-computed answers.
//    Day folders, newest first: 12 11 10 9 8 6 5 4 3 2 | 1
//    The default window is 10 folders, so day 1 stays outside it.
//    Days 6 and 2 are empty folders: a day with no steps.
// ---------------------------------------------------------------------------
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

// Budgets: a flat map. used is stale and must be ignored. 0 and non-objects are skipped.
writeFileSync(
	join(RUN_ROOT, 'credit-budgets.json'),
	JSON.stringify({ kiro: { budget: 100, used: 999 }, devin: { budget: 50 }, qoder: { budget: 5, used: 0 }, broken: { budget: 0 }, nope: 'string' }),
	'utf8',
);
process.env.NS_BRIDGE_USAGE_DIR = USAGE_DIR;

// ---------------------------------------------------------------------------
// 3. Service construction: the exact call the Cordis fiber makes.
// ---------------------------------------------------------------------------
console.log('2. cordis registration');
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

check('service key is usage', () => {
	assert.equal(service.name, 'usage');
	return 'ok';
});
check('registered once on ctx.reflect.provide under usage', () => {
	assert.equal(provided.length, 1, 'expected one provide, got ' + provided.length);
	assert.equal(provided[0].name, 'usage');
	assert.equal(provided[0].impl, service, 'provide must receive the instance');
	return 'ok';
});
check('gateway namespace is usage', () => {
	assert.equal(service.typertRemote && service.typertRemote.namespace, 'usage');
	return 'namespace=' + service.typertRemote.namespace;
});
check('getUsageSummary is visible to the gateway reader', () => {
	// remoteMethods is the same public reader the RPC gateway uses. A missing
	// marker makes usage/getUsageSummary fail and the panel shows panel.error.
	const marks = tp.remoteMethods(service);
	const names = marks.map((m) => m?.exportName ?? m?.method);
	assert.ok(names.includes('getUsageSummary'), 'remoteMethods returned: ' + JSON.stringify(names));
	assert.deepEqual(logs, [], 'constructor logged: ' + logs.join(' | '));
	return names.join(',');
});

// ---------------------------------------------------------------------------
// 4. Summary math on the fixture.
// ---------------------------------------------------------------------------
console.log('3. summary math');
const rows = service.getUsageSummary();
const rowOf = (vendor, model) => {
	const hit = rows.filter((r) => r.vendor === vendor && r.model === model);
	assert.equal(hit.length, 1, 'rows for ' + vendor + '/' + model + ' = ' + hit.length);
	return hit[0];
};

check('row count matches the fixture', () => {
	assert.equal(rows.length, 9, 'rows=' + rows.length + ' ' + JSON.stringify(rows.map((r) => r.vendor + '/' + r.model)));
	return '9 rows';
});
check('native credits pass through unchanged', () => {
	assert.equal(rowOf('kiro', 'claude-opus-5-5').totalCredits, 5);
	return '5';
});
check('usd credits convert at 0.04 USD per credit', () => {
	const row = rowOf('kiro', 'claude-haiku-4-5');
	assert.equal(row.billedCredits, 12.5);
	assert.equal(row.totalCredits, 12.5);
	return '0.5 USD -> 12.5 credits';
});
check('unknown credit unit is not a credit amount', () => {
	const row = rowOf('old', 'weird');
	assert.equal(row.billedCredits, 0, 'unit tokens must not sum into credits');
	return 'ok';
});
check('priced estimate uses the long-context band', () => {
	assert.equal(rowOf('grok', 'grok-4.7').totalCredits, 15.3);
	return '15.3';
});
check('estimate without cacheRead uses fresh input only', () => {
	assert.equal(rowOf('kiro', 'claude-sonnet-5-5').totalCredits, 10.25);
	return '10.25';
});
check('tier label with no rate prices to zero, not a guess', () => {
	const row = rowOf('qoder', 'ultimate');
	assert.equal(row.totalCredits, 0);
	assert.equal(row.totalTokens, 5100);
	return 'ok';
});
check('empty model id becomes unknown', () => {
	assert.ok(rows.some((r) => r.vendor === 'kiro' && r.model === 'unknown'));
	return 'ok';
});
check('totalTokens is promptTokens + output, never input + cacheRead again', () => {
	assert.equal(rowOf('kiro', 'claude-sonnet-5-5').totalTokens, 201000);
	assert.equal(rowOf('grok', 'grok-4.7').totalTokens, 301000);
	return 'ok';
});
check('sessions count distinct ids, not lines', () => {
	assert.equal(rowOf('kiro', 'claude-opus-5-5').sessionCount, 1);
	return 'ok';
});
check('malformed ledger lines are skipped', () => {
	assert.ok(!rows.some((r) => r.vendor === 'bad'), 'a bad row survived validation');
	return 'ok';
});
check('default window is the 10 newest day folders', () => {
	assert.equal(rowOf('old', 'x').totalTokens, 1000, 'day 4 must be inside the window');
	assert.ok(!rows.some((r) => r.model === 'gone'), 'day 1 must sit outside the window');
	return 'ok';
});

// ---------------------------------------------------------------------------
// 5. Budget rows and the remaining-credit contract the client reads.
// ---------------------------------------------------------------------------
console.log('4. budgets');
check('remainingCredits = budget - vendor total, ignoring stale used', () => {
	assert.equal(rowOf('kiro', 'claude-opus-5-5').remainingCredits, 72.25);
	return '100 - 27.75 = 72.25';
});
check('every row of a vendor carries the same remainingCredits', () => {
	const kiroRows = rows.filter((r) => r.vendor === 'kiro');
	assert.ok(kiroRows.length > 1, 'fixture needs several kiro rows');
	const values = new Set(kiroRows.map((r) => r.remainingCredits));
	assert.equal(values.size, 1, 'client reads only the first row per vendor: ' + [...values]);
	return 'ok';
});
check('vendor without a budget reports zero, never undefined', () => {
	assert.equal(rowOf('grok', 'grok-4.7').remainingCredits, 0);
	return 'ok';
});
check('budgeted vendor with no usage still gets a row', () => {
	const devin = rows.filter((r) => r.vendor === 'devin');
	assert.equal(devin.length, 1);
	assert.equal(devin[0].remainingCredits, 50);
	assert.equal(devin[0].totalCredits, 0);
	return 'ok';
});
check('budget of zero and non-object entries are dropped', () => {
	assert.ok(!rows.some((r) => r.vendor === 'broken' || r.vendor === 'nope'));
	return 'ok';
});

// ---------------------------------------------------------------------------
// 6. Config override and the no-data path.
// ---------------------------------------------------------------------------
console.log('5. config and empty paths');
check('panelConfig.days trims the window', () => {
	const one = new UsageService(makeCtx(), { days: 1 });
	const r = one.getUsageSummary();
	assert.equal(r.length, 3, 'expected kiro day 12 plus two zero rows, got ' + JSON.stringify(r.map((x) => x.vendor + '/' + x.model)));
	assert.ok(r.some((x) => x.vendor === 'kiro' && x.model === 'claude-opus-5-5'));
	assert.ok(!r.some((x) => x.vendor === 'grok'), 'grok is only on day 9');
	assert.ok(!r.some((x) => x.vendor === 'old'), 'old must be outside a one day window');
	return '3 rows';
});
check('missing config object still works', () => {
	const bare = new UsageService(makeCtx(), undefined);
	assert.ok(Array.isArray(bare.getUsageSummary()));
	return 'ok';
});
check('missing usage dir keeps budget rows and never throws', () => {
	const saved = process.env.NS_BRIDGE_USAGE_DIR;
	process.env.NS_BRIDGE_USAGE_DIR = join(RUN_ROOT, 'does-not-exist');
	const out = new UsageService(makeCtx(), {}).getUsageSummary();
	process.env.NS_BRIDGE_USAGE_DIR = saved;
	assert.ok(Array.isArray(out), 'expected an array');
	assert.equal(out.length, 3, 'budget rows must stay: ' + JSON.stringify(out.map((r) => r.vendor)));
	for (const row of out) {
		assert.equal(row.totalCredits, 0, row.vendor + ' has no usage');
		assert.equal(row.sessionCount, 0, row.vendor + ' has no session');
	}
	return '3 budget-only rows';
});
check('no usage dir and no budget file returns an empty array', () => {
	const saved = process.env.NS_BRIDGE_USAGE_DIR;
	const emptyRoot = join(tmpdir(), 'dsh-usage-panel-empty-' + process.pid);
	process.env.NS_BRIDGE_USAGE_DIR = join(emptyRoot, 'usage');
	const out = new UsageService(makeCtx(), {}).getUsageSummary();
	process.env.NS_BRIDGE_USAGE_DIR = saved;
	assert.deepEqual(out, []);
	return 'ok';
});
check('bad NS_BRIDGE_PI_CATALOG path keeps the rows', () => {
	const saved = process.env.NS_BRIDGE_PI_CATALOG;
	process.env.NS_BRIDGE_PI_CATALOG = join(RUN_ROOT, 'not-a-catalog.json');
	const out = service.getUsageSummary();
	process.env.NS_BRIDGE_PI_CATALOG = saved;
	assert.equal(out.length, 9, 'a missing catalog must not change the native rows');
	return 'ok';
});

// ---------------------------------------------------------------------------
// 7. RPC payload safety: the gateway rejects -0, NaN, undefined and cycles.
// ---------------------------------------------------------------------------
console.log('6. rpc payload safety');
check('payload is strict JSON with finite numbers', () => {
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
	for (const row of rows) {
		for (const key of ['vendor', 'model', 'totalTokens', 'totalCredits', 'billedCredits', 'sessionCount', 'remainingCredits']) {
			assert.ok(key in row, 'row missing ' + key);
		}
	}
	visit(rows, new Set());
	const text = JSON.stringify(rows);
	assert.ok(!text.includes('undefined'), 'stringify contains undefined');
	return text.length + ' bytes';
});

// ---------------------------------------------------------------------------
// 8. Client contract: endpoint, fields, locale keys.
// ---------------------------------------------------------------------------
console.log('7. client contract');
check('client calls the endpoint the host registers', () => {
	assert.match(clientText, /usage\/getUsageSummary/);
	assert.match(clientText, /rpc\.call\(\s*['"]\/api['"]/);
	return 'ok';
});
check('client passes an empty args object', () => {
	assert.match(clientText, /getUsageSummary['"],\s*\{\s*args:\s*\{\}\s*\}/, 'rpc args shape changed');
	return 'ok';
});
check('client reads only fields the host returns', () => {
	const read = new Set([...clientText.matchAll(/\b(?:row|item|r|entry)\.(vendor|model|totalTokens|totalCredits|billedCredits|sessionCount|remainingCredits)\b/g)].map((m) => m[1]));
	const schema = new Set(Object.keys(rows[0] ?? {}));
	for (const field of read) {
		assert.ok(schema.has(field), 'client reads ' + field + ' which the host never returns');
	}
	for (const field of ['vendor', 'model', 'totalTokens', 'totalCredits', 'sessionCount', 'remainingCredits']) {
		assert.ok(schema.has(field), field);
	}
	return read.size + ' fields used';
});
check('every locale key the client asks for is defined', () => {
	const used = new Set([...clientText.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1]));
	const defined = new Set([...clientText.matchAll(/['"]([a-z][\w.]*\.[\w.]+)['"]\s*:/g)].map((m) => m[1]));
	const missing = [...used].filter((k) => !defined.has(k));
	assert.deepEqual(missing, [], 'keys used but not registered: ' + missing.join(','));
	return used.size + ' keys, all defined';
});
check('locale files still carry the plugin meta strings', () => {
	for (const lang of ['en', 'vi']) {
		const data = JSON.parse(readFileSync(join(PKG_DIR, 'locale', lang + '.json'), 'utf8'));
		assert.equal(typeof data.meta.title, 'string', lang + '.meta.title');
		assert.equal(typeof data.meta.description, 'string', lang + '.meta.description');
	}
	return 'ok';
});
check('client half declares its inject list', () => {
	assert.match(clientText, /inject:\s*\[[^\]]*'slots'[^\]]*\]/);
	return 'ok';
});

// ---------------------------------------------------------------------------
// 9. Cleanup and the manual app check.
// ---------------------------------------------------------------------------
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
console.log('  2. Open the panel in the right sidebar at http://127.0.0.1:64043.');
console.log('  3. The panel must show rows. It must not show "Failed to load usage".');
console.log('  4. Check the credit numbers against: ns-bridge usage --days 10');
