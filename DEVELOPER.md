# Developing ns-bridge

Contributor guide for building, testing, and extending this repo. For what the
project is and how to install/use it, see [README.md](README.md).

## Layout

pnpm workspace. Sixteen packages under `packages/`. Only `@ngosangns/ns-bridge` is publishable; every other package is `private` and exists as a build input to it, because the CLI bundles each host extension that gets installed.

This repository was assembled from `ns-kiro-provider` (renamed to this one), `ns-pi-provider`, `ns-omp-provider`, and `ns-devin-provider` (archived, each pointing here).

| Layer | Package | Owns |
| --- | --- | --- |
| shared | [`ns-core-utils`](packages/core-utils) | Plumbing every vendor core needs and none owns: retry-header parsing, exponential backoff, abort-aware delay, and the atomic JSON cache read/write. Dependency-free and host-free, so a core can depend on it without gaining a host coupling |
| shared | [`ns-bridge-core`](packages/bridge-core) | The neutral vocabulary (`Bridge*` messages, tools, stream events, usage, effort) and one bridge per host family: `./pi` (Pi and OMP) and `./dsh` (DeepSeek Harness, including the `createDshLlmAdapter` factory every Harness adapter is built from) |
| vendor core | [`ns-kiro-core`](packages/kiro-core) | The Kiro protocol in this process: AWS event-stream, request building, response assembly, the retry ladder, tokenizer, login, local credential stores (kiro-cli, Kiro IDE) and their selection, the model-catalog cache, profile caches, error vocabulary, and host login/model helpers (`host-auth.ts`, `host-model.ts`) |
| vendor core | [`ns-devin-core`](packages/devin-core) | The Devin protocol in this process: Cascade over Connect/protobuf, PKCE login, credentials files, the model catalog cache, usage, error vocabulary, and request/result conversion |
| vendor core | [`ns-grok-core`](packages/grok-core) | The Grok Responses API in this process: request building, SSE parsing, stream assembly, usage, the CLI login session and its refresh, error vocabulary, the model catalog contract, and — under `./cli` — locating the Grok CLI and reading its model list |
| vendor core | [`ns-arnict-core`](packages/arnict-core) | The Arnict protocol in this process: OpenAI chat completions over SSE, API key auth (env or key file), the model catalog with published rates, and USD cost in the usage ledger as credits with `creditUnit` "USD" |
| vendor core | [`ns-qoder-core`](packages/qoder-core) | Qoder's model-server wire (OpenAI-style SSE) in this process: request building with the `business` metadata gate, tolerant SSE framing, stream reduction, usage, the qodercli credential store decrypted with a vendored wasm, and the bootstrap model catalog |
| host adapter | [`@ngosangns/ns-pi-provider`](packages/pi-provider) | Pi: `kiro`, `devin`, `grok`, `arnict`, and `qoder` over the cores via `ns-bridge-core/pi`. Grok streams through the Responses API; the CLI is only consulted for its model list |
| host adapter | [`ns-omp-provider`](packages/omp-provider) | OMP: bundles the Pi adapter's Kiro, Arnict, and Qoder registrations behind an OMP-compat layer; no `devin` or `grok` (OMP has native `devin`, `xai`, `xai-oauth`) |
| host adapter | [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro), [`ns-dsh-llm-devin`](packages/dsh-llm-devin), [`ns-dsh-llm-grok`](packages/dsh-llm-grok), [`ns-dsh-llm-arnict`](packages/dsh-llm-arnict), [`ns-dsh-llm-qoder`](packages/dsh-llm-qoder) | Harness `LlmAdapter`s over the cores via `ns-bridge-core/dsh`. Each is a vendor spec plus its error vocabulary; the adapter skeleton is `createDshLlmAdapter` |
| cli | [`@ngosangns/ns-bridge`](packages/cli) | `ns-bridge`: the only package this repo publishes. Builds the host extensions into `dist/hosts/**`, registers them with Pi, OMP, and DSH, and refreshes model catalogs outside the host process |

