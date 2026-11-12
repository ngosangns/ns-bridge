// Account quota read straight from the provider, not from the local ledger.
// Two vendors expose an account quota endpoint: Kiro and Devin. Every other
// vendor keeps the declared budget alone, because a bar with no real number
// behind it is a made-up number.
// The two vendor cores are dynamic imports. A missing package then costs one
// quota field, never the whole panel.

/**
 * @typedef {object} ProviderQuota
 * @property {'provider'} source Which claim this limit carries.
 * @property {string} unit One of the shared usage unit names.
 * @property {number} used What the account has consumed in the window.
 * @property {number|null} limit The window allowance, null when unknown.
 * @property {number|null} remaining limit minus used, null when no limit.
 * @property {number|null} resetAtMs Window close as local epoch milliseconds.
 * @property {string|null} label Bucket name from the provider, if it sent one.
 * @property {string|null} account Plan or subscription title, if it sent one.
 * @property {number|null} warning Early-warning limit from the budget file.
 */

// One round trip gets the worst cold start measured: Devin over a slow link.
// A longer wait only delays the panel with no better chance of an answer.
const PROVIDER_DEADLINE_MS = 4_000;
// Quota is account state. It changes over hours, so one minute is fresh enough
// for a panel that reloads on every open and on every Refresh click.
const QUOTA_TTL_MS = 60_000;
// A failure is retried sooner, so a network that comes back shows real numbers.
const QUOTA_FAILURE_TTL_MS = 15_000;
const PROVIDER_VENDORS = new Set(['kiro', 'devin']);
const CREDIT_UNITS = new Set(['credit', 'credits']);
// Set NS_BRIDGE_USAGE_PROVIDER_QUOTA to 0, false or off to keep the panel off
// the network. Development machines and the offline test run use this switch.
const PROVIDER_QUOTA_ENV = 'NS_BRIDGE_USAGE_PROVIDER_QUOTA';

const cache = new Map();
const inFlight = new Map();

function num(value, fallback = 0) {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Object.is(parsed, -0) ? 0 : parsed; // RPC rejects -0 and non-finite numbers.
}

function round(value) {
	return num(Math.round(num(value) * 1e6) / 1e6);
}

function text(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

function positiveLimit(value) {
	const parsed = num(value, Number.NaN);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return round(parsed);
}

function envFlag() {
	const value = process.env[PROVIDER_QUOTA_ENV];
	if (typeof value !== 'string') return true;
	const flag = value.trim().toLowerCase();
	return flag !== '0' && flag !== 'false' && flag !== 'off';
}

function keyOf(vendor) {
	return String(vendor ?? '').trim().toLowerCase();
}

/**
 * True when a provider can answer for this vendor. The client uses it for a
 * tooltip, never to guess a number.
 */
export function isProviderVendor(vendor) {
	return envFlag() && PROVIDER_VENDORS.has(keyOf(vendor));
}

/**
 * Last quota read for one vendor, or null when nothing is cached yet.
 */
export function peekQuota(vendor) {
	const hit = cache.get(keyOf(vendor));
	if (!hit || hit.expires <= Date.now()) return null;
	return hit.quota;
}

/**
 * Quota for one vendor, read from the provider when the cache is stale.
 * Returns null for a vendor no provider covers, and for any failure.
 */
export async function refreshQuota(vendor, options = {}) {
	const name = keyOf(vendor);
	if (!isProviderVendor(name)) return null;
	const now = Date.now();
	const hit = cache.get(name);
	if (hit && hit.expires > now) return hit.quota;
	if (options.force !== true) {
		const running = inFlight.get(name);
		if (running) return running;
	}
	const task = read(name, options).then((quota) => {
		inFlight.delete(name);
		cache.set(name, {
			quota,
			expires: Date.now() + (quota ? QUOTA_TTL_MS : QUOTA_FAILURE_TTL_MS),
		});
		return quota;
	});
	inFlight.set(name, task);
	return task;
}

async function read(name, options) {
	// A provider outage is a missing bar, not a broken panel. Every path below
	// lands in the catch, so no caller needs its own error handling.
	try {
		const deadline = num(options.timeoutMs, PROVIDER_DEADLINE_MS);
		return name === 'kiro' ? await readKiro(deadline) : await readDevin(deadline);
	} catch {
		return null;
	}
}

function withDeadline(promise, ms) {
	let timer = null;
	const guard = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new Error('quota provider timeout')), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function readKiro(deadline) {
	const kiro = await import('ns-kiro-core');
	const hostKey = text(process.env.KIRO_API_KEY) ?? undefined;
	const resolved = await kiro.resolveKiroRequestCredentials(hostKey);
	const access = text(resolved?.accessToken);
	if (!access) return null;
	// KiroCredentials is the core input shape. The host resolver returns a
	// narrower object, so the fields the core does not read stay empty.
	const credentials = {
		access,
		refresh: '',
		expires: 0,
		clientId: '',
		clientSecret: '',
		region: 'us-east-1',
		authMethod: access.startsWith('ksk_') ? 'apikey' : 'idc',
	};
	const profileArn = text(resolved?.profileArn);
	if (profileArn) credentials.profileArn = profileArn;
	// The core cannot abort, so a request that loses the race still settles
	// later. The sink keeps that late result out of the host process.
	const request = kiro.fetchKiroUsage(credentials);
	request.catch(() => {});
	return normalizeKiro(await withDeadline(request, deadline));
}

async function readDevin(deadline) {
	const devin = await import('ns-devin-core');
	const apiKey = text(devin.resolveDevinCredentials?.()?.apiKey);
	if (!apiKey) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deadline);
	try {
		// The core swallows its own failures and returns null.
		return normalizeDevin(await devin.fetchDevinUsage({ apiKey, signal: controller.signal }));
	} finally {
		clearTimeout(timer);
	}
}

