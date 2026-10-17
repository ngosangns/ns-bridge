# Developing ns-bridge

Contributor guide for building, testing, and extending this repo. For what the
project is and how to install/use it, see [README.md](README.md).

## Layout

pnpm workspace, eight packages under `packages/` in three layers.

| Layer | Package | Owns |
| --- | --- | --- |
| shared | [`ns-bridge-core`](packages/bridge-core) | The neutral vocabulary (`Bridge*` messages, tools, stream events, usage, effort) and one bridge per host family: `./pi` (Pi and OMP) and `./dsh` (DeepSeek Harness) |
| vendor core | [`ns-kiro-core`](packages/kiro-core) | The Kiro protocol in this process: AWS event-stream, request building, response assembly, the retry ladder, tokenizer, login, local credential stores (kiro-cli, Kiro IDE) and their selection, the model-catalog cache, profile caches, error vocabulary, and host login/model helpers (`host-auth.ts`, `host-model.ts`) |
| vendor core | [`ns-devin-core`](packages/devin-core) | The Devin protocol in this process: Cascade over Connect/protobuf, PKCE login, credentials files, the model catalog cache, usage, error vocabulary, and request/result conversion |
| host adapter | [`@ngosangns/ns-pi-provider`](packages/pi-provider) | Pi: `kiro` + `devin` over the cores via `ns-bridge-core/pi`; `grok` (local CLI / ACP) still lives here |
| host adapter | [`ns-omp-provider`](packages/omp-provider) | OMP: bundles the Pi adapter behind an OMP-compat layer; `kiro` opt-in |
| host adapter | [`ns-omp-provider-kiro`](packages/omp-provider-kiro) | OMP: `kiro` over `ns-kiro-core` via `ns-bridge-core/pi` |
| host adapter | [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro), [`ns-dsh-llm-devin`](packages/dsh-llm-devin) | Harness `LlmAdapter`s over the cores via `ns-bridge-core/dsh` |

### Where a change goes

- **Wire protocol** (request shape, streaming, retries, credentials, catalog) →
  the vendor core. Never in an adapter: three hosts would each need the fix.
