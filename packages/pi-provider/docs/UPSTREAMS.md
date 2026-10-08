# Upstream sync points

Code under `src/` is adapted from these MIT projects (see `NOTICE`). When
syncing, diff each upstream from the recorded point and port what fits.

| Area | Upstream | Last synced | Notes |
|------|----------|-------------|-------|
| `src/kiro/` | — | — | **Retired** in the ns-bridge merge: now a thin registration over `ns-kiro-core` (upstream: mikeyobrien/pi-provider-kiro, tracked in the repo-root `.upstream-sync.json`). The former MasuRii/pi-kiro-provider (`35fc171`) and satiyap/pi-kiro-api (`86c8f2d`) adaptations are gone. |
| `src/devin/` | — | — | **Retired** in the ns-bridge merge: now a thin registration over `ns-devin-core` (upstream: oh-my-pi's Devin provider, see packages/devin-core/README.md). The former fadlee/pi-devin-provider (`942613e`) adaptation is gone; its capacity retry lives on as `streamDevinWithCapacityRetry` in the core. |
| `src/grok/` | [ankitchouhan1020/pi-grok-sdk](https://github.com/ankitchouhan1020/pi-grok-sdk) | `45fde95` (post-v0.2.1) | Local: transcript system prompt, ACP agent→client requests, visible tool activity + bridge note (0.2.2). Upstream unchanged as of 2026-10-08. |
| Pi API | [`@earendil-works/pi-ai` / `pi-coding-agent`](https://github.com/earendil-works/pi) | dev `1.0.0`, verified `1.1.0` | No provider-API breaking changes in 1.0.1–1.1.0. |

Patterns only (no vendored code): `grok-pi` (luongnv89/pi-extensions), Pi docs/examples.
Kiro and Devin protocol code is shared across hosts in `packages/kiro-core` and
`packages/devin-core` of this monorepo; sync those upstreams there, not here.
