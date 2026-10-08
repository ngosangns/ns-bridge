# ns-bridge

Third-party model vendors — **Kiro**, **Devin**, **Grok** — as providers for
three coding-agent hosts: [Pi](https://pi.dev), [OMP](https://github.com/can1357/oh-my-pi)
(oh-my-pi), and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Each vendor's wire protocol is written once, each host's plumbing is written
once, and a host adapter is only the glue between the two:

```
 host adapters     Pi    @ngosangns/ns-pi-provider   kiro · devin · grok ─┐
 (thin glue)       OMP   ns-omp-provider-kiro        kiro                 ├─ via ns-bridge-core/pi
                   OMP   ns-omp-provider             devin · grok, bundles the Pi adapter
                   DSH   ns-dsh-llm-kiro             kiro                 ┐
                   DSH   ns-dsh-llm-devin            devin                ┴─ via ns-bridge-core/dsh
                                │                          │
 vendor cores           ns-kiro-core               ns-devin-core          grok: local grok CLI
 (no host types)        AWS event-stream,          Connect/protobuf,      (ACP), inside the
                        kiro-cli/IDE sessions,     devin auth sessions,   Pi adapter
                        catalog, retry ladder      discovery, quota
                                │                          │
 shared                 ns-bridge-core   neutral vocabulary (messages, tools, stream
                                         events, usage, effort, errors) + host bridges;
                                         the cores fit it structurally, without importing it
```

A protocol fix (a new Kiro stop reason, a Devin trailer, a retry rule) lands in
one vendor core and reaches every host. A host change (a new Pi event, a new
Harness chunk) lands in one bridge and reaches every vendor.

## Packages

| Package | Layer | What it is | npm |
| --- | --- | --- | --- |
| [`ns-bridge-core`](packages/bridge-core) | shared | Neutral vocabulary + the Pi-family and Harness host bridges | [![npm](https://img.shields.io/npm/v/ns-bridge-core)](https://www.npmjs.com/package/ns-bridge-core) |
| [`ns-kiro-core`](packages/kiro-core) | vendor core | The Kiro (AWS CodeWhisperer/Q) protocol | [![npm](https://img.shields.io/npm/v/ns-kiro-core)](https://www.npmjs.com/package/ns-kiro-core) |
| [`ns-devin-core`](packages/devin-core) | vendor core | The Devin (Cognition Cascade) protocol | [![npm](https://img.shields.io/npm/v/ns-devin-core)](https://www.npmjs.com/package/ns-devin-core) |
| [`@ngosangns/ns-pi-provider`](packages/pi-provider) | Pi adapter | `kiro`, `devin`, `grok` for Pi | [![npm](https://img.shields.io/npm/v/@ngosangns/ns-pi-provider)](https://www.npmjs.com/package/@ngosangns/ns-pi-provider) |
| [`ns-omp-provider`](packages/omp-provider) | OMP adapter | `devin`, `grok` (+ opt-in `kiro`) for OMP, wrapping the Pi adapter | [![npm](https://img.shields.io/npm/v/ns-omp-provider)](https://www.npmjs.com/package/ns-omp-provider) |
| [`ns-omp-provider-kiro`](packages/omp-provider-kiro) | OMP adapter | `kiro` for OMP — the recommended Kiro path there | [![npm](https://img.shields.io/npm/v/ns-omp-provider-kiro)](https://www.npmjs.com/package/ns-omp-provider-kiro) |
| [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro) | DSH adapter | `kiro` as a Harness `LlmAdapter` | [![npm](https://img.shields.io/npm/v/ns-dsh-llm-kiro)](https://www.npmjs.com/package/ns-dsh-llm-kiro) |
| [`ns-dsh-llm-devin`](packages/dsh-llm-devin) | DSH adapter | `devin` as a Harness `LlmAdapter` | [![npm](https://img.shields.io/npm/v/ns-dsh-llm-devin)](https://www.npmjs.com/package/ns-dsh-llm-devin) |
| [`ns-bridge-bin`](packages/bridge-bin) (+ `ns-bridge-bin-<os>-<cpu>`) | sidecar | The Go `ns-bridge` binary for vendor calls moving out of TypeScript ([protocol](docs/SIDECAR-PROTOCOL.md)); not used by an adapter yet | [![npm](https://img.shields.io/npm/v/ns-bridge-bin)](https://www.npmjs.com/package/ns-bridge-bin) |

Package names did not change in the merge; existing installs keep working. Each
package keeps its own version.

This repository was assembled from four, with their history:
`ns-kiro-provider` (renamed to this one), `ns-pi-provider`, `ns-omp-provider`
and `ns-devin-provider` (archived, each pointing here).

## Sign in

No package runs a browser flow of its own for Kiro or Devin — each reads the
session the vendor's own CLI leaves on the machine, refreshes it, and writes the
refresh back so the CLI stays on the same token.

```bash
kiro-cli login        # Builder ID, IAM Identity Center, Google, GitHub, enterprise OIDC
devin auth login      # or: /login devin inside Pi / OMP
grok login            # Grok runs through the local grok CLI (or XAI_API_KEY)
```

A Kiro API key (`ksk_…`) and `KIRO_API_KEY` are accepted directly.

## Pi

```bash
pi install npm:@ngosangns/ns-pi-provider
pi --model kiro/claude-sonnet-4-6
```

Registers `kiro`, `devin` and `grok`. See [the package README](packages/pi-provider).

## OMP

```bash
omp plugin install ns-omp-provider-kiro   # kiro
omp plugin install ns-omp-provider        # devin + grok
```

Both register into OMP; only one may own the `kiro` provider id. Kiro belongs to
`ns-omp-provider-kiro`, so `ns-omp-provider` leaves its `kiro` off unless you set
`NS_OMP_PROVIDER_ENABLE=kiro` — don't, while `ns-omp-provider-kiro` is installed.
Both paths now run the same `ns-kiro-core`, so nothing is lost by choosing the
dedicated plugin.

## DeepSeek Harness

```bash
dsh plugin --profile <profile> add ns-dsh-llm-kiro ns-dsh-llm-devin
```

Then in that profile's `cordis.patch.yml`:

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

- id: agent-default-model
  config:
    provider: kiro
    model: claude-sonnet-4-6
```

See [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro) and
[`ns-dsh-llm-devin`](packages/dsh-llm-devin) for options.

## Development

```bash
git clone git@github.com:ngosangns/ns-bridge.git
cd ns-bridge && pnpm install && pnpm -r build && pnpm test
```

See [DEVELOPER.md](DEVELOPER.md) for the layering rules, testing, and how a
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
