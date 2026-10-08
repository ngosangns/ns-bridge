# Developing ns-bridge

Contributor guide for building, testing, and extending this repo. For what the
project is and how to install/use it, see [README.md](README.md).

## Layout

pnpm workspace, fourteen packages under `packages/`: eight in three layers, plus
the six that ship the Go sidecar binary.

| Layer | Package | Owns |
| --- | --- | --- |
| shared | [`ns-bridge-core`](packages/bridge-core) | The neutral vocabulary (`Bridge*` messages, tools, stream events, usage, effort) and one bridge per host family: `./pi` (Pi and OMP) and `./dsh` (DeepSeek Harness) |
| vendor core | [`ns-kiro-core`](packages/kiro-core) | The Kiro protocol — endpoints, catalog + cache, kiro-cli/IDE credentials and refresh, AWS event-stream framing, thinking/tool-call parsing, history repair, the retry ladder, host login/model helpers (`host-auth.ts`, `host-model.ts`) |
| vendor core | [`ns-devin-core`](packages/devin-core) | The Devin protocol — Connect/protobuf, PKCE + CLI credentials, discovery, quota, optional capacity retry |
| host adapter | [`@ngosangns/ns-pi-provider`](packages/pi-provider) | Pi: `kiro` + `devin` over the cores via `ns-bridge-core/pi`; `grok` (local CLI / ACP) still lives here |
| host adapter | [`ns-omp-provider`](packages/omp-provider) | OMP: bundles the Pi adapter behind an OMP-compat layer; `kiro` opt-in |
| host adapter | [`ns-omp-provider-kiro`](packages/omp-provider-kiro) | OMP: `kiro` over `ns-kiro-core` via `ns-bridge-core/pi` |
| host adapter | [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro), [`ns-dsh-llm-devin`](packages/dsh-llm-devin) | Harness `LlmAdapter`s over the cores via `ns-bridge-core/dsh` |
| sidecar binary | [`ns-bridge-bin`](packages/bridge-bin) | `binaryPath()`: the Go binary installed for this machine, via the platform package below |
| sidecar binary | `ns-bridge-bin-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}` (`packages/bridge-bin-*`) | One binary each, `os`/`cpu`-gated optional dependencies of `ns-bridge-bin`; the binary is built at pack time, never committed |

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

### The Go sidecar (in progress)

The vendor cores are being rewritten in Go. Hosts load providers as in-process
JavaScript, so only the vendor work moves: one Go binary, `ns-bridge`
([`go/`](go)), that a host adapter starts per model call through
`ns-bridge-core/sidecar`. It reads a request envelope on stdin and streams
`BridgeStreamEvent` NDJSON on stdout — the same `AsyncIterable` the TypeScript
cores hand `streamToPi` / `streamToDsh` today. Contract:
[docs/SIDECAR-PROTOCOL.md](docs/SIDECAR-PROTOCOL.md).

| Path | Owns |
| --- | --- |
| `go/internal/bridge` | The vocabulary in Go (mirrors `packages/bridge-core/src/types.ts`), the envelope, the NDJSON writer, terminal errors |
| `go/internal/sidecar` | One call's lifecycle: envelope, vendor dispatch, cancellation on stdin EOF / SIGTERM, exit codes |
| `go/internal/vendors/<id>` | A vendor core. Only `echo` (no network, for tests) so far |
| `go/cmd/ns-bridge` | The CLI: `stream --vendor <id>`, `vendors`, `version` |
| `packages/bridge-core/src/sidecar` | The TypeScript client: `sidecarStream(vendor, request, { signal })`, `SidecarError`, `resolveSidecarBinary` |
| `packages/bridge-bin*` | Distribution: `ns-bridge-bin` + five platform packages (npm, bun and pnpm install only the matching one, no install scripts) |
| `scripts/build-sidecar.mjs` | Cross-compiles every target (CGO off, `-X main.version=<ns-bridge-bin version>`) into `packages/bridge-bin-*/bin` |

The client finds the binary through `NS_BRIDGE_BIN`, an explicit path,
`ns-bridge-bin` (an optional peer of `ns-bridge-core`: an adapter that runs a
vendor in the sidecar depends on it), then `ns-bridge` on `PATH`.

Status: M1 (protocol, client, echo vendor, binary packages). Kiro and Devin
still run on the TypeScript cores; no adapter depends on `ns-bridge-bin` yet. Change `types.ts` and
`go/internal/bridge` together — the JSON must stay identical.

### The `kiro` provider id in OMP

`ns-omp-provider-kiro` owns `kiro` in OMP. `ns-omp-provider` keeps its `kiro`
behind `NS_OMP_PROVIDER_ENABLE=kiro` / `NS_OMP_PROVIDERS` so the two never
register the same id. Both run `ns-kiro-core`.

### Inside ns-kiro-core: one model call, end to end

