# ns-omp-provider

[OMP](https://omp.sh) (oh-my-pi) plugin that exposes the **Kiro**, **Devin**, and
**Grok** providers from [`@ngosangns/ns-pi-provider`](https://github.com/ngosangns/ns-pi-provider).

`ns-pi-provider` targets Pi 1.0. OMP is a Pi fork whose extension API is close
but not identical — this package is the adapter. It does **not** modify
`ns-pi-provider`; the Pi sources are bundled at build time with a small
compat layer.

| Provider | Auth | Notes |
|----------|------|-------|
| `kiro` (**opt-in**) | OAuth (`/login kiro`) + `KIRO_API_KEY` / SSO cache | Off by default — use [`ns-omp-provider-kiro`](https://www.npmjs.com/package/ns-omp-provider-kiro); see below |
| `devin` | OAuth (`/login devin`) + `credentials.toml` / env | Swe-2 catalog when authenticated |
| `grok` (+ `grok-sdk` alias) | Local `grok` CLI / `~/.grok` / `XAI_API_KEY` | Commands: `/grok status \| models \| refresh` |

Shared command: `/ns-pi status | refresh [all\|kiro\|devin\|grok]`.

## Install

```bash
# from npm
omp plugin install ns-omp-provider

# from git
omp plugin install git:github.com/ngosangns/ns-omp-provider

# local link (dev)
omp plugin link ~/Github/ngosangns/ns-omp-provider

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
register the same `kiro` provider id.

## How the wrapper works

1. **Build-time** — esbuild bundles `@ngosangns/ns-pi-provider` into
   `dist/index.js`, rewriting `@earendil-works/pi-ai*` imports onto
   `src/compat/` (OMP's `@oh-my-pi/pi-ai` plus Pi 1.0 transcript helpers that
   OMP does not ship: `getCurrentSystemPrompt`, `getCurrentTools`,
   `withoutInitialSystemMessage`).
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
- **Kiro catalog** (when opted in) — models come only from Kiro's `ListAvailableModels`
  (since ns-pi-provider 0.2.0): with no Kiro credential and no saved catalog
  snapshot, `kiro` registers zero models, and `-1m` long-context variants are
  not offered.
- **Upstream pin** — this release bundles `@ngosangns/ns-pi-provider@0.2.1`.
  Bumping it is a deliberate change (rebuild + retest).

## Development

```bash
npm install
npm test          # hermetic unit + bundle load tests
npm run typecheck
npm run build
npm run smoke     # optional: real `omp models -e dist/index.js` under a temp HOME
```

Requires Node ≥ 20. The smoke script needs `omp` on `PATH` and does not touch
your real `~/.omp`.

## Publish

Push a tag matching `package.json` (e.g. `v0.3.0`) to run
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), which
publishes with **provenance** from a GitHub-hosted runner:

```bash
# bump "version" in package.json first, then
npm run check
git tag v0.3.0 && git push origin v0.3.0
```

Auth, in the order npm tries it:

1. **Trusted publishing (OIDC)**, if a trusted publisher is attached to the
   package. npm only allows that once the package exists:
   ```bash
   npm trust github ns-omp-provider --file publish.yml \
     --repo ngosangns/ns-omp-provider --allow-publish
   ```
2. **`NPM_TOKEN` repository secret** (currently set): a granular npm token with
   package write and "bypass 2FA", passed to npm as `NODE_AUTH_TOKEN`. This
   covers the first publish. After trusted publishing is configured the secret
   can be removed (`gh secret delete NPM_TOKEN --repo ngosangns/ns-omp-provider`).

Manual publish from a logged-in machine still works:
`npm run check && npm publish --access public`.
