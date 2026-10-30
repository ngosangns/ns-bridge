# ns-bridge

Kiro, Devin, Grok, Arnict, and Qoder for [Pi](https://pi.dev), [OMP](https://github.com/can1357/oh-my-pi),
and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The published package is [`@ngosangns/ns-bridge`](https://www.npmjs.com/package/@ngosangns/ns-bridge):

```bash
npm install -g @ngosangns/ns-bridge
ns-bridge help
```

`ns-bridge` ships the host extensions prebuilt, registers them with Pi, OMP,
and DSH, and writes model catalogs in its own process. Pi, OMP, and DSH read
those files.

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
qodercli login        # or: QODER_PERSONAL_ACCESS_TOKEN
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

`ARNICT_API_KEY` outranks the file. Every host gets `arnict` from the
extensions `ns-bridge install` registers; a provider without a key registers
nothing. `ns-bridge zcode setup` adds `arnict` on its own when the vendor is
enabled and a key is present.

Models (USD per 1M tokens, input/cached/output, arnict.com/docs/pricing):
`zai/glm-5.3-flash-uncensored` at 0.125/0.05/0.50 and
`zai/glm-5.3-uncensored` at 1.25/0.30/2.25.

## Qoder

Qoder talks straight to Qoder's model server (OpenAI-style SSE) from the host
process — no qodercli daemon, no SDK worker runtime. The bearer token comes
from `qodercli login` (the credential store is decrypted locally with a
vendored wasm) or `QODER_PERSONAL_ACCESS_TOKEN`.

```bash
ns-bridge models refresh qoder
```

The refresh writes `~/.pi/agent/cache/ns-pi-provider/qoder.models.json`, with
the bootstrap catalog (the ids the qoder CLI offers — the server has no list
endpoint). Pi shows the effort ladder as `thinkingLevelMap`; OMP shows it as
per-model effort levels and compacts on the catalog's threshold.

## Pi

```bash
ns-bridge install pi
pi --model kiro/claude-sonnet-4-6
```

Registers `kiro`, `devin`, `grok`, `arnict`, and `qoder`. `/ns-pi refresh`,
`/grok refresh`, and `/qoder status` point at `ns-bridge models refresh`.

## OMP

```bash
ns-bridge install omp
```

Registers `kiro`, `arnict`, and `qoder`. OMP ships `devin`, `xai`, and
`xai-oauth` itself, so ns-bridge does not provide `devin` or `grok` there:
sign in with `/login devin` and `/login xai-oauth` (or `DEVIN_API_KEY` /
`XAI_API_KEY`). Moving from an older install: `ns-bridge install omp` removes
the separate `ns-omp-provider-kiro` plugin. Model ids `devin/…` and `grok/…`
in OMP's `config.yml` resolve to OMP's own `devin` and (for Grok)
`xai-oauth/…` or `xai/…`.

## DeepSeek Harness

```bash
ns-bridge install dsh --profile <profile>
```

The CLI refuses profile `desktop`; the Electron app owns it. The install links
the five provider bundles and writes their blocks into that profile's
`cordis.patch.yml`:

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
    - id: llm-arnict
      name: 'ns-dsh-llm-arnict'
      config:
        provider: arnict
    - id: llm-qoder
      name: 'ns-dsh-llm-qoder'
      config:
        provider: qoder

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