- **Host translation** (a host's message or event shape) → `ns-bridge-core`,
  once per host family. Typed structurally (`PiContextLike`, …) so one bridge
  serves both Pi and OMP without importing either.
- **Host adapters** register with the host and wire a core to a bridge. If two
  adapters grow the same logic, move it down a layer.
- Dependencies point down only: adapters → cores + bridge. The cores emit the
  bridge vocabulary *structurally* and do not import `ns-bridge-core`;
  `ns-bridge-core` imports no core at runtime (only its tests do).

### In-process engines

Kiro and Devin run in the Node process that loaded the host adapter.
`streamKiro` and `streamDevin` yield `BridgeStreamEvent`s. `streamToPi` and
`streamToDsh` in `ns-bridge-core` turn those events into the host's stream.

| Path | Owns |
| --- | --- |
| `packages/kiro-core/src` | Kiro: `generateAssistantResponse` over AWS event-stream, the retry ladder, catalog, usage, token refresh, API-key login |
| `packages/devin-core/src` | Devin: Cascade over Connect/protobuf, model discovery, usage, PKCE login |
| `packages/bridge-core/src/types.ts` | The vocabulary both engines emit and both host bridges consume |
| `packages/bridge-core/src/pi`, `packages/bridge-core/src/dsh` | Host translation |

`KIRO_RUNTIME_ENDPOINT` / `KIRO_MANAGEMENT_ENDPOINT` (`{region}` substituted)
redirect Kiro, for example to a test server. `refreshDevinToken` is a
no-request shortcut: Devin issues no refresh token.

### The `kiro` provider id in OMP

`ns-omp-provider-kiro` owns `kiro` in OMP. `ns-omp-provider` keeps its `kiro`
behind `NS_OMP_PROVIDER_ENABLE=kiro` / `NS_OMP_PROVIDERS` so the two never
register the same id. Both run `ns-kiro-core`.

### Inside ns-kiro-core

The wire protocol and the per-process state both live in this package.

| Module | Owns |
| --- | --- |
| [`request-builder.ts`](packages/kiro-core/src/request-builder.ts), [`response-stream.ts`](packages/kiro-core/src/response-stream.ts), [`response-assembler.ts`](packages/kiro-core/src/response-assembler.ts), [`event-parser.ts`](packages/kiro-core/src/event-parser.ts), [`retry.ts`](packages/kiro-core/src/retry.ts), [`transport.ts`](packages/kiro-core/src/transport.ts) | Request building, AWS event-stream framing, response assembly, the retry ladder |
| [`tokenizer.ts`](packages/kiro-core/src/tokenizer.ts), [`thinking-parser.ts`](packages/kiro-core/src/thinking-parser.ts), and the tool parsers | Token counts (`js-tiktoken` `cl100k_base`), thinking tags, tool-call recovery |
| [`kiro-cli.ts`](packages/kiro-core/src/kiro-cli.ts), [`kiro-ide.ts`](packages/kiro-core/src/kiro-ide.ts) | The local credential stores — kiro-cli's SQLite DB and the Kiro IDE's credentials file — and which one a machine resolves (`KIRO_AUTH_SOURCE`) |
| [`oauth.ts`](packages/kiro-core/src/oauth.ts) | Credential resolution, token refresh, and API-key login (`loginKiroWithApiKey` calls GetProfile) |
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
pnpm test           # vitest projects: bridge, kiro, devin, pi, omp
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

Every package keeps its own version.
Publishing runs from `.github/workflows/publish.yml` using npm **trusted
publishing** (OIDC) on the self-hosted runner, so no npm token is stored.

### Cutting a release

1. Bump `version` in each `packages/*/package.json` you want to ship. A package
   whose shipped code changed since its last release must be bumped before any
   package that depends on it can ship — the dependent is packed with an exact
   pin, and would otherwise install the old code.
2. Commit and push to `main`.
3. Push one tag naming any of the bumped packages, npm scope dropped:

   ```bash
   git tag ns-kiro-core@0.3.9 && git push origin ns-kiro-core@0.3.9
   git tag ns-pi-provider@0.2.3 && git push origin ns-pi-provider@0.2.3
   ```

The workflow re-runs lint, build, typecheck and tests, then
[`scripts/release-plan.mjs`](scripts/release-plan.mjs) computes the release:
every public package whose `package.json` version is not on npm yet, in
dependency order. It refuses to run when

- the tag's package is not in the plan (version not bumped, or already on npm);
- a planned package depends on a sibling whose code changed since that
  sibling's released version (bump the sibling too).

A package npm has never seen is left out of the plan with a warning: trusted
publishing cannot create a package, so its first version is published by hand
(`npm publish` with 2FA, dependencies first) and its trusted publisher
registered afterwards (`npm trust github <name> --file publish.yml --repo
ngosangns/ns-bridge --allow-publish`). A planned package that depends on one
is refused until then; a peer dependency (ns-bridge-core → @deepseek-ai/dsh-llm)
does not count.

Then it packs with `pnpm pack` (which rewrites `workspace:*` to exact versions),
verifies every packed manifest (no `workspace:` ranges left, every internal pin
on npm or in this run, `repository.url` naming this repo), and publishes with
`npm publish`, dependencies first. Run `node scripts/release-plan.mjs` locally to
see what a tag would ship. `workflow_dispatch` runs the same job, dry-run by
default.

Tags from before the merge were renamed to the same scheme
(`ns-pi-provider@0.2.2`, `ns-omp-provider@0.3.1`, `ns-devin-core@0.2.0`, …);
the former ns-kiro-provider `v*` tags are kept and mirrored as
`ns-kiro-core@<version>`.

### One-time setup (per package, on npmjs.com)

For each package: Settings → Trusted Publisher → GitHub Actions, with

| Field | Value |
| --- | --- |
| Organization / user | `ngosangns` |
| Repository | `ns-bridge` |
| Workflow filename | `publish.yml` |
| Environment | *(leave empty)* |

or `npm trust github <package> --file publish.yml --repo ngosangns/ns-bridge --allow-publish`.

npm only allows a trusted publisher on a package that exists, so a brand-new
package needs its first version published by hand from a logged-in machine
before the workflow can take over:

```bash
pnpm --filter <name> build && cd packages/<dir> && pnpm pack && npm publish ./<name>-<v>.tgz --access public
```

Until a new package exists on npm with its trusted publisher set, every
release plan includes it, and the workflow's publish of it fails.

### Why `pnpm pack` and `npm publish`, not one tool

The adapters declare internal dependencies as `workspace:*`. Only pnpm rewrites
that to the real version when packing; `npm pack` would ship the literal
`workspace:*` and the published package would be uninstallable. But `pnpm
publish` does not speak OIDC, so the tarball pnpm produces is handed to
`npm publish`.
