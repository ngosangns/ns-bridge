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
const TOP_SESSIONS = 20;
const SCHEMA_VERSION = 1;
/**
 * Standalone DSH runs with no ns-bridge config, so it has no real limit. When
 * neither the budget file nor the environment gives one, the panel shows this
 * example limit and labels its source so nobody reads it as a real quota.
 */
const FALLBACK_BUDGET_CREDITS = 200;
const FALLBACK_BUDGET_ENV = 'NS_BRIDGE_CREDIT_LIMIT';
// Only this many digits survive. The panel never accepts an arbitrary number.
const WINDOW_CHOICES = [1, 3, 5, 10];

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
 * How many day folders to read. The default covers the whole window the panel
 * can select, so a shorter period is a filter over these rows and never a
 * second round trip. `days` in the plugin config narrows the read.
 */
function windowDays(config) {
	const wanted = Math.floor(num(config.days, MAX_USAGE_DAYS));
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

function emptyGroup(vendor, model) {
	return {
		vendor,
		model,
		credits: 0,
		billed: 0,
		estimated: 0,
		promptTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		stepCount: 0,
		sessions: new Set(),
	};
}

function emptySession(vendor, session) {
	return {
		vendor,
		session,
		usedCredits: 0,
		totalTokens: 0,
		stepCount: 0,
		firstDay: '',
		lastDay: '',
		models: new Map(),
	};
}

/** The whole payload is optional; a snapshot always stands on its own. */
function emptySnapshot(reason) {
	return {
		schemaVersion: SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		error: typeof reason === 'string' ? reason : '',
		usageRoot: usageRoot(),
		budgetFile: budgetPath(),
		defaultDays: DEFAULT_USAGE_DAYS,
		maxDays: MAX_USAGE_DAYS,
		windowChoices: WINDOW_CHOICES.slice(),
		availableDays: [],
		from: '',
		to: '',
		limits: [],
		rows: [],
		sessions: [],
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

	/** Called through the RPC gateway with no arguments. Returns one snapshot. */
	getUsageSummary() {
		try {
			return this.buildSnapshot();
		} catch (error) {
			const reason = 'usage summary failed: ' + String(error?.message ?? error);
			warn(this.ctx, reason);
			return emptySnapshot(reason);
		}
	}

	/**
	 * One row per day, vendor, and model. The row is the fact; every total, bar,
	 * and chart point is a sum of rows taken by the panel. Nothing is clamped, so
	 * a vendor that spent more than its limit still shows its real usage.
	 */
	buildSnapshot() {
		const root = usageRoot();
		const allDays = dayFolders(root);
		const days = allDays.slice(0, windowDays(this.panelConfig));
		const records = days.length > 0 ? readRecords(root, days) : [];
		const catalog = loadCatalog();
		const groups = new Map();
		const sessionMap = new Map();

		for (const entry of records) {
			const record = entry.record;
			const vendor = record.vendor;
			const model = typeof record.model === 'string' && record.model !== '' ? record.model : 'unknown';
			const key = `${entry.day}\u0000${vendor}\u0000${model}`;
			let group = groups.get(key);
			if (!group) {
				group = emptyGroup(vendor, model);
				groups.set(key, group);
			}
			const billed = billedCredits(record);
			const estimated = billed > 0 ? 0 : estimateCredits(vendor, record, catalog);
			const promptTokens = num(record.promptTokens);
			group.billed += billed;
			group.estimated += estimated;
			group.credits += billed > 0 ? billed : estimated;
			group.promptTokens += promptTokens;
			group.outputTokens += num(record.output);
			group.cacheReadTokens += num(record.cacheRead);
			group.cacheWriteTokens += num(record.cacheWrite);
			group.stepCount += 1;

			const session = typeof record.session === 'string' && record.session !== '' ? record.session : '';
			if (session === '') continue;
			group.sessions.add(session);
			const sessionKey = `${vendor}\u0000${session}`;
			let aggregate = sessionMap.get(sessionKey);
			if (!aggregate) {
				aggregate = emptySession(vendor, session);
				sessionMap.set(sessionKey, aggregate);
			}
			const used = billed > 0 ? billed : estimated;
			aggregate.usedCredits += used;
			aggregate.totalTokens += promptTokens + num(record.output);
			aggregate.stepCount += 1;
			if (aggregate.firstDay === '' || entry.day < aggregate.firstDay) aggregate.firstDay = entry.day;
			if (aggregate.lastDay === '' || entry.day > aggregate.lastDay) aggregate.lastDay = entry.day;
			const perModel = num(aggregate.models.get(model)) + used;
			aggregate.models.set(model, perModel);
		}

		const rows = [...groups.entries()]
			.map(([key, group]) => ({
				day: key.split('\u0000')[0],
				vendor: String(group.vendor),
				model: String(group.model),
				promptTokens: round(group.promptTokens),
				outputTokens: round(group.outputTokens),
				cacheReadTokens: round(group.cacheReadTokens),
				cacheWriteTokens: round(group.cacheWriteTokens),
				totalTokens: round(group.promptTokens + group.outputTokens),
				usedCredits: round(group.credits),
				billedCredits: round(group.billed),
				estimatedCredits: round(group.estimated),
				stepCount: round(group.stepCount),
				sessionCount: round(group.sessions.size),
			}))
			.sort((a, b) => {
				if (a.day !== b.day) return a.day < b.day ? 1 : -1;
				if (a.vendor !== b.vendor) return String(a.vendor).localeCompare(String(b.vendor));
				return b.usedCredits - a.usedCredits;
			});

		const sessions = [...sessionMap.values()]
			.map((aggregate) => {
				let topModel = '';
				let topCredits = -1;
				for (const [model, credits] of aggregate.models) {
					if (credits > topCredits) {
						topCredits = credits;
						topModel = model;
					}
				}
				return {
					vendor: String(aggregate.vendor),
					session: String(aggregate.session),
					model: String(topModel),
					usedCredits: round(aggregate.usedCredits),
					totalTokens: round(aggregate.totalTokens),
					stepCount: round(aggregate.stepCount),
					firstDay: String(aggregate.firstDay),
					lastDay: String(aggregate.lastDay),
				};
			})
			.sort(
				(a, b) =>
					b.usedCredits - a.usedCredits ||
					b.lastDay.localeCompare(a.lastDay) ||
					a.session.localeCompare(b.session),
			)
			.slice(0, TOP_SESSIONS);

		const budgets = loadBudgets();
		const fallback = envBudget();
		const seen = new Set(rows.map((row) => row.vendor));
		for (const vendor of budgets.keys()) seen.add(vendor);

		const limits = [...seen]
			.sort((a, b) => String(a).localeCompare(String(b)))
			.map((vendor) => {
				if (budgets.has(vendor)) {
					return { vendor: String(vendor), limitCredits: round(budgets.get(vendor)), limitSource: 'file' };
				}
				if (Number.isFinite(fallback)) {
					return { vendor: String(vendor), limitCredits: round(fallback), limitSource: 'env' };
				}
				return { vendor: String(vendor), limitCredits: FALLBACK_BUDGET_CREDITS, limitSource: 'fallback' };
			});

		return {
			schemaVersion: SCHEMA_VERSION,
			generatedAt: new Date().toISOString(),
			error: '',
			usageRoot: root,
			budgetFile: budgetPath(),
			defaultDays: DEFAULT_USAGE_DAYS,
			maxDays: MAX_USAGE_DAYS,
			windowChoices: WINDOW_CHOICES.slice(),
			availableDays: days.slice(),
			from: days.length > 0 ? days[days.length - 1] : '',
			to: days.length > 0 ? days[0] : '',
			limits,
			rows,
			sessions,
		};
	}
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
