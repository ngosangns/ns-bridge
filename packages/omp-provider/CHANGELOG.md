# Changelog

## 0.4.0

Bundles `@ngosangns/ns-pi-provider@0.3.0`.

Moved into the [ns-bridge](https://github.com/ngosangns/ns-bridge) monorepo; bundles the
workspace `@ngosangns/ns-pi-provider` (see its changelog: Kiro and Devin now run on the
shared `ns-kiro-core` / `ns-devin-core`).

- The opt-in `kiro` now logs in from the kiro-cli / Kiro IDE session, like
  `ns-omp-provider-kiro`.
- Build: the `kiroRootPlugin` esbuild shim is gone — it only existed for the Pi
  adapter's former vendored Kiro code.

## 0.3.1

Bundles `@ngosangns/ns-pi-provider@0.2.2`.

- fix(grok): Grok's own tool activity is now visible in OMP. The Grok agent edits
  files and runs commands inside its own ACP process; those tools were dropped, so
  turns looked like read-only reasoning even when files changed. Each tool now shows
  as a line in the reply (`` - Edit `src/a.ts` (+3 −1) ``, `` - Run `npm test` ``,
  `✗ … failed`). Text only — OMP never re-runs them. `PI_GROK_SDK_SHOW_TOOLS=0` hides.
- fix(grok): cold-start prompts carry a short bridge note so Grok acts with its
  built-in tools instead of describing OMP tool calls (`PI_GROK_SDK_BRIDGE_NOTE=0`
  disables).

## 0.3.0

- **Breaking: `kiro` is now opt-in.** By default only `devin` and `grok` (+ `grok-sdk`)
  are registered, so this package no longer shadows the dedicated
  [`ns-omp-provider-kiro`](https://www.npmjs.com/package/ns-omp-provider-kiro) plugin
  (the recommended Kiro path in OMP). Opt in with `NS_OMP_PROVIDER_ENABLE=kiro` or by
  listing it in `NS_OMP_PROVIDERS` (e.g. `NS_OMP_PROVIDERS=devin,grok,kiro`).
  `NS_OMP_PROVIDER_DISABLE` still works and is applied last; the old
  `NS_OMP_PROVIDER_DISABLE=kiro` workaround is no longer needed.
- Bundles `@ngosangns/ns-pi-provider@0.2.1`: Kiro now honours `metadataEvent` stop
  reasons — `MAX_TOKENS` → `length` (OMP skips truncated tool calls instead of running
  them with partial arguments), `CONTENT_FILTERED` / `MODEL_CONTEXT_WINDOW_EXCEEDED` /
  `PAUSE_TURN` and mid-stream exception frames end as errors, and reported token usage
  is read. Only relevant when `kiro` is opted in.

## 0.2.0

Bundles `@ngosangns/ns-pi-provider@0.2.0` (was 0.1.7).

- **Breaking (kiro):** the Kiro catalog now comes only from `ListAvailableModels`.
  Without a Kiro credential or a saved catalog snapshot the `kiro` provider
  registers with zero models, and derived `-1m` variants (e.g.
  `claude-sonnet-4-6-1m`) are gone. Wire model ids are sent in Kiro's dot form
  (`claude-sonnet-4.5`), fixing `INVALID_MODEL_ID` on discovered models. Users
  with `NS_OMP_PROVIDER_DISABLE=kiro` are unaffected.
- fix(grok): `session_shutdown` disposes only that session's Grok ACP agent
  (upstream pi-grok-sdk `45fde95`); switching or closing one session no longer
  kills other sessions' agents, and one process-exit hook is installed per
  process instead of per registration.
- No compat-shim changes needed: 0.2.0 adds no new `@earendil-works/pi-ai`
  runtime imports.

## 0.1.0

- Initial release: OMP wrapper around `@ngosangns/ns-pi-provider` 0.1.7.
- Bundles the Pi providers with shims for the missing Pi 1.0 transcript helpers
  (`getCurrentSystemPrompt` / `getCurrentTools` / `withoutInitialSystemMessage`)
  and adapts OMP contexts, `fetchDynamicModels`, apiKey syntax, and session events.
- Providers: `kiro`, `devin`, `grok` (+ `grok-sdk` alias). Opt out of `kiro` with
  `NS_OMP_PROVIDER_DISABLE=kiro` when `ns-omp-provider-kiro` is already installed.