Pi, OMP, and DSH read the catalog files while they run. They do not refresh those files. `ns-bridge models refresh` writes them.

### Host extension bundles

`packages/cli/scripts/build.mjs` builds everything the CLI ships: the refresh
and serve entries, then one prebuilt extension per host under `dist/hosts/`:

| Path | Manifest name | Built from |
| --- | --- | --- |
| `dist/hosts/pi` | `@ngosangns/ns-pi-provider` | `pi-provider/index.ts`, with `@earendil-works/*` external (Pi serves them in-process) |
| `dist/hosts/omp` | `ns-omp-provider` | `omp-provider/src/index.ts`, `@oh-my-pi/*` external, `@earendil-works/*` aliased to `omp-provider/src/compat` by `scripts/pi-compat-plugin.mjs` |
| `dist/hosts/dsh/<vendor>` | `ns-dsh-llm-<vendor>` | each `dsh-llm-<vendor>`; `@deepseek-ai/{cordis,dsh-attachment,dsh-credentials,dsh-llm}` external and `schemastery` bundled |

The generated `package.json` beside each bundle carries the host's discovery
key (`pi.extensions` / `omp.extensions`), the peer ranges DSH needs, and no
dependencies. `@smithy/*` and `js-tiktoken`
stay external everywhere: the Smithy/tiktoken stack loads lazily on Kiro
requests. They are runtime dependencies of the CLI package, so they resolve
from beside the bundle. qoder-core's auth wasm is not bundled — the build
copies `vendor/qoder-auth.wasm` next to every bundle, where `store.ts`
resolves it (`../vendor/`).

Build guards fail the build rather than the host: an external outside the
allow-list, a Pi module left in the OMP bundle, or a DSH bundle without its
`llm-<vendor>` export. `packages/cli/test/bundles.test.ts` loads every bundle
from a temp `node_modules` with Proxy stubs for the host modules, registers
Qoder on Pi, checks OMP's effort and window mapping, and calls each DSH
`apply`.

`ns-bridge install` registers those directories in place
(`packages/cli/src/hosts.ts`): Pi gets `pi install <abs dist/hosts/pi>`, OMP
`omp plugin install <abs dir>`, DSH `link:` plugins plus the five
`cordis.patch.yml` blocks (`packages/cli/src/dsh-patch.ts`). Install and
update also migrate off the old npm plugins; `uninstall` removes both shapes.
Hosts point into the installed CLI, so moving or removing it breaks the
extensions until `install` runs again. `packages/cli/test/install.test.ts`
drives the built CLI against fake host binaries on an isolated `HOME`.

### What each refresh takes from the vendor

A catalog row carries only what the vendor reports. A field the vendor does not report keeps a shared
default, and no table in this repo names a model's capabilities.

| Vendor | Source | Fields taken from it |
|---|---|---|
| Kiro | `ListAvailableModels` | id, name, `tokenLimits`, effort schema, `supportedInputTypes` (image input), `rateMultiplier` and `rateUnit`. `kiro-cli chat --list-models` is the fallback for a rate the entry omits. |
| Qoder | SDK `getAvailableModels()` | id, `displayName`, `isReasoning`, `isVl` (image input), `defaultContextWindow` (capped by `maxInputTokens`), `maxOutputTokens`, `efforts` |
| Grok | `grok models` and `~/.grok/models_cache.json` | id, `name`, `context_window`, `max_completion_tokens`, `supports_reasoning_effort` |
| Devin | `GetCliModelConfigs` | id, label, window, rates, effort and fast-mode families, thinking support |
| Arnict | `GET /v1/models` | ids only. Everything else is `ARNICT_KNOWN_MODELS`, copied from arnict.com/docs/pricing. |

The bootstrap lists (`bootstrapKiroModels`, `BOOTSTRAP_IDS` in Qoder, `GROK_BOOTSTRAP_MODEL_IDS`) are cold-start
seeds for a host that never refreshed. They are not read once a refresh has written a catalog.

