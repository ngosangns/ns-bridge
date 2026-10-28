# @ngosangns/ns-pi-provider

> Development of this package has stopped. The maintained package is [@ngosangns/ns-bridge](https://www.npmjs.com/package/@ngosangns/ns-bridge).

Unified [Pi](https://pi.dev) coding-agent providers for **Kiro**, **Devin**, and **Grok**.

- Provider ids: `kiro`, `devin`, `grok`
- Auth: the vendor CLI's session (kiro-cli / Kiro IDE, `devin auth`, `grok`), plus API keys
- Streaming + reasoning/thinking where supported
- Model catalogs are files on disk. `ns-bridge models refresh` writes them. This package reads them.
- Commands: `/ns-pi status`, `/ns-pi refresh` (points at the CLI), `/grok status|models|refresh`, `/devin-status`

## Install in Pi

```bash
# maintained installer (installs this package's last npm release)
ns-bridge install pi

# the same host command, last published version
pi install npm:@ngosangns/ns-pi-provider

# local path (a clone of ns-bridge, after `pnpm install && pnpm -r build`)
pi install /path/to/ns-bridge/packages/pi-provider

# one-shot
pi -e npm:@ngosangns/ns-pi-provider
```

Then `/login kiro` (picks up the `kiro-cli login` / Kiro IDE session, or takes a
`ksk_` API key) or `/login devin` (browser PKCE, same as `devin auth login`) as
needed — an existing CLI session is used without any `/login`. Grok uses the local `grok` CLI / `~/.grok` auth (or `XAI_API_KEY`).

## Architecture

This package is the Pi host adapter of [ns-bridge](https://github.com/ngosangns/ns-bridge).
Kiro and Devin are thin registrations over the shared vendor cores; the
Pi-specific translation (context in, `AssistantMessageEventStream` out) is
`ns-bridge-core/pi`, the same bridge `ns-omp-provider-kiro` uses.

| Provider | Protocol + auth | Model list | Stream |
|----------|-----------------|------------|--------|
| **kiro** | [`ns-kiro-core`](../kiro-core): kiro-cli / Kiro IDE session, `KIRO_API_KEY` | `~/.ns-kiro-provider-models-cache.json` | AWS event-stream, via `ns-bridge-core/pi` |
| **devin** | [`ns-devin-core`](../devin-core): `/login devin` (PKCE), `credentials.toml`, env | `ns-devin-provider/models.json` under `$XDG_DATA_HOME` or `~/.local/share` | Connect/protobuf with capacity retry, via `ns-bridge-core/pi` |
| **grok** | [`ns-grok-core`](../grok-core): Grok CLI login in `~/.grok/auth.json` | `~/.pi/agent/cache/ns-pi-provider/grok.models.json` | Responses API over SSE, via `ns-bridge-core/pi`. The host runs the tools |

Grok does not spawn the CLI to answer. `grok models` runs only when
`ns-bridge models refresh grok` rewrites the catalog file.

Shared modules under `src/shared/` provide HTTP helpers, credential env resolution, and `CatalogCache` (TTL + optional ETag, in-memory + `~/.pi/agent/cache/ns-pi-provider`).

Subpath exports (tree-shakeable):

```ts
import { registerKiroProvider } from "@ngosangns/ns-pi-provider/kiro";
import { registerDevinProvider } from "@ngosangns/ns-pi-provider/devin";
import { registerGrokProvider } from "@ngosangns/ns-pi-provider/grok";
```

## Development

From the ns-bridge root:

```bash
pnpm install && pnpm -r build
pnpm vitest run --project pi            # hermetic tests
pnpm --filter @ngosangns/ns-pi-provider typecheck
NS_PI_LIVE=1 pnpm --filter @ngosangns/ns-pi-provider test:live   # live smoke when creds present
pi --no-extensions -e ./packages/pi-provider/index.ts --list-models
```

## Publish

The last npm release is `0.5.3`. npm marks it deprecated. This repo publishes
[`@ngosangns/ns-bridge`](https://www.npmjs.com/package/@ngosangns/ns-bridge)
from tag `ns-bridge@<version>`. See [DEVELOPER.md](../../DEVELOPER.md#releasing).

## Attribution

See [NOTICE](./NOTICE) for upstream MIT projects this package adapts (pi-kiro-provider, pi-kiro-api, pi-devin-provider, pi-grok-sdk, and Pi docs/examples).

## License

MIT
