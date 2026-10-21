# ns-bridge

Kiro, Devin, and Grok for [Pi](https://pi.dev), [OMP](https://github.com/can1357/oh-my-pi),
and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The published package is [`@ngosangns/ns-bridge`](https://www.npmjs.com/package/@ngosangns/ns-bridge):

```bash
npm install -g @ngosangns/ns-bridge
ns-bridge help
```

`ns-bridge` installs the host plugins and writes model catalogs in its own
process. Pi, OMP, and DSH read those files.

```bash
ns-bridge install          # preview
ns-bridge install --apply  # pi + omp; DSH needs --profile
ns-bridge update --apply       # this CLI, from npm
ns-bridge models list
ns-bridge providers disable omp grok --apply
ns-bridge models refresh --apply
```

Mutating commands preview unless you pass `--apply`. DSH needs `--profile <name>`.
The `desktop` profile stays with the Electron app. See [packages/cli](packages/cli).

## Sign in

Each host reads the session the vendor's own CLI leaves on the machine,
refreshes it, and writes the refresh back so that CLI stays on the same token.

```bash
kiro-cli login        # Builder ID, IAM Identity Center, Google, GitHub, enterprise OIDC
devin auth login      # or: /login devin inside Pi / OMP
grok login            # Grok runs through the local grok CLI (or XAI_API_KEY)
```

A Kiro API key (`ksk_…`) and `KIRO_API_KEY` are accepted directly.

## Pi

```bash
ns-bridge install pi --apply
pi --model kiro/claude-sonnet-4-6
```

Registers `kiro`, `devin`, and `grok`. `/ns-pi refresh` and `/grok refresh`
point at `ns-bridge models refresh --apply`.

## OMP

```bash
ns-bridge install omp --apply
```

Registers `kiro`, `devin`, and `grok`. One plugin owns the `kiro` id.

## DeepSeek Harness

```bash
ns-bridge install dsh --profile <profile> --apply
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
