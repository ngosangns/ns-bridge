# Design: account credit quota in the usage panel

Status: shipped. The build landed smaller than this sketch.
`packages/dsh-usage-panel/quota.js`, `index.js` and `client.js` are the code of
record; read them for the shape that exists today. Sections 1, 3 and 6 describe a
wider shape that was not built: one flat `quota` object per vendor row, not
`QuotaRow[]`, and the type stays a host-side typedef, not `ns-bridge-core`. Section
7 is answered: the gateway awaits an async `@Remote` method, so the panel is async.
Sections 2, 4 and 5 shipped as written.

## Goal

The usage panel must show the credit quota the provider actually reports, not only a
budget number the operator typed into `~/.ns-bridge/credit-budgets.json`. Kiro and
Devin expose account quota. Grok and Qoder do not.

## Existing facts this design builds on

| Fact | Evidence |
| --- | --- |
| Panel exposes one zero-arg remote method `usage/getUsageSummary` | `packages/dsh-usage-panel/index.js` |
| Payload has `vendors[]` rows of ledger credits plus `limit`, `limitSource`, `remainingCredits`, `overLimit` | `index.js` `buildSummary` |
| Precedence today is file > env, in one function | `index.js` `limitFor` |
| Client rejects a payload whose `schemaVersion !== CLIENT_SCHEMA` | `client.js` |
| `fetchKiroUsage` returns `{ summary, subscriptionTitle, usageBuckets[], resetAt, manageUrl }`, throws on bad credentials | `packages/kiro-core/src/usage.ts` |
| Kiro bucket unit is the vendor string `INVOCATIONS`, reset is an ISO string | live call, 2026-11-11 |
| `fetchDevinUsage` never throws, returns `null` with no token, and already returns normalized rows | `packages/devin-core/src/usage.ts` |
| Devin row ids look like `devin:credits:prompt`, `window: monthly|daily|weekly`, `unit: credits|percent|unknown`, `resetsAt` epoch ms | live call, 2026-11-11 |
| Panel declares no `dependencies`; workspace cores do not resolve from it today | probe from `packages/dsh-usage-panel` |

Measured latency (in-process, one call each, real credentials, machine loaded):
Kiro cold 935 ms, warm 281 ms. Devin cold 2302 ms, warm 526 ms. Both in parallel
with an expired token: 306 ms (auth fails fast). So one panel open costs at most
about 2.3 s cold and under 0.6 s warm.

## 1. The quota row

One shape, defined once in `ns-bridge-core/types.ts`, because two adapters consume it.
It is the shape `ns-devin-core` already publishes, widened with the two things Kiro
needs.

```
QuotaUnit    = 'credits' | 'percent' | 'count'
QuotaWindow  = 'monthly' | 'daily' | 'weekly' | 'none'
QuotaStatus  = 'ok' | 'no-credentials' | 'unauthorized' | 'unreachable' | 'error'

QuotaRow {
  id: string              // '<vendor>:<window>:<metric>', stable, never localised
  label: string           // vendor wording, one line
  window: QuotaWindow
  unit: QuotaUnit         // vendor oddity resolved here, never below
  used: number            // >= 0
  limit: number | null    // null = provider reports no cap
  remaining: number | null
  usedFraction: number | null   // 0..1, null when limit is null
  resetsAt: number | null       // epoch MS, UTC. ISO strings normalised in the core.
}

QuotaVendor {
  vendor: string          // ledger key: 'kiro' | 'devin'
  status: QuotaStatus
  detail: string | null   // one safe sentence, no token, no path
  fetchedAt: number       // epoch MS, 0 = never fetched
  stale: boolean          // served from grace cache
  plan: string | null     // 'KIRO PRO+', 'Free'
  manageUrl: string | null
  primaryRowId: string | null   // host ranks, client does not
  rows: QuotaRow[]              // always an array, empty when status !== 'ok'
}
```

Placement: `vendors[i].quota: QuotaVendor | null`. Merged at the vendor level, one
level of detail inside. Reasons:

- The client already loops `vendors[]` to draw the limit block, so it gains no loop.
- A vendor with no quota endpoint is `null`. Absence is structural, so no code path
  can draw a fake bar for Grok or Qoder.
- A quota vendor with no ledger rows still needs a row, so `buildSummary` adds every
  key from the quota map to the vendor set, next to the existing rule that adds every
  budgeted vendor.
- Ledger totals and provider quota stay separate fields on one row, so the panel can
  disclose that the two numbers differ.

Vendor quirks the host resolves, so the client holds zero knowledge:

| Quirk | Resolution |
| --- | --- |
| Kiro sends `unit: 'INVOCATIONS'` for a credit bucket | `kiro-core` maps it to `'credits'`; unknown units become `'count'` |
| Kiro sends `resetAt` as ISO, Devin as epoch ms | every core emits epoch MS or `null` |
| Kiro sends `usedDisplay`/`limitDisplay` strings | host emits numbers only; display strings stay in the core |
| Devin sends percent windows with no grant, plus daily/weekly rows that may not apply | `devinQuotaApplies` already filters, unchanged |
| One vendor reports N rows, the other 1 | `rows[]` plus `primaryRowId` chosen by the host |

