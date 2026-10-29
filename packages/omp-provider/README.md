# ns-omp-provider

> Source-only build input for [@ngosangns/ns-bridge](https://www.npmjs.com/package/@ngosangns/ns-bridge).
> `ns-bridge install omp` ships this package prebuilt as the CLI's `dist/hosts/omp` bundle;
> it is no longer published on its own.

[OMP](https://omp.sh) (oh-my-pi) plugin that exposes the **Kiro**, **Arnict**,
and **Qoder** providers from [`@ngosangns/ns-pi-provider`](../pi-provider), part
of [ns-bridge](https://github.com/ngosangns/ns-bridge).

`ns-pi-provider` targets Pi 1.0. OMP is a Pi fork whose extension API is close
but not identical — this package is the adapter. It does **not** modify
`ns-pi-provider`; the workspace's Pi registrations (and the vendor cores under
them) are bundled at build time with a small compat layer.

## Devin and Grok are OMP's own

This plugin no longer registers `devin` or `grok`. OMP has them built in, and the
plugin's `devin` used to shadow OMP's:

| What | In OMP | Sign in |
|------|--------|---------|
| Devin | native provider `devin` | `/login devin` or `DEVIN_API_KEY` |
| Grok | native providers `xai-oauth` (SuperGrok) and `xai` (API key) | `/login xai-oauth` or `XAI_API_KEY` |

**Moving off the old plugin.** If your OMP `config.yml` (default model, roles,
fallbacks) names `devin/…` or `grok/…`:

1. `devin/<model>` keeps its id, but now resolves to OMP's native catalog. Check
   `omp models devin` for the ids it offers.
2. `grok/<model>` has no native twin by that name. Pick one from `omp models xai-oauth`
   (or `omp models xai`) and use `xai-oauth/<model>`.
3. `ns-bridge install omp` removes the old plugins (`ns-omp-provider-kiro`,
   `ns-omp-provider`) and installs the bundled one in their place.

Pi still gets `devin` and `grok` from `@ngosangns/ns-pi-provider`.

| Provider | Auth | Notes |
|----------|------|-------|
| `kiro` | kiro-cli / Kiro IDE session (`/login kiro`) + `KIRO_API_KEY` | |
| `arnict` | `ARNICT_API_KEY` or `~/.ns-bridge/arnict.json` | registers only `/arnict` until a key is present |
| `qoder` | `qodercli login` session or `QODER_PERSONAL_ACCESS_TOKEN` | |

## Install

```bash
# maintained installer (registers the prebuilt dist/hosts/omp bundle with OMP)
ns-bridge install omp

# local build (a clone of ns-bridge, after `pnpm -r build`)
omp plugin install ~/Github/ngosangns/ns-bridge/packages/cli/dist/hosts/omp

# one-shot without installing
omp -e ./dist/index.js ...
# or: omp models --no-extensions -e ./dist/index.js
```

Then `/login kiro` as needed.

### Choosing providers

This package registers `kiro`, `arnict`, and `qoder`. `~/.ns-bridge/providers.json`
and the env lists decide which:

```bash
export NS_OMP_PROVIDER_ENABLE=kiro       # register kiro from this package
export NS_OMP_PROVIDERS=kiro             # allow-list
export NS_OMP_PROVIDER_DISABLE=kiro      # deny-list, applied last
```

`devin` and `grok` in those lists, or as keys in `providers.json`, are accepted and
ignored (the Pi adapter reads the same file and still uses them).

## How the wrapper works

1. **Build-time** — esbuild bundles `@ngosangns/ns-pi-provider` into
   `dist/index.js`, rewriting `@earendil-works/pi-ai*` imports onto
   `src/compat/` (OMP's `@oh-my-pi/pi-ai` plus Pi 1.0 transcript helpers that
   OMP does not ship — `getCurrentSystemPrompt`, `getCurrentTools`,
   `withoutInitialSystemMessage` — re-exported from `ns-bridge-core/pi`).
2. **Runtime** — the OMP `ExtensionAPI` is wrapped so that:
   - OMP contexts (`systemPrompt: string[]`, `developer` messages) become the
     Pi shape (`systemPrompt: string`, no developer role) before
     `streamSimple`.
   - Pi's `refreshModels` hook is exposed as OMP's `fetchDynamicModels`. Both
     read the catalog file. A fresh file is returned; a stale or empty file
     returns null so OMP keeps the models already registered.
   - Pi `$ENV` / `$$` apiKey syntax is translated to OMP's.
   - Unsupported events (`session_info_changed`) are no-ops; OMP's
     `session_switch` / `session_branch` also fire Pi's `session_start`
     handlers (OMP only emits `session_start` once at startup).

`ns-pi-provider` itself is unchanged.

## Known limitations

- **`session_info_changed`** — OMP has no equivalent; it is a documented no-op
  (name changes do not re-key the agent pool).
- **No `/ns-pi` or `/grok` commands** — they went with the Devin and Grok registration.
  `ns-bridge models list` and `ns-bridge providers status omp` cover the status.
- **Catalog files** — the models OMP shows are the ones already on disk.
  `ns-bridge models refresh` writes them. `fetchDynamicModels` returns
  a fresh file, or null when the file is missing, empty, or past its TTL, and
  does not call the vendor.
- **Kiro catalog** — with no saved catalog snapshot, `kiro`
  registers zero models.
- **Bundled Pi adapter** — the build bundles the workspace's
  `@ngosangns/ns-pi-provider` (`workspace:*`). Nothing of this package is
  published; OMP receives it through `ns-bridge install omp`, which registers
  the prebuilt bundle inside the CLI package.

## Development

From the ns-bridge root:

```bash
pnpm install && pnpm -r build
pnpm vitest run --project omp                 # hermetic unit + bundle load tests
pnpm --filter ns-omp-provider typecheck
pnpm --filter ns-omp-provider smoke           # optional: real `omp models -e dist/index.js` under a temp HOME
```

The smoke script needs `omp` on `PATH` and does not touch your real `~/.omp`.

## Publish

Nothing here is published. npm publishes only
[`@ngosangns/ns-bridge`](https://www.npmjs.com/package/@ngosangns/ns-bridge)
from tag `ns-bridge@<version>`; the last `ns-omp-provider` release on npm
(`0.6.3`) is deprecated and kept for rollback. See
[DEVELOPER.md](../../DEVELOPER.md#releasing).