A single request is split across four modules so each can be read — and
tested — on its own. `stream.ts` is the orchestrator and holds only what needs
the whole picture: credential rotation, the HTTP retry policy, and the decision
to ask again.

| Module | Owns |
| --- | --- |
| [`request-builder.ts`](packages/kiro-core/src/request-builder.ts) | Neutral messages to a `KiroRequest`: history shaping, tool specs, pre-send repair. Pure — no I/O, so request shaping is testable without a transport |
| [`transport.ts`](packages/kiro-core/src/transport.ts) | Abortable delays, the response-header deadline, capacity logging |
| [`response-stream.ts`](packages/kiro-core/src/response-stream.ts) | AWS event-stream framing and the stall timeouts; yields parsed wire events |
| [`response-assembler.ts`](packages/kiro-core/src/response-assembler.ts) | What the response *says*: content blocks, thinking, tool calls, text-dialect recovery, usage, stop reason |
| [`stream.ts`](packages/kiro-core/src/stream.ts) | Orchestration: endpoint and profile resolution, HTTP retries (403 / capacity / rate limit), degenerate-response retries |

When porting an upstream change to `src/stream.ts`, map it to the module that
owns that concern rather than looking for the matching lines — see the
divergence entry in `.upstream-sync.json` for the region map.

## Prerequisites

- Node >=22 (`engines.node` in `package.json`)
- pnpm (`packageManager` in `package.json`)
- Go (version in `go/go.mod`) for `go/` and for bridge-core's sidecar tests,
  which build the binary; without Go those tests are skipped

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
(cd go && gofmt -l . && go vet ./... && go test ./...)   # the Go sidecar
```

Run the sidecar by hand with the echo vendor:

```bash
cd go && echo '{"protocol":1,"request":{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}}' \
  | go run ./cmd/ns-bridge stream --vendor echo --ignore-stdin-eof
```

`NS_BRIDGE_BIN=/path/to/ns-bridge` points `sidecarStream` at a local build.

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
`gofmt -l`, `go vet ./...` and `go test ./...` in `go/`,
`node scripts/build-sidecar.mjs` (every target must cross-compile), then
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm -r build`, `pnpm -r check`,
`pnpm test`. Run the same sequence locally before pushing.

## Releasing

Every package keeps its own version; only the six sidecar binary packages
move in lockstep (below).
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

Then it packs with `pnpm pack` (which rewrites `workspace:*` to exact versions),
verifies every packed manifest (no `workspace:` ranges left, every internal pin
on npm or in this run, `repository.url` naming this repo), and publishes with
`npm publish`, dependencies first. Run `node scripts/release-plan.mjs` locally to
see what a tag would ship. `workflow_dispatch` runs the same job, dry-run by
default.

### The sidecar binary packages

`ns-bridge-bin` and the five `ns-bridge-bin-<os>-<cpu>` packages always share
one version: bump all six together (`release-plan.mjs` refuses mismatched
versions). A change under `go/` or to `scripts/build-sidecar.mjs` counts as a
change to all six, so a package that depends on `ns-bridge-bin` cannot ship
against a stale binary. Tag any one of them, e.g.
`git tag ns-bridge-bin@0.2.0`.

The workflow cross-compiles every target with `scripts/build-sidecar.mjs`
before packing, packs the platform packages with `npm pack` (pnpm pack drops
the executable bit on files not named in `bin`), and checks each tarball
carries an executable binary; the one matching the runner must report the
package version. Local dry run:

```bash
node scripts/build-sidecar.mjs            # all targets; --host for this machine only
packages/bridge-bin-darwin-arm64/bin/ns-bridge version
```

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

- a TypeScript package (as `ns-bridge-core` was): `pnpm --filter <name> build &&
  cd packages/<dir> && pnpm pack && npm publish ./<name>-<v>.tgz --access public`;
- the sidecar binary packages: build every target, `npm pack` each platform
  package and `pnpm pack` `ns-bridge-bin`, then publish the five platform
  tarballs before `ns-bridge-bin` (its optional dependencies pin them):

  ```bash
  node scripts/build-sidecar.mjs
  mkdir -p /tmp/nsb && for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do
    (cd packages/bridge-bin-$t && npm pack --pack-destination /tmp/nsb)
  done
  (cd packages/bridge-bin && pnpm pack --pack-destination /tmp/nsb)
  for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do
    npm publish /tmp/nsb/ns-bridge-bin-$t-<v>.tgz --access public
  done
  npm publish /tmp/nsb/ns-bridge-bin-<v>.tgz --access public
  ```

Until a new package exists on npm with its trusted publisher set, every
release plan includes it, and the workflow's publish of it fails.

### Why `pnpm pack` and `npm publish`, not one tool

The adapters declare internal dependencies as `workspace:*`. Only pnpm rewrites
that to the real version when packing; `npm pack` would ship the literal
`workspace:*` and the published package would be uninstallable. But `pnpm
publish` does not speak OIDC, so the tarball pnpm produces is handed to
`npm publish`.
