# @ngosangns/ns-pi-provider

Unified [Pi](https://pi.dev) coding-agent providers for **Kiro**, **Devin**, and **Grok**.

- Provider ids: `kiro`, `devin`, `grok`
- Auth: the vendor CLI's session (kiro-cli / Kiro IDE, `devin auth`, `grok`), plus API keys
- Streaming + reasoning/thinking where supported
- **Auto-updating model catalogs** with disk TTL cache (and ETag/version when available)
- Commands: `/ns-pi refresh [all|kiro|devin|grok]`, `/ns-pi status`, plus `/grok`, `/devin-status`

## Install in Pi

```bash
# from npm (after publish)
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

| Provider | Protocol + auth | Model refresh | Stream |
|----------|-----------------|---------------|--------|
| **kiro** | [`ns-kiro-core`](../kiro-core): kiro-cli / Kiro IDE session, `KIRO_API_KEY` | `ListAvailableModels` → catalog cache | AWS event-stream, via `ns-bridge-core/pi` |
| **devin** | [`ns-devin-core`](../devin-core): `/login devin` (PKCE), `credentials.toml`, env | `GetCliModelConfigs` → catalog cache | Connect/protobuf with capacity retry, via `ns-bridge-core/pi` |
| **grok** | in this package: Grok CLI / `~/.grok/auth.json` / `XAI_API_KEY` | `grok models` CLI → catalog cache | ACP or JSONL via local CLI |

### Grok tool activity

Grok runs as its own coding agent (the local `grok agent stdio` ACP process): it reads,
edits, writes and runs commands itself with its built-in tools — Pi/OMP never execute
them. Each of those tools is shown as one line in the reply (`` - Edit `src/a.ts` (+3 −1) ``,
`` - Run `npm test` ``, failures as `✗ … failed`), so edits are visible. Set
`PI_GROK_SDK_SHOW_TOOLS=0` to hide them. Cold-start prompts also carry a short bridge
note telling Grok that the host's tool names are not callable and to act with its own
tools (`PI_GROK_SDK_BRIDGE_NOTE=0` to drop it).

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

Released from the ns-bridge workflow with tag `ns-pi-provider@<version>`; see
[DEVELOPER.md](../../DEVELOPER.md#releasing).

## Attribution

See [NOTICE](./NOTICE) for upstream MIT projects this package adapts (pi-kiro-provider, pi-kiro-api, pi-devin-provider, pi-grok-sdk, and Pi docs/examples).

## License

MIT
