import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { isProviderVendor, refreshQuota } from './quota.js';

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
 * the budget file nor this variable gives a limit, a vendor reports `limit: null`
 * and the panel draws no budget bar. The panel never invents an example quota,
 * because a made-up number in a budget bar reads as a real one.
 */
const FALLBACK_BUDGET_ENV = 'NS_BRIDGE_CREDIT_LIMIT';
// The window lengths the panel offers as choices. The host reads at most this
// many day folders, so a choice here is never larger than MAX_USAGE_DAYS.
const WINDOW_CHOICES = [1, 3, 7, DEFAULT_USAGE_DAYS, MAX_USAGE_DAYS];
// Shape of the payload the client renders. A client that meets a higher version
// shows its error state instead of guessing at fields.
// Version 3 adds `quota`, the live allowance read from the vendor provider.
const SCHEMA_VERSION = 3;

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

/**
 * credit-budgets.json holds one object per vendor: `{ kiro: { budget, used } }`.
 * The panel reads `budget`, which is the user-declared limit. `used` is written by
 * another tool and is stale here, so the panel never reads it: it computes spent
 * from the ledger instead.
 */
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
 * How many day folders to read. `packages/cli/src/usage.ts` uses the same rule:
 * the newest N folders, N from the config, default DEFAULT_USAGE_DAYS.
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
						continue; // A half-written line is skipped, same as the CLI reader.
					}
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

/** One accumulator for a group: a vendor+model, a vendor, a day, or all days. */
function emptyGroup() {
	return {
		steps: 0,
		billed: 0,
		estimated: 0,
		promptTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		hitPrompt: 0,
		hitRead: 0,
		writePrompt: 0,
		writeTokens: 0,
		sessions: new Set(),
	};
}

/**
 * Fold one ledger step into a group. The cache ratios use the same rule as
 * `summarize` in packages/cli/src/usage.ts: a step whose ratio field is `null`
 * is left out of that ratio, and a step that has no such field still counts.
 */
function addRecord(group, record, billed, estimated) {
	const promptTokens = num(record.promptTokens);
	group.steps += 1;
	group.billed += billed;
	group.estimated += estimated;
	group.promptTokens += promptTokens;
	group.outputTokens += num(record.output);
	group.cacheRead += num(record.cacheRead);
	if (record.cacheHitRatio !== null) {
		group.hitPrompt += promptTokens;
		group.hitRead += num(record.cacheRead);
	}
	if (record.cacheWriteRatio !== null) {
		group.writePrompt += promptTokens;
		group.writeTokens += num(record.cacheWrite);
	}
	if (typeof record.session === 'string' && record.session !== '') {
		group.sessions.add(record.session);
	}
}

function groupOf(store, key) {
	let group = store.get(key);
	if (!group) {
		group = emptyGroup();
		store.set(key, group);
	}
	return group;
}

/**
 * Credits in three fields that always add up. `totalCredits` is rounded first, so
 * `billedCredits + estimatedCredits === totalCredits` holds on every row.
 */
function credits(group) {
	const total = round(group.billed + group.estimated);
	const billed = round(group.billed);
	return { totalCredits: total, billedCredits: billed, estimatedCredits: round(total - billed) };
}

/** A ratio, or null when no step in the group carried one. RPC rejects undefined. */
function ratio(part, whole) {
	if (!(whole > 0)) return null;
	return round(part / whole);
}

/** Fields every row reports about what was used. */
function usageFields(group) {
	return {
		steps: group.steps,
		sessionCount: group.sessions.size,
		totalTokens: round(group.promptTokens + group.outputTokens),
		promptTokens: round(group.promptTokens),
		outputTokens: round(group.outputTokens),
		cacheReadTokens: round(group.cacheRead),
		cacheHitRatio: ratio(group.hitRead, group.hitPrompt),
		cacheWriteRatio: ratio(group.writeTokens, group.writePrompt),
		...credits(group),
	};
}

/**
 * The limit for one vendor and where it came from. The provider owns the real
 * allowance, so a provider limit wins. Below it a file limit wins over the
 * environment variable, because a per-vendor budget is the more specific claim.
 */
function limitFor(vendor, budgets, fallback, quota) {
	if (quota && Number.isFinite(quota.limit)) return { limit: round(quota.limit), limitSource: 'provider' };
	if (budgets.has(vendor)) return { limit: round(budgets.get(vendor)), limitSource: 'file' };
	if (Number.isFinite(fallback)) return { limit: round(fallback), limitSource: 'env' };
	return { limit: null, limitSource: 'none' };
}

/**
 * limit minus spent, with no clamp. A negative number is the amount over budget,
 * and `null` means no declared limit, which is not the same as zero left.
 */
function creditsLeft(limit, spent) {
	if (!Number.isFinite(limit)) return null;
	return round(num(limit) - num(spent));
}

export default class UsageService extends TypertRemoteService {
	/**
	 * @param {import('@deepseek-ai/cordis').Ctx} ctx
	 * @param {{ days?: number } | undefined} config
	 */
	constructor(ctx, config) {
		super(ctx, 'usage', { namespace: 'usage' });
		this.panelConfig = config;
		// The gateway exposes a method only when the decorator marker is present.
		// A plain-JS plugin sets that marker by hand, so check the result here.
		// A host that reads the marker differently still answers the call.
		if (!hasRemoteMethod(this, 'getUsageSummary')) {
			warn(this.ctx, 'usage/getUsageSummary is not registered as a remote method');
		}
	}

	/**
	 * Called through the RPC gateway with no arguments. Returns the whole panel
	 * payload: window, totals, per-vendor limits, per-day series and per-model
	 * rows. A failure returns an empty payload, so the panel shows an empty state
	 * instead of a half-built one.
	 */
	async getUsageSummary() {
		try {
			return await buildSummary(this.panelConfig);
		} catch (error) {
			warn(this.ctx, 'usage summary failed: ' + String(error?.message ?? error));
			return emptySummary(windowDays(this.panelConfig));
		}
	}
}