function finish(used, limit, resetAtMs, unit, label, account) {
	if (!Number.isFinite(used)) return null;
	if (limit === null && resetAtMs === null) return null;
	return {
		source: 'provider',
		unit,
		used: round(used),
		limit,
		remaining: limit === null ? null : round(limit - used),
		resetAtMs,
		label,
		account,
		// The caller owns the budget file, so it fills this tick. The cached
		// object stays read-only, because several rows may share it.
		warning: null,
	};
}

/**
 * Kiro reports one bucket per resource. Credits are the allowance people buy,
 * so a credit bucket wins over any other unit in the same response.
 */
export function normalizeKiro(usage) {
	const buckets = Array.isArray(usage?.usageBuckets) ? usage.usageBuckets : [];
	let credits = null;
	let other = null;
	for (const bucket of buckets) {
		if (!bucket || !Number.isFinite(num(bucket.used, Number.NaN))) continue;
		if (CREDIT_UNITS.has(String(bucket.unitKind ?? '').toLowerCase())) {
			credits = credits ?? bucket;
		} else if (!other) {
			other = bucket;
		}
	}
	const bucket = credits ?? other;
	if (!bucket) return null;
	const unit = credits ? 'credits' : text(bucket.unitKind) ?? 'unknown';
	const limit = positiveLimit(bucket.limit);
	const rawReset = Number.isFinite(bucket.resetAtMs) ? bucket.resetAtMs : usage.resetAtMs;
	const resetAtMs = positiveLimit(rawReset);
	return finish(num(bucket.used), limit, resetAtMs, unit,
		text(bucket.label) ?? text(usage.subscriptionTitle), text(usage.subscriptionTitle));
}

/**
 * Devin reports several windows. Credit windows add up to the plan allowance a
 * person reads as one number. Percent windows are already normalized, so the
 * fullest one is the honest bar.
 */
export function normalizeDevin(usage) {
	const limits = Array.isArray(usage?.limits) ? usage.limits : [];
	let used = 0;
	let limit = 0;
	let counted = 0;
	let resetAtMs = null;
	for (const row of limits) {
		if (!row || String(row.unit) !== 'credits') continue;
		const rowLimit = positiveLimit(row.limit);
		if (rowLimit === null) continue;
		used += num(row.used);
		limit += rowLimit;
		counted += 1;
		resetAtMs = earliest(resetAtMs, row.resetsAt);
	}
	if (counted > 0) {
		return finish(used, round(limit), resetAtMs, 'credits',
			text(usage?.planName) ?? 'Credits', text(usage?.planName));
	}
	let percent = null;
	let top = -1;
	for (const row of limits) {
		if (!row || String(row.unit) !== 'percent') continue;
		const share = num(row.used) / (positiveLimit(row.limit) ?? 100);
		if (share > top) {
			percent = row;
			top = share;
		}
	}
	if (!percent) return null;
	const cap = positiveLimit(percent.limit) ?? 100;
	return finish(num(percent.used), cap, earliest(null, percent.resetsAt), 'percent',
		text(percent.label) ?? text(usage?.planName), text(usage?.planName));
}

function earliest(current, candidate) {
	const value = positiveLimit(candidate);
	if (value === null) return current;
	if (current === null || value < current) return value;
	return current;
}

/** Test seam only: drop every cached quota and every running request. */
export function clearQuotaCache() {
	cache.clear();
	inFlight.clear();
}
