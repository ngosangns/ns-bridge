# Changelog

## 0.1.0

- Initial release: OMP wrapper around `@ngosangns/ns-pi-provider` 0.1.7.
- Bundles the Pi providers with shims for the missing Pi 1.0 transcript helpers
  (`getCurrentSystemPrompt` / `getCurrentTools` / `withoutInitialSystemMessage`)
  and adapts OMP contexts, `fetchDynamicModels`, apiKey syntax, and session events.
- Providers: `kiro`, `devin`, `grok` (+ `grok-sdk` alias). Opt out of `kiro` with
  `NS_OMP_PROVIDER_DISABLE=kiro` when `ns-omp-provider-kiro` is already installed.
