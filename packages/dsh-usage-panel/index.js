import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';

// Ledger reading follows packages/cli/src/usage.ts: same root, same day window,
// same record validation. The panel and `ns-bridge usage` never disagree.
const DEFAULT_USAGE_DAYS = 10;
const MAX_USAGE_DAYS = 30;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_SOURCES = new Set(['wire', 'credits', 'credits-capped', 'none']);
const PER_MILLION = 1_000_000;
// One credit unit for every vendor: packages/kiro-core/src/usage-tracking.ts:8.
const USD_PER_CREDIT = 0.04;
const NATIVE_CREDIT_UNITS = new Set(['credit', 'credits']);
/**
 * One limit for every vendor, for a host that has no budget file. When neither
 * the budget file nor this variable gives a limit, a vendor reports no credits
 * left. The panel never invents an example quota, because a made-up number in
 * a budget bar reads as a real one.
 */
const FALLBACK_BUDGET_ENV = 'NS_BRIDGE_CREDIT_LIMIT';
// The model label on a row that exists only to carry a budget.
const NO_USAGE_MODEL = 'no usage';

/**
 * Cold-start price table, USD per one million tokens. The values were read from
 * @oh-my-pi/pi-catalog 18.8.0 models.json. That package is not a dependency: it
 * exports only `./src/index.ts`, so importing it would break this bundle. The
 * table is plain data. NS_BRIDGE_PI_CATALOG points at a models.json to override it.
 */
