# Developing ns-bridge

Contributor guide for building, testing, and extending this repo. For what the
project is and how to install/use it, see [README.md](README.md).

## Layout

pnpm workspace. Eleven packages under `packages/`. npm publishes only `@ngosangns/ns-bridge`. The other packages stay at their last published version.

This repository was assembled from `ns-kiro-provider` (renamed to this one), `ns-pi-provider`, `ns-omp-provider`, and `ns-devin-provider` (archived, each pointing here).

| Layer | Package | Owns |
| --- | --- | --- |
| shared | [`ns-core-utils`](packages/core-utils) | Plumbing every vendor core needs and none owns: retry-header parsing, exponential backoff, abort-aware delay, and the atomic JSON cache read/write. Dependency-free and host-free, so a core can depend on it without gaining a host coupling |
| shared | [`ns-bridge-core`](packages/bridge-core) | The neutral vocabulary (`Bridge*` messages, tools, stream events, usage, effort) and one bridge per host family: `./pi` (Pi and OMP) and `./dsh` (DeepSeek Harness, including the `createDshLlmAdapter` factory every Harness adapter is built from) |
| vendor core | [`ns-kiro-core`](packages/kiro-core) | The Kiro protocol in this process: AWS event-stream, request building, response assembly, the retry ladder, tokenizer, login, local credential stores (kiro-cli, Kiro IDE) and their selection, the model-catalog cache, profile caches, error vocabulary, and host login/model helpers (`host-auth.ts`, `host-model.ts`) |
| vendor core | [`ns-devin-core`](packages/devin-core) | The Devin protocol in this process: Cascade over Connect/protobuf, PKCE login, credentials files, the model catalog cache, usage, error vocabulary, and request/result conversion |
| vendor core | [`ns-grok-core`](packages/grok-core) | The Grok Responses API in this process: request building, SSE parsing, stream assembly, usage, the CLI login session and its refresh, error vocabulary, the model catalog contract, and — under `./agent` — locating the Grok CLI and reading its model list |
| host adapter | [`@ngosangns/ns-pi-provider`](packages/pi-provider) | Pi: `kiro`, `devin`, and `grok` over the cores via `ns-bridge-core/pi`. Grok streams through the Responses API; the CLI is only consulted for its model list |
| host adapter | [`ns-omp-provider`](packages/omp-provider) | OMP: bundles the Pi adapter behind an OMP-compat layer; `kiro` opt-in |
| host adapter | [`ns-omp-provider-kiro`](packages/omp-provider-kiro) | OMP: `kiro` over `ns-kiro-core` via `ns-bridge-core/pi` |
| host adapter | [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro), [`ns-dsh-llm-devin`](packages/dsh-llm-devin), [`ns-dsh-llm-grok`](packages/dsh-llm-grok) | Harness `LlmAdapter`s over the cores via `ns-bridge-core/dsh`. Each is a vendor spec plus its error vocabulary; the adapter skeleton is `createDshLlmAdapter` |
| cli | [`@ngosangns/ns-bridge`](packages/cli) | `ns-bridge`: the only package this repo publishes. Installs host packages and refreshes model catalogs outside the host process |

Pi, OMP, and DSH read the catalog files while they run. They do not refresh those files. `ns-bridge models refresh --apply` writes them.

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
| `packages/grok-core/src/agent` | Grok: locating the CLI binary and reading `grok models` |
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

### The `kiro` provider id in OMP

`ns-omp-provider-kiro` owns `kiro` in OMP while that plugin is installed.
`ns-omp-provider` registers `kiro` too, but skips it in that case unless
`~/.ns-bridge/providers.json` or `NS_OMP_PROVIDERS` / `NS_OMP_PROVIDER_ENABLE`
names it. Both run `ns-kiro-core`.

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

## Prerequisites

- Node >=22 (`engines.node` in `package.json`)
- pnpm (`packageManager` in `package.json`)

## Setup, build, check, test

```bash
git clone git@github.com:ngosangns/ns-bridge.git
cd ns-bridge
pnpm install
pnpm -r build       # check typechecks against built declarations, so build first
pnpm -r check
pnpm test           # vitest projects: bridge, core-utils, kiro, devin, grok, grok-dsh, cli, pi, omp
pnpm vitest run --project kiro   # one project
pnpm lint           # biome check .  (lint:fix / format to write)
```

Pi and OMP adapters keep their own formatting and are excluded from Biome.

### Live checks

Hermetic tests never touch the network. With real sessions on the machine:

```bash
pi --no-extensions -e ./packages/pi-provider/index.ts --list-models
pi --no-extensions -e ./packages/pi-provider/index.ts --model kiro/claude-haiku-4-5 -p "hi"
omp --no-extensions -e ./packages/omp-provider-kiro/dist/index.js --model kiro/claude-haiku-4-5 -p "hi"
omp --no-extensions -e ./packages/omp-provider/dist/index.js --model devin/swe-1-6 -p "hi"
NS_PI_LIVE=1 pnpm --filter @ngosangns/ns-pi-provider test:live
```

A DSH profile can point at a local build with
`dsh plugin --profile <name> add link:<path>/packages/dsh-llm-kiro`.

## CI

`.github/workflows/ci.yml` runs on push to `main` and on pull requests:
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm -r build`, `pnpm -r check`,
`pnpm test`. Run the same sequence locally before pushing.

## Releasing

npm publishes only `@ngosangns/ns-bridge`. The provider packages are no longer
developed; their last versions stay on npm and are marked deprecated.
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

The CLI on npm is `0.1.7`, tagged `ns-bridge@0.1.7`. That tag is already
published. Do not republish `0.1.0` through `0.1.6`. The next release is a new
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

The publisher is registered. The `0.1.1` publish validated it, and `0.1.2`
(workflow `39284264937`), `0.1.3` (workflow `39363250503`), `0.1.4`
(workflow `39382637599`), `0.1.5` (workflow `39396872195`), `0.1.6` (workflow `39457751796`), and `0.1.7` published from the same workflow. Settings →
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
`0.1.1`, `0.1.2`, `0.1.3`, `0.1.4`, `0.1.5`, `0.1.6`, and `0.1.7` from the workflow. A later release is a
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
