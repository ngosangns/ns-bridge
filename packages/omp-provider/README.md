# ns-omp-provider

[OMP](https://omp.sh) (oh-my-pi) plugin that exposes the **Kiro**, **Devin**, and
**Grok** providers from [`@ngosangns/ns-pi-provider`](../pi-provider), part of
[ns-bridge](https://github.com/ngosangns/ns-bridge).

`ns-pi-provider` targets Pi 1.0. OMP is a Pi fork whose extension API is close
but not identical — this package is the adapter. It does **not** modify
`ns-pi-provider`; the workspace's Pi sources (and the vendor cores under them)
are bundled at build time with a small compat layer.

| Provider | Auth | Notes |
|----------|------|-------|
| `kiro` (**opt-in**) | kiro-cli / Kiro IDE session (`/login kiro`) + `KIRO_API_KEY` | Off by default — use [`ns-omp-provider-kiro`](https://www.npmjs.com/package/ns-omp-provider-kiro); see below |
| `devin` | OAuth (`/login devin`) + `credentials.toml` / env | Swe-2 catalog when authenticated |
| `grok` (+ `grok-sdk` alias) | Local `grok` CLI / `~/.grok` / `XAI_API_KEY` | Commands: `/grok status \| models \| refresh` |

Shared command: `/ns-pi status | refresh [all\|kiro\|devin\|grok]`.

## Install

```bash
# from npm
omp plugin install ns-omp-provider

# local link (dev, after `pnpm -r build` in ns-bridge)
omp plugin link ~/Github/ngosangns/ns-bridge/packages/omp-provider

# one-shot without installing
omp -e ./dist/index.js ...
# or: omp models --no-extensions -e ./dist/index.js
```

Then `/login kiro` or `/login devin` as needed. Grok uses the local `grok`
CLI / `~/.grok` auth (or `XAI_API_KEY`).

### Choosing providers (`kiro` is opt-in)

By default this package registers **`devin`** and **`grok`** (+ `grok-sdk`) only.
For Kiro in OMP, the recommended path is the dedicated
[`ns-omp-provider-kiro`](https://www.npmjs.com/package/ns-omp-provider-kiro) plugin;
this package's `kiro` stays off so it never shadows that plugin.

```bash
# opt in to this package's kiro (in the environment that launches omp)
export NS_OMP_PROVIDER_ENABLE=kiro
# or allow-list exactly what you want
export NS_OMP_PROVIDERS=devin,grok,kiro
# deny-list, applied last (e.g. drop grok)
export NS_OMP_PROVIDER_DISABLE=grok
```

Don't opt in to `kiro` while `ns-omp-provider-kiro` is installed — both would
register the same `kiro` provider id. Both run the same `ns-kiro-core`, so the
dedicated plugin loses nothing.

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
   - Pi's `refreshModels({credential, signal, allowNetwork})` is exposed as
     OMP's `fetchDynamicModels(apiKey)`.
   - Pi `$ENV` / `$$` apiKey syntax is translated to OMP's.
   - Unsupported events (`session_info_changed`) are no-ops; OMP's
     `session_switch` / `session_branch` also fire Pi's `session_start`
     handlers (OMP only emits `session_start` once at startup).

`ns-pi-provider` itself is unchanged.

## Known limitations

- **`session_info_changed`** — OMP has no equivalent; the grok handler is a
  documented no-op (name changes do not re-key the agent pool).
- **Duplicate `kiro`** — `kiro` is opt-in; don't enable it alongside `ns-omp-provider-kiro`.
- **Unauthenticated catalogs** — without credentials, OMP may hide a provider's
  models from `omp models` even though the provider is registered. After
  `/login` (or with CLI creds present) the live catalog, including Devin
  `swe-2-*`, appears via `fetchDynamicModels`.
- **Kiro catalog** (when opted in) — models come only from Kiro's `ListAvailableModels`:
  with no Kiro session and no saved catalog snapshot, `kiro` registers zero models.
- **Bundled Pi adapter** — the build bundles the workspace's
  `@ngosangns/ns-pi-provider` (`workspace:*`), so an ns-omp-provider release
  ships whatever the Pi adapter is at that commit; note it in the changelog.

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

Released from the ns-bridge workflow with tag `ns-omp-provider@<version>`; see
[DEVELOPER.md](../../DEVELOPER.md#releasing).