Percent rows are drawn as percent bars. Credits rows are drawn as credit bars. The
client reads `unit` and `usedFraction`; it never converts.

## 2. Sync or async

Make `getUsageSummary()` **async** and await the quota fetch inside it. One RPC call
per panel open, per refresh.

Argument. Cold cost is `max(935, 2302) = 2.3 s`, warm `0.6 s`, because the vendor
fetches run in parallel. The client already shows `phase: 'loading'` during the single
call it makes today, so the user sees the existing spinner for two seconds on the
first open after app start, and a normal paint on every open after that, including a
re-open seconds later. The Refresh button keeps one honest meaning.

Rejected: return cache immediately and let the client poll until quota lands. That
costs a client state machine, a timer, backoff, and two or three RPC calls per open,
and it still shows stale numbers first. Rejected: warm the cache at plugin start only.
Then Refresh cannot mean "re-read the provider", and a fresh app start shows "pending"
for an unbounded time.

Guard: give the vendor calls a shared deadline of 4 s (an `AbortSignal`, which
`fetchDevinUsage` already accepts and `fetchKiroUsage` must gain). Past the deadline
the vendor reports `status: 'unreachable'` with the cached value and `stale: true`, and
the method returns at once. The user never stares at a spinner because a provider hangs.

Precondition to measure first, see section 7.

## 3. Host caching

Module-level `Map` inside the panel's new `quota.js`, in the host process.

- **Key**: `vendor` plus credential identity, cheap and secret-free: Kiro's `profile`
  name, Devin's `accountId` or email. The token value is never part of a key.
- **Entry**: `{ fetchedAt, expiresAt, value, pending }`.
- **TTL**: 60 s for `status: 'ok'`. 15 s for any failure, so one blip does not pin a
  red bar for a minute.
- **Grace**: a failed fetch after a success serves the last good value with
  `stale: true` for up to 10 minutes, and `fetchedAt` tells the client the real age.
- **In-flight dedupe**: store the promise in `pending`. Concurrent callers await it, so
  a second panel open or a double click costs zero extra requests.
- **Forced re-fetch**: TTL expiry, and the Refresh button, which passes `force: true`
  and is rate limited to one real fetch per 5 s.

Credentials are resolved fresh on every real fetch and are never cached. `kiro-cli`
rotates the access token out of process, so a cached copy is a token the service has
already replaced. The same rotation is why `dsh-llm-kiro` re-reads sessions on every
resolution. Caching results is safe because a result ages predictably and a stale one
is labelled. Caching credentials is unsafe because a stale credential is a hard error
the user cannot see.

Consequence for the cores: the quota path needs credentials that are valid, not merely
present. Only `dsh-llm-kiro` holds the `isExpired` then `refreshKiroToken` sequence.
Two adapters now need it, so per the layering rule it moves into `kiro-core` as
`resolveFreshKiroCredentials()`. `dsh-llm-kiro` then calls that instead of its local
copy. Same for Devin: `resolveDevinSession()` per fetch.

## 4. Failure isolation

- One `Promise.allSettled` across vendors, plus a `try/catch` inside each vendor fetch.
  Kiro throws (`KiroManagementHttpError` on a dead token); Devin returns `null`.
  Neither can reject the aggregate.
- `buildSummary` keeps its outer `try/catch` for the ledger part only. A quota failure
  never produces `emptySummary()`, which today blanks the whole panel.
- Mapping to `status`: no stored session or empty token then `no-credentials`; a 401 or
  403 after one retry then `unauthorized`; timeout or network then `unreachable`;
  anything else then `error`. `detail` is one sanitised sentence, never a token or a
  header.
- A failed vendor renders: `quota.rows = []`, `primaryRowId = null`, so the client
  cannot draw an empty bar, and `limit`/`limitSource` fall back to the file, the env
  default, or `null`. The vendor row still shows its ledger bars.
- The panel never loses a healthy vendor because a sibling died: each vendor object is
  built independently and pushed after its own failure handling.
- Contract rule for tests: `vendors[].quota` is `null` or a complete `QuotaVendor`,
  `rows` is always an array, every number is finite, every absent value is `null`, and
  `usedFraction` is `null` unless `limit` is a positive number.

## 5. Budget file as an early-warning marker

The marker is resolved in one host function, which replaces `limitFor`:

```
resolveLimit(vendor, quota, budgetFile, envDefault)
  -> { limit, limitSource, used, remainingCredits, overLimit, marker }
```

`index.js` calls it once per vendor row and spreads the result. The client does no
precedence at all.

