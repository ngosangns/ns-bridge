# ns-bridge

## Branching

- Work only on `main`. Do not create new branches.
- Commit directly on `main` and push to `origin/main`.
- Exception: Firstmate delivery workers may use one short-lived `fm/<task>` branch per task to open a pull request into `main`; that branch is deleted as soon as it is merged.

## Where code goes

- Vendor wire protocol (requests, streaming, retries, credentials, model catalog, usage, token refresh, login) → `go/internal/vendors/<id>` in the Go sidecar. Vendor fixes go there, not in TypeScript.
- Vendor-core TypeScript (`packages/<vendor>-core`) keeps only what is per-process state: local credential stores (files on this machine) and their selection, caches, error vocabulary, host helpers, and the sidecar facades that pack state into requests and fold results back. No host types there.
- Host translation shared by every vendor (Pi-family, Harness) → `packages/bridge-core`.
- Host adapters (`pi-provider`, `omp-provider*`, `dsh-llm-*`) stay glue: register with the host, wire core + bridge together. If two adapters need the same logic, it belongs in a core or the bridge.
- Go sidecar (one `ns-bridge` binary per call) → `go/`; its TS client → `packages/bridge-core/src/sidecar`. Contract: `docs/SIDECAR-PROTOCOL.md`. Binaries ship as `ns-bridge-bin` (a required dependency of `ns-bridge-core`) + `ns-bridge-bin-<os>-<cpu>` (six packages, one version, binaries built by `scripts/build-sidecar.mjs`, never committed). Keep `go/internal/bridge` and `packages/bridge-core/src/types.ts` in lockstep. There is no TypeScript engine fallback — a missing binary is an error.
- See DEVELOPER.md for the full layering and the release flow.