/** A payload with no rows, so the client never has to handle a missing field. */
function emptySummary(days) {
	const group = emptyGroup();
	return {
		schemaVersion: SCHEMA_VERSION,
		window: { days, choices: [...WINDOW_CHOICES], from: null, to: null, folders: 0 },
		totals: usageFields(group),
		vendors: [],
		days: [],
		models: [],
	};
}

/**
 * The provider quota for one row, plus the early-warning tick. The budget file
 * stays a second, lower mark on the same bar, so the row shows both claims.
 * The cached quota object is shared, so this returns a copy and never writes
 * through to the cache. A row with no provider quota has no tick either.
 */
function withWarning(quota, budget) {
	if (!quota) return null;
	const tick = Number.isFinite(budget) ? round(budget) : null;
	// A tick outside the bar draws nothing, so it stays off.
	const warning = tick !== null && Number.isFinite(quota.limit) && tick > 0 && tick < quota.limit
		? tick
		: null;
	return { ...quota, warning };
}

/**
 * The panel payload, one period wide. `models` holds one row per vendor and
 * model, `days` one row per day, vendor and model, `vendors` one row per vendor
 * with its declared limit. All three cover the same window, so a day row and the
 * model row of the same vendor add up to the vendor row.
 * Every number here is JSON-safe: RPC rejects -0, NaN and undefined, and a ratio
 * with no data is null, never undefined.
 */
async function buildSummary(config) {
	const root = usageRoot();
	const wanted = windowDays(config);
	const dayList = dayFolders(root).slice(0, wanted);
	const records = dayList.length > 0 ? readRecords(root, dayList) : [];
	const catalog = loadCatalog();

	const all = emptyGroup();
	const byModel = new Map();
	const byDay = new Map();
	const byVendor = new Map();

	for (const entry of records) {
		const record = entry.record;
		const vendor = record.vendor;
		const model = typeof record.model === 'string' && record.model !== '' ? record.model : 'unknown';
		// A step the provider billed in credits needs no price estimate.
		const billed = billedCredits(record);
		const estimated = billed > 0 ? 0 : estimateCredits(vendor, record, catalog);
		addRecord(all, record, billed, estimated);
		addRecord(groupOf(byModel, `${vendor}\u0000${model}`), record, billed, estimated);
		addRecord(groupOf(byDay, `${entry.day}\u0000${vendor}\u0000${model}`), record, billed, estimated);
		addRecord(groupOf(byVendor, vendor), record, billed, estimated);
	}

	const budgets = loadBudgets();
	const fallback = envBudget();
	const spent = new Map();
	for (const [vendor, group] of byVendor) spent.set(vendor, group.billed + group.estimated);
	// A budgeted vendor with no usage in the window keeps a row, so its limit stays visible.
	for (const vendor of budgets.keys()) {
		if (!spent.has(vendor)) spent.set(vendor, 0);
	}

	// Provider reads run in parallel. Each one carries its own deadline, so a
	// slow account adds no more than that deadline to this call.
	const names = [...spent.keys()].sort();
	const quotas = new Map();
	await Promise.all(names.map(async (vendor) => {
		if (!isProviderVendor(vendor)) return;
		const found = await refreshQuota(vendor);
		if (found) quotas.set(vendor, found);
	}));

	const vendors = names.map((vendor) => {
		const group = byVendor.get(vendor) ?? emptyGroup();
		const found = quotas.get(vendor) ?? null;
		const limit = limitFor(vendor, budgets, fallback, found);
		const remaining = creditsLeft(limit.limit, num(spent.get(vendor)));
		return {
			vendor,
			...usageFields(group),
			limit: limit.limit,
			limitSource: limit.limitSource,
			remainingCredits: remaining,
			overLimit: remaining !== null && remaining < 0,
			quota: withWarning(found, budgets.get(vendor)),
		};
	});

	const models = [...byModel.entries()]
		.map(([key, group]) => ({
			vendor: String(key.split('\u0000')[0]),
			model: String(key.split('\u0000')[1]),
			...usageFields(group),
		}))
		.sort(compareModel);

	const days = [...byDay.entries()]
		.map(([key, group]) => {
			const parts = key.split('\u0000');
			return {
				day: String(parts[0]),
				vendor: String(parts[1]),
				model: String(parts[2]),
				...usageFields(group),
			};
		})
		.sort(compareDay);

	return {
		schemaVersion: SCHEMA_VERSION,
		window: {
			days: wanted,
			choices: [...WINDOW_CHOICES],
			from: days.length > 0 ? days[days.length - 1].day : null,
			to: days.length > 0 ? days[0].day : null,
			folders: dayList.length,
		},
		totals: usageFields(all),
		vendors,
		days,
		models,
	};
}

// Vendor first, then the biggest spend, so a client can group by vendor without
// sorting.
function compareModel(a, b) {
	const byVendor = a.vendor.localeCompare(b.vendor);
	if (byVendor !== 0) return byVendor;
	if (a.totalCredits !== b.totalCredits) return b.totalCredits - a.totalCredits;
	return a.model.localeCompare(b.model);
}

// Newest day first, the same order `ns-bridge usage` prints.
function compareDay(a, b) {
	const byDay = b.day.localeCompare(a.day);
	if (byDay !== 0) return byDay;
	const byVendor = a.vendor.localeCompare(b.vendor);
	if (byVendor !== 0) return byVendor;
	if (a.totalCredits !== b.totalCredits) return b.totalCredits - a.totalCredits;
	return a.model.localeCompare(b.model);
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