- `limitSource: 'provider'` when `quota.status === 'ok'` and the primary row has a
  positive `limit`. Then `limit = row.limit`, `used = row.used`,
  `remainingCredits = limit - used`, `overLimit = used > limit`. Provider numbers
  drive the headline, because a provider-reported balance is what stops requests.
- Otherwise `limitSource` keeps its current meaning: `'file'`, `'env'`, `'none'`, and
  `used` stays the ledger spend. This is the degraded path, unchanged behaviour.
- `marker: { credits: number, ratio: number } | null`. `ratio = credits / limit`.
- The marker is meaningful only when `limitSource === 'provider'`, `marker.credits` is
  finite and positive, and `marker.credits < limit`. Draw a tick on the provider bar at
  `ratio`, so the tick sits where the file budget said trouble starts.
- The marker is meaningless and must be `null` when the budget is at or above the
  provider cap (the bar turns red at 100 percent before the tick can warn), when the
  provider reports no cap, when the vendor has no provider quota (the budget is then
  the limit itself, not a marker), and when the budget fails the current finite and
  positive check.
- Env `NS_BRIDGE_CREDIT_LIMIT` is a default limit only. It never becomes a marker,
  because a single global number against several vendors is not a per-vendor warning.

## 6. Where the code goes

| File | Change |
| --- | --- |
| `packages/bridge-core/src/types.ts` | `QuotaRow`, `QuotaVendor`, `QuotaUnit`, `QuotaWindow`, `QuotaStatus`. Types only, so one neutral vocabulary |
| `packages/kiro-core/src/usage.ts` | add `rows: QuotaRow[]` to `KiroProviderUsage` (normalise buckets: unit map, epoch MS, `usedFraction`); add an `AbortSignal` option; add `resolveFreshKiroCredentials()` holding the expire-then-refresh sequence |
| `packages/devin-core/src/usage.ts` | no shape change; export a small `toQuotaRows()` if the row type moves |
| `packages/dsh-llm-kiro/src/index.ts` | call `resolveFreshKiroCredentials()`, delete the duplicated sequence |
| `packages/dsh-usage-panel/quota.js` | new, host-only. Exports `getVendorQuotas({ force, deadlineMs, sources })`, `resolveLimit(...)`, `clearQuotaCache()`. `sources` is the injection seam for tests |
| `packages/dsh-usage-panel/index.js` | `getUsageSummary()` becomes async; attach `quota`; vendor set gains quota keys; `limitFor` becomes `resolveLimit` |
| `packages/dsh-usage-panel/package.json` | add `dependencies`: `ns-kiro-core`, `ns-devin-core`, `ns-bridge-core`, all `workspace:*`, then `pnpm install`. Without the links the panel cannot import a core today. `--preserve-symlinks-main` affects the entry only, so `index.js` resolves from its real path, which is how `dsh-llm-kiro` already works |
| `packages/dsh-usage-panel/client.js` | `LimitRow` draws `quota.rows` with `MeterBar` when present, the marker tick as a new optional `markerRatio` prop, `status !== 'ok'` as one text line, `primaryRowId` as the headline bar |
| `packages/dsh-usage-panel/locale/en.json`, `vi.json`, plus the inline `zh` table in `client.js` | `limit.provider`, `quota.window.*`, `quota.status.*`, `quota.reset`, `quota.stale`, `quota.checking`, `quota.marker`, `quota.localLedger` |
| `packages/dsh-usage-panel/test-plugin.mjs` | resolution guard for the three cores; new quota section on injected fakes (precedence, marker rules, JSON safety, per-vendor isolation); refresh of sections 6, 8, 9; `schemaVersion` assertion to 3 |
| `index.js` and `client.js` constants | `SCHEMA_VERSION` and `CLIENT_SCHEMA` 2 to 3, together, or the client rejects every payload with `reason: 'schema'` |

## 7. Riskiest assumption

The gateway awaits a promise returned by a plain remote method.

Nothing in this repo has an async remote method, the hand-rolled `markRemoteMethod`
path in the panel copies the marker the decorator writes, and the protocol package
offers a stream mode with no documented async-method mode. If the gateway serialises
the promise itself, the client sees an object without `schemaVersion` and the whole
panel reports "Failed to load usage". That single line would decide the product, and
it would be the worst possible place to learn it.

Falsifying measurement, before any of the above is built: add one temporary remote
method that returns `Promise.resolve({ probe: 1 })` after a 1500 ms `setTimeout`,
install it in the live profile, and call it through the same
`connection.rpc.call('/api', ...)` path the panel uses, from the browser console.
Record whether the call resolves to the value, to a wrapped rejected promise, or
throws. If it does not await, the design changes shape: the quota fetch moves behind a
second remote method that is awaited by a `refresh` the client triggers only when
`quota.pending === true`, and section 2 swaps to the polling variant with all its cost.
Everything else in this document survives either answer.