const MODEL_RATES = {
	'anthropic.claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	'anthropic.claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	'anthropic.claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'anthropic.claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'anthropic.claude-haiku-5-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'openai.gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	'openai.gpt-5.6-luna': {
		input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25,
		longContext: { inputThreshold: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
	},
	'xai.grok-4.7': {
		input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0,
		longContext: { inputThreshold: 200000, inclusive: true, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
	},
	'xai.grok-4.6': {
		input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0,
		longContext: { inputThreshold: 200000, inclusive: true, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
	},
	'xai.grok-4.5': { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	'xai.grok-4': { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 },
	'deepseek.deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	'deepseek.deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	'deepseek.deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
};

// Ledger vendor id -> provider id in the price catalog.
const VENDOR_PROVIDERS = { grok: 'xai', kiro: 'anthropic', deepseek: 'deepseek', openai: 'openai' };

/**
 * Qoder serves opaque ids. packages/qoder-core/src/catalog.ts:81 states
 * `dfmodel: "DeepSeek-Flash"`, so that alias resolves to a real price. The other
 * aliases name a tier, not a model, so they keep no rate and report zero cost
 * rather than a guessed number.
 */
const MODEL_ALIASES = { dfmodel: 'deepseek.deepseek-flash', dmodel: 'deepseek.deepseek-v4-pro' };

// The ledger writes `gpt-5-6-luna`, the catalog writes `gpt-5.6-luna`.
// This index holds the dash form of every table key and every alias.
const DASHED_KEYS = new Map();
for (const key of Object.keys(MODEL_RATES)) DASHED_KEYS.set(key.replace(/\./g, '-'), MODEL_RATES[key]);
for (const [alias, key] of Object.entries(MODEL_ALIASES)) DASHED_KEYS.set(alias, MODEL_RATES[key]);

function num(value, fallback = 0) {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Object.is(parsed, -0) ? 0 : parsed; // RPC rejects -0 and non-finite numbers.
}

function round(value) {
	return num(Math.round(num(value) * 1e6) / 1e6);
}

function envText(name) {
	const value = process.env[name];
	if (typeof value !== 'string') return '';
	return value.trim();
}

function usageRoot() {
	const configured = envText('NS_BRIDGE_USAGE_DIR');
	if (configured !== '') return configured;
	return join(homedir(), '.ns-bridge', 'usage');
}

function budgetPath() {
	return join(usageRoot(), '..', 'credit-budgets.json');
}

function readJsonFile(path) {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/** credit-budgets.json is a flat map: { kiro: { budget, used } }. `used` is stale. */
function loadBudgets() {
	const data = readJsonFile(budgetPath());
	const budgets = new Map();
	if (!data || typeof data !== 'object') return budgets;
	for (const [vendor, entry] of Object.entries(data)) {
		if (!entry || typeof entry !== 'object') continue;
		const budget = num(entry.budget, NaN);
		if (Number.isFinite(budget) && budget > 0) budgets.set(vendor, budget);
	}
	return budgets;
}

/** One limit for every vendor, for a host that has no budget file. */
function envBudget() {
	const budget = num(envText(FALLBACK_BUDGET_ENV), NaN);
	return Number.isFinite(budget) && budget > 0 ? budget : NaN;
}

function loadCatalog() {
	const path = envText('NS_BRIDGE_PI_CATALOG');
	if (path === '') return null;
	const data = readJsonFile(path);
	if (!data || typeof data !== 'object') return null;
	return data;
}

function catalogEntry(catalog, provider, modelId) {
	if (!catalog || !provider) return null;
	const providerBlock = catalog[provider];
	if (!providerBlock || typeof providerBlock !== 'object') return null;
	const model = providerBlock[modelId];
	const cost = model?.cost;
	if (!cost || typeof cost !== 'object') return null;
	return {
		input: num(cost.input),
		output: num(cost.output),
		cacheRead: num(cost.cacheRead),
		cacheWrite: num(cost.cacheWrite),
		longContext: model.longContext && typeof model.longContext === 'object' ? model.longContext : null,
	};
}

/** Rates for one ledger model id, or null when nothing can price it. */
function resolveRates(vendor, modelId, catalog) {
	if (typeof modelId !== 'string' || modelId === '') return null;
	const id = modelId.toLowerCase();
	const provider = VENDOR_PROVIDERS[vendor];
	const exact = catalogEntry(catalog, provider, id);
	if (exact) return exact;
	if (MODEL_ALIASES[id]) return MODEL_RATES[MODEL_ALIASES[id]];
	if (provider && MODEL_RATES[`${provider}.${id}`]) return MODEL_RATES[`${provider}.${id}`];
	const byTable = DASHED_KEYS.get(`${provider}.${id}`) ?? DASHED_KEYS.get(id);
	if (byTable) return byTable;
	return catalogEntry(catalog, provider, id.replace(/-/g, '.'));
}

function longContextRates(rates, promptTokens) {
	const lc = rates?.longContext;
	if (!lc || typeof lc.inputThreshold !== 'number') return null;
	const past = lc.inclusive || lc.inputThresholdInclusive
		? promptTokens >= lc.inputThreshold
		: promptTokens > lc.inputThreshold;
	return past ? lc : null;
}

/** Estimated credits for a step the provider did not bill in credits. */
function estimateCredits(vendor, record, catalog) {
	const rates = resolveRates(vendor, record.model, catalog);
	if (!rates) return 0;
	const promptTokens = num(record.promptTokens);
	const cacheRead = num(record.cacheRead);
	const cacheWrite = num(record.cacheWrite);
	// Ledger invariant: promptTokens = input + cacheRead.
	const fresh = typeof record.input === 'number' ? num(record.input) : Math.max(0, promptTokens - cacheRead);
	const long = longContextRates(rates, promptTokens);
	const cost =
		fresh * num(long?.input, rates.input) +
		num(record.output) * num(long?.output, rates.output) +
		cacheRead * num(long?.cacheRead, rates.cacheRead) +
		cacheWrite * num(long?.cacheWrite, rates.cacheWrite);
	if (!Number.isFinite(cost) || cost <= 0) return 0;
	return cost / PER_MILLION / USD_PER_CREDIT;
}

/** What the provider billed for the step, normalized to credits. */
function billedCredits(record) {
	const credits = num(record.credits, 0);
	if (credits <= 0) return 0;
	const unit = typeof record.creditUnit === 'string' ? record.creditUnit.toLowerCase() : '';
	if (NATIVE_CREDIT_UNITS.has(unit)) return credits;
	if (unit === 'usd') return credits / USD_PER_CREDIT;
	return 0; // A unit this panel cannot name is not a credit amount.
}

function dayFolders(root) {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && DAY_PATTERN.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

/**
 * How many day folders to read. `packages/cli/src/usage.ts:86` uses the same
 * rule: the newest N folders, N from the config, default DEFAULT_USAGE_DAYS.
 * Reading more days would put rows in the panel that the CLI does not show.
 */
function windowDays(config) {
	const wanted = Math.floor(num(config?.days, DEFAULT_USAGE_DAYS));
	if (wanted < 1) return 1;
	return Math.min(wanted, MAX_USAGE_DAYS);
}

/** Records with the day folder they came from, newest folder first. */
function readRecords(root, days) {
	const found = [];
	for (const day of days) {
		const dayPath = join(root, day);
		let vendors;
		try {
			vendors = readdirSync(dayPath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch {
			continue;
		}
		for (const vendor of vendors) {
			const vendorPath = join(dayPath, vendor);
			let files;
			try {
				files = readdirSync(vendorPath).filter((name) => name.endsWith('.jsonl')).sort();
			} catch {
				continue;
			}
			for (const file of files) {
				let text;
				try {
					text = readFileSync(join(vendorPath, file), 'utf8');
				} catch {
					continue;
				}
				for (const line of text.split('\n')) {
					if (line.trim() === '') continue;
					let value;
					try {
						value = JSON.parse(line);
					} catch {
						continue;
					}
					// Same validation as parseLine in packages/cli/src/usage.ts.
					if (!value || typeof value !== 'object') continue;
					if (typeof value.vendor !== 'string') continue;
					if (typeof value.promptTokens !== 'number') continue;
					if (!CACHE_SOURCES.has(value.cacheSource)) continue;
					found.push({ day, record: value });
				}
			}
		}
	}
	return found;
}

/** One aggregate per vendor and model inside the window. */
function emptyGroup(vendor, model) {
	return {
		vendor,
		model,
		billed: 0,
		estimated: 0,
		promptTokens: 0,
		outputTokens: 0,
		sessions: new Set(),
	};
}

/** The credit limit for one vendor: budget file first, then the environment. */
function vendorBudget(budgets, fallback, vendor) {
	if (budgets.has(vendor)) return budgets.get(vendor);
	return fallback;
}

/**
 * Credits a vendor still has. A vendor with no limit reports zero, never a
 * number this panel invented, because a made-up limit reads as a real quota.
 * Spending more than the limit also reports zero.
 */
function creditsLeft(budget, spent) {
	if (!Number.isFinite(budget)) return 0;
	return Math.max(0, round(budget - num(spent)));
}

/** A row for a budgeted vendor that used nothing inside the window. */
function budgetRow(vendor, budget) {
	return {
		vendor: String(vendor),
		model: NO_USAGE_MODEL,
		totalTokens: 0,
		totalCredits: 0,
		billedCredits: 0,
		sessionCount: 0,
		remainingCredits: creditsLeft(budget, 0),
	};
}

export default class UsageService extends TypertRemoteService {
	constructor(ctx, config) {
		super(ctx, 'usage', { namespace: 'usage' });
		// Cordis passes the plugin config as the second constructor argument.
		// The field is named here so it cannot collide with a base-class field.
		this.panelConfig = config && typeof config === 'object' ? config : {};
		// The gateway only exposes a method it can see in remoteMethods. Without the
		// marker the call fails and the panel shows "Failed to load usage", so report
		// it here where a real logger exists.
		if (!hasRemoteMethod(this, 'getUsageSummary')) {
			warn(this.ctx, 'usage/getUsageSummary is not registered as a remote method');
		}
	}

	/**
	 * Called through the RPC gateway with no arguments. Returns a flat array of
	 * rows, one per vendor and model. A failure returns an empty array, so the
	 * panel shows an empty table instead of a half-built one.
	 */
	getUsageSummary() {
		try {
			return buildRows(this.panelConfig);
		} catch (error) {
			warn(this.ctx, 'usage summary failed: ' + String(error?.message ?? error));
			return [];
		}
	}
}

/**
 * One row per vendor and model in the window. The grouping has no day
 * dimension: the window is one period, and these rows add up to what
 * `ns-bridge usage --days N` reports for the same days. A budgeted vendor with
 * no usage in the window still gets a row, so its budget stays visible.
 * Every number here is JSON-safe: RPC rejects -0, NaN, and undefined.
 */
function buildRows(config) {
	const root = usageRoot();
	const days = dayFolders(root).slice(0, windowDays(config));
	const records = days.length > 0 ? readRecords(root, days) : [];
	const catalog = loadCatalog();
	const groups = new Map();

	for (const entry of records) {
		const record = entry.record;
		const vendor = record.vendor;
		const model = typeof record.model === 'string' && record.model !== '' ? record.model : 'unknown';
		const key = `${vendor}\u0000${model}`;
		let group = groups.get(key);
		if (!group) {
			group = emptyGroup(vendor, model);
			groups.set(key, group);
		}
		// A step the provider billed in credits needs no price estimate.
		const billed = billedCredits(record);
		group.billed += billed;
		group.estimated += billed > 0 ? 0 : estimateCredits(vendor, record, catalog);
		group.promptTokens += num(record.promptTokens);
		group.outputTokens += num(record.output);
		const session = typeof record.session === 'string' ? record.session : '';
		if (session !== '') group.sessions.add(session);
	}

	const spent = new Map();
	for (const group of groups.values()) {
		const vendor = String(group.vendor);
		spent.set(vendor, num(spent.get(vendor)) + group.billed + group.estimated);
	}
	const budgets = loadBudgets();
	const fallback = envBudget();

	const rows = [...groups.values()].map((group) => {
		const vendor = String(group.vendor);
		return {
			vendor,
			model: String(group.model),
			totalTokens: round(group.promptTokens + group.outputTokens),
			totalCredits: round(group.billed + group.estimated),
			billedCredits: round(group.billed),
			sessionCount: round(group.sessions.size),
			remainingCredits: creditsLeft(vendorBudget(budgets, fallback, vendor), num(spent.get(vendor))),
		};
	});

	for (const [vendor, budget] of budgets) {
		if (spent.has(vendor)) continue;
		rows.push(budgetRow(vendor, budget));
	}

	// Vendor first, then the biggest spend, so the first row of a vendor is the
	// one the client reads for its budget bar.
	return rows.sort((a, b) => {
		const byVendor = a.vendor.localeCompare(b.vendor);
		if (byVendor !== 0) return byVendor;
		if (a.totalCredits !== b.totalCredits) return b.totalCredits - a.totalCredits;
		return a.model.localeCompare(b.model);
	});
}


function warn(ctx, message) {
	try {
		ctx?.log?.('usage')?.warn?.(message);
	} catch {
		// Never let logging break a call.
	}
}

/**
 * True when the gateway can already see the method as remote.
 * `remoteMethods` reads the marker off the prototype of a live service, so pass
 * an object whose prototype carries the marker, never the prototype itself.
 */
function hasRemoteMethod(service, name) {
	try {
		return remoteMethods(service).some((marker) => marker.method === name);
	} catch {
		return false;
	}
}

/**
 * Register a method as remote without TypeScript.
 * The compiled decorator calls Remote(method, context). This reproduces that
 * call, then runs the initializer Remote captures on a prototype-backed object,
 * which is where Remote writes its marker.
 */
function markRemoteMethod(proto, name) {
	if (hasRemoteMethod(Object.create(proto), name)) return;
	try {
		const method = proto[name];
		if (typeof method !== 'function') return;
		let captured;
		Remote(method, {
			kind: 'method',
			name,
			static: false,
			private: false,
			addInitializer(fn) {
				captured = fn;
			},
		});
		if (typeof captured !== 'function') return;
		captured.call(Object.create(proto));
	} catch {
		// A host whose decorator runtime differs keeps its own marker.
	}
}

markRemoteMethod(UsageService.prototype, 'getUsageSummary');
