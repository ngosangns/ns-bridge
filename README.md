# ns-bridge

Kiro, Devin, Grok, and Arnict for [Pi](https://pi.dev), [OMP](https://github.com/can1357/oh-my-pi),
and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The published package is [`@ngosangns/ns-bridge`](https://www.npmjs.com/package/@ngosangns/ns-bridge):

```bash
npm install -g @ngosangns/ns-bridge
ns-bridge help
```

`ns-bridge` installs the host plugins and writes model catalogs in its own
process. Pi, OMP, and DSH read those files.

```bash
ns-bridge install --dry-run # preview pi + omp; DSH needs --profile
ns-bridge install          # pi + omp; DSH needs --profile
ns-bridge update               # this CLI, from npm
ns-bridge models list
ns-bridge usage                # cache hit and tokens the plugins recorded
ns-bridge providers disable pi grok
ns-bridge models refresh
```

Mutating commands apply by default; pass `--dry-run` to preview them. DSH needs `--profile <name>`.
The `desktop` profile stays with the Electron app. See [packages/cli](packages/cli).

## Sign in

Each host reads the session the vendor's own CLI leaves on the machine,
refreshes it, and writes the refresh back so that CLI stays on the same token.

```bash
kiro-cli login        # Builder ID, IAM Identity Center, Google, GitHub, enterprise OIDC
devin auth login      # or: /login devin inside Pi
grok login            # Grok runs through the local grok CLI (or XAI_API_KEY)
```

A Kiro API key (`ksk_…`) and `KIRO_API_KEY` are accepted directly.

## Arnict

Arnict is an OpenAI-compatible API at `https://api.arnict.com/v1` for open
models, signed in with an API key rather than a vendor CLI:

```bash
ns-bridge arnict login   # reads the key from piped stdin or a hidden prompt,
                         # stores it in ~/.ns-bridge/arnict.json (0600)
ns-bridge arnict status
ns-bridge models refresh arnict
```

`ARNICT_API_KEY` outranks the file. No published install carries `arnict`:
`ns-bridge install pi` installs the last published `@ngosangns/ns-pi-provider`,
which predates it; `ns-bridge install omp` installs `ns-omp-provider-kiro`
only; `ns-dsh-llm-arnict` is not on npm. Build this repo and load the provider
from the checkout: `pi -e ./packages/pi-provider/index.ts` registers `arnict`
beside `kiro`/`devin`/`grok`; `ns-omp-provider` from this repo registers
`arnict` and leaves `kiro` to `ns-omp-provider-kiro` when that plugin is
installed; DSH links the adapter with
`dsh plugin --profile <name> add link:<path>/packages/dsh-llm-arnict`.
`ns-bridge zcode setup` adds `arnict` on its own when the vendor is enabled
and a key is present. A provider without a key registers nothing.

Models (USD per 1M tokens, input/cached/output, arnict.com/docs/pricing):
`zai/glm-5.3-flash-uncensored` at 0.125/0.05/0.50 and
`zai/glm-5.3-uncensored` at 1.25/0.30/2.25.

## Pi

```bash
ns-bridge install pi
pi --model kiro/claude-sonnet-4-6
```

Registers `kiro`, `devin`, and `grok`. `/ns-pi refresh` and `/grok refresh`
point at `ns-bridge models refresh`. The installed `ns-pi-provider`
predates Arnict — see [Arnict](#arnict) for loading it from this repo.

## OMP

```bash
ns-bridge install omp
```

Registers `kiro` only. For `arnict`, see [Arnict](#arnict). OMP ships `devin`, `xai`, and `xai-oauth` itself, so ns-bridge no
longer provides `devin` or `grok` there: sign in with `/login devin` and `/login xai-oauth`
(or `DEVIN_API_KEY` / `XAI_API_KEY`). Moving from the old plugin: replace `devin/…` and
`grok/…` model ids in OMP's `config.yml` with OMP's own (`devin/…` from `omp models devin`,
`xai-oauth/…` or `xai/…` for Grok), then `omp plugin uninstall ns-omp-provider`.

## DeepSeek Harness

```bash
ns-bridge install dsh --profile <profile>
```

The CLI refuses profile `desktop`; the Electron app owns it. Then in that
profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-kiro
      name: 'ns-dsh-llm-kiro'
      config:
        provider: kiro
    - id: llm-devin
      name: 'ns-dsh-llm-devin'
      config:
        provider: devin
    - id: llm-grok
      name: 'ns-dsh-llm-grok'
      config:
        provider: grok

- id: agent-default-model
  config:
    provider: kiro
    model: claude-sonnet-4-6
```

## ZCode

ZCode runs `kiro`, `devin`, and `grok` through a local Anthropic-Messages
server. `ns-bridge serve` is that server, and `ns-bridge zcode` registers its
endpoints (`/<vendor>/v1/messages`, `/<vendor>/v1/models`) as personal
providers in the ZCode app, so its model picker lists them like any other
provider.

```bash
ns-bridge serve                    # http://127.0.0.1:47821/<vendor>/v1/messages
ns-bridge zcode setup              # register the providers + install the launch agent
ns-bridge zcode status
ns-bridge zcode remove             # strips them again; ~/.ns-bridge/zcode.json stays
```

`serve` binds loopback only and reads its port and token from
`~/.ns-bridge/zcode.json`, created on first run (`NS_BRIDGE_ZCODE_CONFIG` moves
the file, `NS_BRIDGE_SERVE_TOKEN` overrides the token). A non-loopback
`--host` needs `--allow-remote`.

`setup` merges the providers into ZCode's personal provider config
(`~/.zcode/v2/provider_config.json`; `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
moves it) from the model catalogs. Only `ns-bridge-*` entries are touched —
other providers pass through — and every write is backed up as
`provider_config.json.bak-ns-bridge-<timestamp>`. Vendors switched off in
`~/.ns-bridge/providers.json` are not registered; `--vendors kiro,devin`
narrows further. `--default <vendor>/<model>` also makes that model ZCode's
default, at reasoning level `high`. Compaction windows follow ns-bridge's
per-model policy, so ZCode compacts where the other hosts do.

**Quit ZCode before `zcode setup` or `zcode remove`** — the app keeps the
provider config in memory and rewrites it on its next save — and restart ZCode
afterwards. `--force` skips that check. On macOS, setup also
installs a launch agent (`dev.ngosangns.ns-bridge.serve`) that keeps `serve`
running; it pins the `ns-bridge` on `PATH`, so install this CLI globally
first, and logs land in `~/.ns-bridge/logs/serve.log`. `--no-service` skips
the agent.

Running ZCode's headless CLI outside the app
(`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs -p …`) also needs
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json`.

Example flow:

```bash
npm install -g @ngosangns/ns-bridge
ns-bridge models refresh
# quit ZCode, then:
ns-bridge zcode setup --default kiro/claude-sonnet-4-6
# restart ZCode and pick an ns-bridge model
```

## Development

```bash
git clone git@github.com:ngosangns/ns-bridge.git
cd ns-bridge && pnpm install && pnpm -r build && pnpm test
```

See [DEVELOPER.md](DEVELOPER.md) for the workspace layout, testing, and how a
release is cut.

## What this is not

Kiro's and Devin's runtime APIs are reverse-engineered and have no public
specification. The vendors can change them without notice, and using them from
a client that is not their own sits outside the supported path — check your own
agreement before relying on it.

## Credit

See [NOTICE](NOTICE). The Kiro protocol is a port of
[pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro) by Mike
O'Brien (MIT); the Devin protocol is ported from
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s built-in Devin provider (MIT).
