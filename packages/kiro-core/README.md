# ns-kiro-core

The Kiro (AWS CodeWhisperer/Q) protocol, with no host types in it.

This package is the Kiro vendor core of
[ns-bridge](https://github.com/ngosangns/ns-bridge): everything a Kiro client
needs that is not specific to one coding agent.

Published on npm as `ns-kiro-core`. Pulled in as a dependency by the Kiro host
adapters — `@ngosangns/ns-pi-provider`, `ns-omp-provider-kiro`,
`ns-dsh-llm-kiro` — not meant to be installed on its own.

- **Endpoints** — SSO region to management/runtime host resolution.
- **Model catalog** — the bootstrap list, the authenticated regional catalog,
  and a validated on-disk cache at `~/.ns-kiro-provider-models-cache.json`.
  Per-model billing weights (`rateMultiplier`) come from kiro-cli, the only
  source that publishes them.
- **Usage** — Kiro reports no token counts, only a billed amount, surfaced as
  `usage.credits`. `usage.input` is derived from the context-usage frame and
  `usage.output` from a tiktoken estimate.
- **Credentials** — reads the kiro-cli SQLite store and the Kiro IDE token file,
  refreshes IDC / desktop / external-IdP / API-key sessions, and writes
  refreshes back so kiro-cli stays on the same token. Both stores can be signed
  into *different* IdC users of the same Kiro profile, so the kiro-cli session is
  used and refreshed first, and the IDE's only when kiro-cli holds nothing;
  `KIRO_AUTH_SOURCE=ide` reverses that for a machine whose IDE login is the one
  to use.
- **Streaming** — AWS event-stream framing, thinking-tag parsing, native and
  text-dialect tool-call recovery, history validation and repair, and the whole
  retry ladder (transport timeouts, capacity pressure, request-rate windows, 403
  credential rotation, degenerate 200s) — in the Go vendor; this package keeps
  the facade that carries process state across each sidecar call.

## Engine

The public entry points (`streamKiro`, `updateKiroModelsCache`, `fetchKiroUsage`,
`refreshKiroToken`, `loginKiroWithApiKey`) run in the
[`ns-bridge`](https://github.com/ngosangns/ns-bridge/tree/main/go) Go sidecar —
the TypeScript engine was removed, so the
[`ns-bridge-bin`](https://www.npmjs.com/package/ns-bridge-bin) binary is
required (`NS_BRIDGE_BIN` or `ns-bridge` on `PATH` also work). Per-process
state stays in this package: the local credential stores and their selection
(`KIRO_AUTH_SOURCE`), the profile-ARN and region caches, the cache-read
estimate, and catalog refresh scheduling, each carried across every call.

## The neutral seam

`streamKiro` takes a request built from this package's own vocabulary and yields
its own events:

```ts
import { streamKiro, resolveKiroCredentials, getCachedModels } from "ns-kiro-core";

const credentials = await resolveKiroCredentials();
const model = getCachedModels("us-east-1").find((m) => m.id === "claude-sonnet-4-6");

for await (const event of streamKiro({
  model: { ...model, region: "us-east-1" },
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  accessToken: credentials.access,
  effort: "medium",
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

An adapter owes two translations — host messages in, host stream events out —
and nothing else; for Pi-family hosts and the Harness, `ns-bridge-core` already
does both. `loginKiroFromSession` / `resolveKiroRequestCredentials` (session
login and per-request credentials) and `toKiroModelForHost` (catalog entry to a
host model) are the other pieces every host needs, so they live here too. Block indexes are monotonic across the whole response,
including across an internal retry, so a host that cannot un-deliver a block
still receives a coherent sequence; `canDiscardEmittedBlocks` tells the core
which kind of host it is talking to.

## The stages underneath

The wire stages (request building, event-stream framing, response assembly,
retries) live in `go/internal/vendors/kiro`. What this package still owns is
the seam and the per-process state:

| Export | Does |
| --- | --- |
| `streamKiro` / `streamKiroOnEngine` | The facade: pre-resolve the model id and profile, run `ns-bridge stream --vendor kiro`, fold `kiroProfileArns` / `kiroRuntimeRegion` back, apply the cache-read estimate |
| `resolveKiroCredentials` / `refreshKiroToken` | Pick the local store (kiro-cli or Kiro IDE), hand the network half to the `refreshToken` op, write refreshes back |
| `getKiroCliCredentials` / `getKiroIdeCredentials` | Read the kiro-cli SQLite store / the IDE token file |
| `updateKiroModelsCache` / `getCachedModels` | Refresh the authenticated catalog (the Go `refreshModels` op writes the cache) and read it synchronously |
| `applyCacheEstimate` | Cross-turn cache-read estimation on the facade side |

## What Kiro reports, and what it does not

Measured 2026-09-06 against `claude-sonnet-5` in `us-east-1`. Recorded here so
the questions are not re-opened from first principles.

**Token counts: none.** Kiro's `usage` frame is a billing record —
`{unit: "credit", usage: 0.0659}` — not token counts. `usage.input` is therefore
derived from the `contextUsagePercentage` frame, and `usage.output` from a
tiktoken estimate over what the model emitted. `usage.credits` carries the
figure Kiro actually bills.

**Per-token prices: none.** Kiro bills in credits and publishes no per-token
rates, so every model's `cost` stays zero. `kiro-cli chat --list-models` does
publish a relative billing weight, which the catalog picks up as
`rateMultiplier` — 2.2 for `claude-opus-5` against 0.05 for `qwen3-coder-next`.
It is absent when kiro-cli is not installed.

**Prompt caching: real, but not controllable.** Kiro caches prompts server-side
on its own: a repeated prefix billed ~0.035 credits against ~0.066 for a fresh
one, and a changed prefix went straight back to the full price. There is no way
to ask for it — every model's `additionalModelRequestFieldsSchema` sets
`"additionalProperties": false` and allows only `thinking`/`output_config`/
`max_tokens` (Claude) or `reasoning` (GPT), so a `cachePoint` or `cache_control`
field is rejected rather than honoured. Kiro also reports no cache token counts.

Reasoning effort is part of the cache key: changing it misses even when the
prompt is byte-identical, and each effort level then warms its own entry.

**Stop reasons: reported when Kiro sends one, inferred otherwise.** Kiro now
closes a turn with a `metadataEvent` `stopReason` (`END_TURN` on every ordinary
turn checked, 2026-10-08). `MAX_TOKENS` is reported as `length`;
`CONTENT_FILTERED`, `MODEL_CONTEXT_WINDOW_EXCEEDED` (phrased
`context_length_exceeded`) and `PAUSE_TURN` end the call with an error and no
retry. Without a stop reason, a turn with no tool call that never carried a
`contextUsagePercentage` frame is reported as `length`. That frame arrived in
every case checked — a short reply, a ~5000-character one, a tool-call turn, a
model with no effort schema, and a non-Claude model — so its absence does mark
an abnormal turn rather than a normal short answer.

Set `KIRO_DEBUG=1` to log the frames verbatim (`~/.ns-kiro-provider/logs/`) if
any of this needs re-checking against a newer Kiro.

## Credit

Ported from [pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro)
by Mike O'Brien (MIT). The port replaces pi-ai's message and event types with
the neutral vocabulary above; the protocol behaviour is upstream's.