Not synced because the vendor publishes no machine-readable source: Kiro's cache-pricing constants
(`KIRO_CREDIT_RATES`, measured; see `scripts/kiro-pricing.mjs`), the Claude compaction target, long-context
thresholds, request user-agent strings, and Arnict's rates and windows.

### Where a change goes

- **Wire protocol** (request shape, streaming, retries, credentials, catalog) →
  the vendor core. Never in an adapter: three hosts would each need the fix.
- **Host translation** (a host's message or event shape) → `ns-bridge-core`,
  once per host family. Typed structurally (`PiContextLike`, …) so one bridge
  serves both Pi and OMP without importing either.
- **Host adapters** register with the host and wire a core to a bridge. If two
  adapters grow the same logic, move it down a layer. The Harness adapters take
  this literally: they are `createDshLlmAdapter` specs, not classes.
- Dependencies point down only: adapters → cores + bridge, cores → `ns-core-utils`.
  The cores emit the bridge vocabulary *structurally* and do not import
  `ns-bridge-core`; `ns-bridge-core` imports no core at runtime (only its tests
  do). `toBridgeEffort` lives at the package root because both host bridges use it.

### In-process engines

Kiro, Devin, and Grok all run in the Node process that loaded the host adapter.
`streamKiro`, `streamDevin`, and `streamGrok` yield `BridgeStreamEvent`s.
`streamToPi` and `streamToDsh` in `ns-bridge-core` turn those events into the
host's stream.

| Path | Owns |
| --- | --- |
| `packages/kiro-core/src` | Kiro: `generateAssistantResponse` over AWS event-stream, the retry ladder, catalog, usage, token refresh, API-key login |
| `packages/devin-core/src` | Devin: Cascade over Connect/protobuf, model discovery, usage, PKCE login |
| `packages/grok-core/src` | Grok: the Responses API over SSE, usage, the CLI login session and its refresh |
| `packages/grok-core/src/cli` | Grok: locating the CLI binary and reading `grok models` |
| `packages/core-utils/src` | Retry headers, backoff, abort-aware delay, atomic JSON cache |
| `packages/bridge-core/src/types.ts` | The vocabulary every engine emits and every host bridge consumes |
| `packages/bridge-core/src/pi`, `packages/bridge-core/src/dsh` | Host translation; `dsh/adapter.ts` is the shared Harness adapter factory |

Grok has one streaming path, the Responses API, and it never spawns the CLI.
`packages/pi-provider/src/grok` only turns the CLI's model list into Pi's
provider models and registers the provider. The `host`, `acp`, and `jsonl`
modes, which each spawned a `grok` process per turn, are gone.

`KIRO_RUNTIME_ENDPOINT` / `KIRO_MANAGEMENT_ENDPOINT` (`{region}` substituted)
redirect Kiro, for example to a test server. `refreshDevinToken` is a
no-request shortcut: Devin issues no refresh token.

### The usage ledger

Every `streamKiro`, `streamDevin`, `streamGrok`, and `streamArnict` call is wrapped by `recordUsage` in
`packages/core-utils/src/usage-ledger.ts`. When the stream ends it appends one line to
`~/.ns-bridge/usage/<day>/<vendor>/<session>.jsonl`. It sits in the core, so Pi, OMP, and
DSH all get it and an adapter does nothing but name its host (`setUsageHost`; the first
caller wins, so `ns-omp-provider` keeps `omp` even though it bundles the Pi adapter).

- The record is numbers and labels only: no prompt, no tool content, no credentials.
- A session id comes from the host, so it never picks a path. Plain ids (`[A-Za-z0-9_-]`,
  up to 80) are the file name; anything else becomes `h-<hash>`. The full id stays in the line.
- The ledger records provider numbers and never a host plugin's guess. `cacheHitRatio` and
  `cacheWriteRatio` are `null` when there is nothing to report, never 0. `cacheSource` is `wire`
  (provider counters), `credits` (derived), or `none`.
- Kiro sends no cache counters (checked against its raw frames). `dsh-llm-kiro` turns on
  `estimateCacheUsage` to feed the Harness; `providerUsage` moves those guessed tokens back to
  `input` before writing. The core then derives the ratio from billed credits instead
  (`kiro-core/src/cache-from-credits.ts`, passed in as `UsageContext.deriveCache`). Kiro bills
  `min(cold * P, cached * (P - n) + fresh * n)` per 1k prompt tokens, per `rateMultiplier`, where n is
  the part of the prompt that was not cached and `fresh` is about ten times `cached`. Under the
  cold ceiling the bill gives n exactly (`cacheSource: credits`). On the ceiling it gives only an
  upper bound (`credits-capped`, `cacheHitMax`): appending ~10% to a cached prefix already bills as a
  cold prompt (~30% for sonnet, whose cold cap is twice haiku/opus). The constants are measurements,
  not a published price list. If Kiro reprices, re-measure (one fixed prefix, three identical
  turns, then append known token counts) and edit `KIRO_CREDIT_RATES` and the fixtures in
  `cache-from-credits.test.ts`. `gpt-5-6-luna` has no cold cap (a cold prompt bills at `fresh`) and
  doubles every rate from about 275k prompt tokens; it was fitted from ledger turns and sits in
  `KIRO_UNCAPPED_MODELS`, with 270k-275k refused because the two tiers mix there. `auto` was fitted the same
  way (cold cap 0.00316 like haiku/opus, no long-context tier up to 565k). Any other model was
  not measured and is refused (`cacheSource: none`); the comment above `KIRO_CREDIT_RATES` says how to
  fit one from the ledger. A long answer is refused because the output-token term is itself an estimate.
  `node scripts/kiro-pricing.mjs [--days N] [--min-turns N]` checks the constants against the live
  `kiro-cli chat --list-models` multipliers and the ledger. It replays each turn through
  `deriveKiroCacheFromCredits`, exits 1 when a modeled model's bills no longer fit (Kiro repriced), and
  lists unmeasured models that have enough turns to fit. It edits nothing: a constant is a measurement,
  so a person updates `KIRO_CREDIT_RATES` and the fixtures.
- The same derivation reaches the host. `streamKiro` runs `applyCreditDerivedCache` on the usage event
  after the opt-in estimator: an exact result moves the cached share from `input` to `cacheRead`,
  replaces the estimator's guess, and sets `cacheDerived: "credits"`. Wire counters are never touched,
  and a capped bill stays unreported. `providerUsage` strips the figure back out before the ledger
  re-derives it, so the ledger still labels it `credits`, not `wire`.
- When Arnict reports `prompt_tokens_details.cached_tokens` (not yet seen on a live response), the
  ledger line reads `cacheSource: wire`; otherwise `none`.
- A failed write is swallowed and counted (`usageWriteFailures`). The ledger must not fail a response.
- Day folders older than 30 days, and the oldest ones beyond 50 MB, are deleted whole. The newest stays.
- `NS_BRIDGE_USAGE=0` turns it off. The root vitest config sets it, so tests never write to the home directory;
  the ledger's own tests turn it back on against a temp dir.
- `ns-bridge usage` (`packages/cli/src/usage.ts`) only reads. It shares no code with the writer, so the
  line shape is the contract between them.

### The Kiro profile pin

`ns-bridge kiro profile use` writes `~/.ns-bridge/kiro-profile.json`. kiro-core reads it on every
profile resolution. Precedence is `KIRO_PROFILE_ARN`, then the pin, then kiro-cli's pick, then
discovery. The Kiro catalog cache (`~/.ns-kiro-provider-models-cache.json`) keeps a per-profile
`profiles` map keyed by a hash of the ARN.

### The `kiro` provider id in OMP

The bundled `ns-omp-provider` owns `kiro` in OMP. `ns-bridge install omp` and
`update omp` remove the old plugins (`ns-omp-provider-kiro`, the npm
`ns-omp-provider`) before registering the bundle, so only one plugin ever
provides the id. Which providers the bundle registers is decided by
`~/.ns-bridge/providers.json` and the env lists (`omp-provider/src/config.ts`).
`ns-bridge providers` writes only the key it changes, never the defaults.

### Compaction thresholds for Kiro models

Hosts compact inside the window a catalog row registers, so the catalog sizes
that window to keep compaction where the model should trigger:

| Models | Registered window | OMP compacts at |
| --- | --- | --- |
| GPT-5.6 luna / sol / terra | 272K standard-price window — OpenAI bills prompts over 272K at its long-context rate, and Codex ships the three with a 272K `context_window` | 231,200 |
| Claude models with a 1M window | 176,470 standard window, sized so OMP's default threshold lands on the 150,000 compaction target; Kiro's 1M stays as the extended tier | 150,000 |
| Claude 200K models, and the rest (`auto`, deepseek, glm, minimax, qwen) | Kiro's own window | OMP default on that window |

The Claude target is 150,000 rather than the window because Anthropic bills
Claude 4.6+ flat across 1M (no price cliff to stop before), but Kiro credits
grow linearly with prompt size even when cached: fitted from the usage ledger,
a warm turn costs ~0.5 credits at 150K against ~2.3–2.55 extrapolated at 850K,
so a session compacting at 150K costs ~2.6–2.9x less, and Anthropic's own
server-side compaction defaults to the same trigger. The numbers and their
sources sit on `KIRO_CLAUDE_COMPACTION_TARGET` in
`packages/kiro-core/src/long-context.ts`.

To run a Claude model on the full 1M window, opt in from OMP with
`extendedContext` or a `compaction.modelThresholds` entry past the standard
window. Shrinking the registered window never shrinks request time:
`packages/kiro-core/src/host-model.ts` keeps Kiro's real window, so ledger and
credit math stay right.

### Compaction thresholds for Arnict models

Every `zai/glm-5.3*` id registers the 400,000-token standard window
(`ARNICT_GLM_STANDARD_CONTEXT_WINDOW` in `packages/arnict-core/src/catalog.ts`),
so Pi, DSH, and ZCode compact at 383,616 = 400,000 − 16,384. OMP derives its
threshold from the window itself (`max(floor(0.15·W), 16384)`), so
`ns-omp-provider` re-registers the rows at 451,312 — the smallest window whose
15% rule lands on 383,616 (`ompWindowForThreshold` in
`packages/omp-provider/src/adapter.ts`). The native 1,048,576 window Arnict
serves stays on `maxContextWindow`/`nativeContextWindow` for requests and the
ledger.

The standard window is not a price cliff — Arnict bills flat with cached input
still charged — it is Z.ai's own agentic evaluation context for GLM-5.3
(400K; ZCode's 966,000 compaction is window-driven, not cost-driven). Cached
input still makes cost grow with context: at Arnict rates a flash turn's
cached context is $0.0192 at 383,616 tokens against $0.0516 at 1,032,192,
about 2.7x per session. The facts and their sources sit on the doc comment of
`ARNICT_GLM_STANDARD_CONTEXT_WINDOW`.

### Inside ns-kiro-core

The wire protocol and the per-process state both live in this package.

| Module | Owns |
| --- | --- |
| [`request-builder.ts`](packages/kiro-core/src/request-builder.ts), [`response-stream.ts`](packages/kiro-core/src/response-stream.ts), [`response-assembler.ts`](packages/kiro-core/src/response-assembler.ts), [`event-parser.ts`](packages/kiro-core/src/event-parser.ts), [`retry.ts`](packages/kiro-core/src/retry.ts), [`transport.ts`](packages/kiro-core/src/transport.ts) | Request building, AWS event-stream framing, response assembly, the retry ladder |
| [`tokenizer.ts`](packages/kiro-core/src/tokenizer.ts), [`thinking-parser.ts`](packages/kiro-core/src/thinking-parser.ts), and the tool parsers | Token counts (`js-tiktoken` `cl100k_base`), thinking tags, tool-call recovery |
| [`kiro-cli.ts`](packages/kiro-core/src/kiro-cli.ts), [`kiro-ide.ts`](packages/kiro-core/src/kiro-ide.ts) | The local credential stores — kiro-cli's SQLite DB and the Kiro IDE's credentials file — and which one a machine resolves (`KIRO_AUTH_SOURCE`) |
| [`oauth.ts`](packages/kiro-core/src/oauth.ts) | Credential resolution, token refresh, and API-key login (`loginKiroWithApiKey` calls GetProfile) |
| [`http.ts`](packages/kiro-core/src/http.ts) | The one HTTP seam, and the User-Agent each endpoint family expects |
| [`credential-rotation.ts`](packages/kiro-core/src/credential-rotation.ts) | What a rejected credential is replaced with: re-read the kiro-cli store, refresh only if it still holds the rejected token |
| [`management.ts`](packages/kiro-core/src/management.ts) | Profile-ARN and profile-region caches for this process |
| [`models.ts`](packages/kiro-core/src/models.ts), [`effort.ts`](packages/kiro-core/src/effort.ts) | The bootstrap catalog, the on-disk management cache, effort ladders |
| [`stream.ts`](packages/kiro-core/src/stream.ts) | `streamKiro`: resolve the model and profile, stream one turn, apply the cache-read estimate |
| [`cache-estimator.ts`](packages/kiro-core/src/cache-estimator.ts), [`usage.ts`](packages/kiro-core/src/usage.ts) | Cross-turn cache-read estimation and `fetchKiroUsage` |

## ZCode

`ns-bridge serve` and `ns-bridge zcode setup|status|remove` point the ZCode app
at kiro, devin, and grok without a host adapter.

| Piece | Owns |
| --- | --- |
| [`packages/bridge-core/src/anthropic/`](packages/bridge-core/src/anthropic) | The translation the local server needs: `request.ts` reads the Anthropic Messages body into a bridge request (`toBridgeRequest`), `stream.ts` writes the reply as SSE or one message (`toAnthropicSse`, `collectAnthropicMessage`), `server.ts` is the HTTP server — one mount per vendor as the first path segment, `x-api-key`/Bearer token on every route but `/healthz` |
| [`packages/cli/src/serve.ts`](packages/cli/src/serve.ts) | The `serve` command: loads the vendored backends from the esbuild bundle (`dist/serve-entry.js`, built by `scripts/build.mjs`), reads port and token from `~/.ns-bridge/zcode.json`, binds loopback unless `--allow-remote`, and names the usage host — `setUsageHost("zcode")`, so records from the server carry `host=zcode` |
| [`packages/cli/src/zcode.ts`](packages/cli/src/zcode.ts) | The `zcode` commands: plan the providers from the catalogs, merge them into ZCode's personal provider config, install/remove the darwin launch agent |

The merge (`applyZcodeProviders`) is idempotent and slot-preserving:
`ns-bridge-*` provider and model rules are replaced where they stand, stale
`ns-bridge-*` rules are dropped (manual model rules are pruned only), new ones
are appended, vendors whose catalog was skipped keep their entries
(`keepProviderIds`), and foreign rules, `providerOrder` slots, and unknown keys
pass through untouched. `defaultModelSelection` changes only when `--default`
names one. It throws rather than editing a file whose shape it does not
recognize.

Model rules carry what ZCode needs to compact on ns-bridge's policy. Every rule
publishes `reasoningLevel` values `low`, `medium`, `high`, `xhigh`, `max`
(ZCode ignores a `defaultModelSelection` whose level is missing from the
selected model's values), and the reported window is
`threshold + 13000 + min(maxOutputTokens, 21000)` capped at the real window:
ZCode compacts at `window - 13000 - min(maxOutputTokens, 21000)`, which lands
the compaction on the threshold the catalog recorded, or on
`derivedThresholdTokens` where the catalog recorded none.

### Live-testing ZCode safely

Point setup at temp files so nothing real is touched, skip the launch agent,
and let `--force` skip the running-ZCode check:

```bash
pnpm --filter @ngosangns/ns-bridge build   # dist/serve-entry.js must exist
tmp=$(mktemp -d)
export NS_BRIDGE_ZCODE_CONFIG=$tmp/zcode.json
export ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=$tmp/provider_config.json
node packages/cli/dist/main.js zcode setup --no-service --force
node packages/cli/dist/main.js serve       # reads the same temp config
```

`curl http://127.0.0.1:47821/healthz` should answer `ok`; a `/kiro/v1/messages`
call presents the token from the temp serve config as `x-api-key`. ZCode can
then be pointed at the temp provider config the same way. The serve config
(with its token) and the provider config both live under the temp dir, so the
real `~/.ns-bridge/zcode.json` and `~/.zcode` are untouched.

## Prerequisites

- Node >=22 (`engines.node` in `package.json`)
- pnpm (`packageManager` in `package.json`)

## Setup, build, check, test

```bash
git clone git@github.com:ngosangns/ns-bridge.git
cd ns-bridge
pnpm install
pnpm -r build       # also writes packages/cli/dist/hosts/**; check typechecks against built declarations, so build first
pnpm -r check
pnpm test           # vitest projects: bridge, core-utils, kiro, devin, grok, grok-dsh, arnict, arnict-dsh, qoder, cli, pi, omp
pnpm vitest run --project kiro   # one project
pnpm lint           # biome check .  (lint:fix / format to write)
```

The `cli` project includes the bundle smoke test and the isolated-`HOME`
install run; both build `packages/cli/dist` on demand when it is missing.

Pi and OMP adapters keep their own formatting and are excluded from Biome.

### Live checks

Hermetic tests never touch the network. With real sessions on the machine:

```bash
pi --no-extensions -e ./packages/pi-provider/index.ts --list-models
pi --no-extensions -e ./packages/pi-provider/index.ts --model kiro/claude-haiku-4-5 -p "hi"
pi --no-extensions -e ./packages/cli/dist/hosts/pi --model kiro/claude-haiku-4-5 -p "hi"   # what install registers
omp --no-extensions -e ./packages/cli/dist/hosts/omp --model kiro/claude-haiku-4-5 -p "hi"
NS_PI_LIVE=1 pnpm --filter @ngosangns/ns-pi-provider test:live
NS_QODER_LIVE=1 pnpm vitest run --project qoder packages/qoder-core/test/live/smoke.test.ts
```

`ns-qoder-core` calls the Qoder model server directly over its OpenAI-style
SSE wire (`POST /model/v1/chat/completions` on `api2-v2.qoder.sh`) — no SDK,
no daemon, no worker runtime. The bearer token comes from
`QODER_PERSONAL_ACCESS_TOKEN` or the qodercli credential store
(`~/.qoder/.auth/user`), which is AES-256-GCM under the machine id;
`store.ts` decrypts it with `vendor/qoder-auth.wasm`, the same cipher module
qodercli embeds. The request body needs the CLI-shaped `metadata.business`
object or the server rejects every model id except `auto`, and its SSE frames
sometimes carry a raw newline inside the JSON, so `stream.ts` scans each
`data:` payload as one balanced JSON value instead of splitting on lines.
Session ids are normalized to a UUID (`qoderSessionId`) and sent as
`X-Session-ID`. Auth: `qodercli login` or `QODER_PERSONAL_ACCESS_TOKEN`.

A DSH profile can point at a local build with
`dsh plugin --profile <name> add link:<path>/packages/dsh-llm-kiro`.

## CI

`.github/workflows/ci.yml` runs on push to `main` and on pull requests:
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm -r build`, `pnpm -r check`,
`pnpm test`. Run the same sequence locally before pushing.

## Releasing

npm publishes only `@ngosangns/ns-bridge`. The provider packages are no longer
developed; their last versions stay on npm and are marked deprecated, and in
this workspace they are `private: true`. `scripts/release-plan.mjs` refuses to
run when any other package is publishable. What they build is shipped inside
the CLI tarball as `dist/hosts/**`, so a provider change reaches users with
the next `ns-bridge` release, not a package of its own.

Publishing runs from `.github/workflows/publish.yml` using npm **trusted
publishing** (OIDC) on the self-hosted runner, so no npm token is stored.
The workflow accepts only a `ns-bridge@<version>` tag.

### Cutting a release

1. Bump `version` in `packages/cli/package.json`.
2. Commit and push to `main`.
3. Push the tag, npm scope dropped:

   ```bash
   git tag ns-bridge@<version> && git push origin ns-bridge@<version>
   ```

`npm view @ngosangns/ns-bridge versions` lists what is published; never
republish one of those or push its tag again. The next release is a new
version in `packages/cli/package.json`.

The workflow re-runs lint, build, typecheck and tests, then
[`scripts/release-plan.mjs`](scripts/release-plan.mjs) publishes that CLI
version when npm does not have it yet. It refuses a tag for any other package,
or a CLI version already on npm.

A package npm has never seen is left out of the plan with a warning: trusted
publishing cannot create a package, so its first version is published by hand
and its trusted publisher registered afterwards
(`npm trust github @ngosangns/ns-bridge --file publish.yml --repo ngosangns/ns-bridge --allow-publish`).

Then it packs with `pnpm pack`, verifies the packed manifest (`repository.url`
naming this repo, no `workspace:` range), and publishes with `npm publish`.
Run `node scripts/release-plan.mjs` locally to see what a tag would ship.
`workflow_dispatch` runs the same job, dry-run by default.

Tags from before the merge were renamed to the same scheme
(`ns-pi-provider@0.2.2`, `ns-omp-provider@0.3.1`, `ns-devin-core@0.2.0`, …);
the former ns-kiro-provider `v*` tags are kept and mirrored as
`ns-kiro-core@<version>`.

### Trusted publisher for `@ngosangns/ns-bridge`

The publisher is registered. The `0.1.1` publish validated it, and every
release since has published from the same workflow (`0.1.2` was workflow
`39284264937`). `npm view @ngosangns/ns-bridge versions` lists them, and
`gh run list -R ngosangns/ns-bridge -w publish.yml` shows the runs. Settings →
Trusted Publisher → GitHub Actions, with

| Field | Value |
| --- | --- |
| Organization / user | `ngosangns` |
| Repository | `ns-bridge` |
| Workflow filename | `publish.yml` |
| Environment | *(leave empty)* |

or:

```bash
npm trust github @ngosangns/ns-bridge --file publish.yml --repo ngosangns/ns-bridge --allow-publish
```

`--allow-publish` is required. npm can stage by default, and this workflow
runs `npm publish`, not `npm stage publish`. Leave the environment empty:
`publish.yml` does not set one.

npm only allows a trusted publisher on a package that exists, so a brand-new
package needs its first version published by hand from a logged-in machine:

```bash
pnpm --filter @ngosangns/ns-bridge build && cd packages/cli && pnpm pack && npm publish ./ngosangns-ns-bridge-<version>.tgz --access public
npm trust github @ngosangns/ns-bridge --file publish.yml --repo ngosangns/ns-bridge --allow-publish
```

That sequence already ran for this CLI: `0.1.0` from a logged-in machine, then
every later version from the workflow. A later release is a
version bump and a new `ns-bridge@<version>` tag.

A trusted publisher that has never published expires 48 hours after it is
created. Uploading from the laptop does not validate it. The first successful
`npm publish` from this workflow does, and binds the configuration to the
repository id. When the first version was uploaded locally, bump a patch and
push that package's tag the same day so CI publishes it. After that, later
versions publish from the tag. Do not ask for `npm login`, an OTP, or a token.

`npm trust list <name>` prints the configuration. `npm trust list --json`
asks for a fresh one-time password, so do not use it.

Until a new package exists on npm, `scripts/release-plan.mjs` leaves it out
of the plan with a warning, and tagging it fails. A planned package that
depends on it is refused.

### Why `pnpm pack` and `npm publish`, not one tool

The adapters declare internal dependencies as `workspace:*`. Only pnpm rewrites
that to the real version when packing; `npm pack` would ship the literal
`workspace:*` and the published package would be uninstallable. But `pnpm
publish` does not speak OIDC, so the tarball pnpm produces is handed to
`npm publish`.
