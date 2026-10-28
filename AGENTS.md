# ns-bridge

## Branching

- Work only on `main`. Do not create new branches.
- Commit directly on `main` and push to `origin/main`.
- Exception: Firstmate delivery workers may use one short-lived `fm/<task>` branch per task to open a pull request into `main`; that branch is deleted as soon as it is merged.

## Where code goes

- Vendor wire protocol (requests, streaming, retries, credentials, model catalog, usage, token refresh, login) → `packages/<vendor>-core`. Those cores run in the host process. No host types there.
- Host translation shared by every vendor (Pi-family, Harness) → `packages/bridge-core`.
- Host adapters (`pi-provider`, `omp-provider*`, `dsh-llm-*`) stay glue: register with the host, wire core + bridge together. If two adapters need the same logic, it belongs in a core or the bridge.
- npm publishes only `@ngosangns/ns-bridge` (`packages/cli`). The provider packages stay at their last versions and are deprecated on npm.
- Hosts read model catalog files. `ns-bridge models refresh` is the command that writes them.
- See DEVELOPER.md for the full layering and the release flow.
