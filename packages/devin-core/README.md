# ns-devin-core

Shared host-neutral core for Devin (Cognition Cascade): the Connect/protobuf
wire protocol, PKCE + API-key credentials, model discovery, and the
`DevinStreamEvent` streaming vocabulary. The Devin vendor core of
[ns-bridge](https://github.com/ngosangns/ns-bridge): a dependency of the Devin
host adapters (`@ngosangns/ns-pi-provider`, `ns-omp-provider`,
`ns-dsh-llm-devin`) — not meant to be installed or configured directly.


## Engine

Since 0.3.0 the public entry points (`streamDevin`, `fetchDevinModels`, `fetchDevinUsage`) run in the
[`ns-bridge`](https://github.com/ngosangns/ns-bridge/tree/main/go) Go sidecar
when a binary is installed ([`ns-bridge-bin`](https://www.npmjs.com/package/ns-bridge-bin),
`NS_BRIDGE_BIN`, or `ns-bridge` on `PATH`), and in this package's TypeScript
otherwise. `NS_BRIDGE_ENGINE=ts` (or `NS_BRIDGE_ENGINE_DEVIN=ts`) keeps
everything in-process; `…InProcess` exports always do. The credential store and model cache stay in TypeScript.

The TypeScript implementation is now the fallback. A later major release is
expected to slim this package to the facade, types and credential stores, with
the protocol living in the binary only; nothing changes for callers of the
exports above.

## What it does

- `streamDevin(request)` — one Cascade turn: `GetUserJwt` (session → user JWT +
  optional edge URL), `AssignModel` for router models, then `GetChatMessage`
  over Connect server-streaming framed protobuf (`application/connect+proto`,
  gzip envelopes, end-of-stream JSON trailers).
- `fetchDevinModels()` — `GetCliModelConfigs` under the pinned CLI identity,
  normalized onto `DevinModelSpec` with effort-lane collapse (`effortMap`).
- `resolveDevinCredentials()` / `saveDevinCredentials()` — the CLI credential
  store at `~/.local/share/devin/credentials.toml`, shared with `devin auth`.
- `loginDevinWithPkce()` — the CLI's browser PKCE flow against app.devin.ai.
- `fetchDevinUsage()` — plan tier, credit buckets, and daily/weekly quota
  windows from `SeatManagementService/GetUserStatus`.
- `streamDevinWithCapacityRetry(request, options)` — `streamDevin` plus a
  bounded retry on capacity/overload errors raised before any output was
  delivered. For hosts with no retry loop of their own (Pi, OMP); the Harness
  has one and calls `streamDevin` directly.
- A hand-rolled protobuf runtime (`proto/protobuf.ts`) plus the vendored
  Cascade message surface (`proto/devin-messages.ts`).

## Upstream

The Cascade client is ported from oh-my-pi's built-in Devin provider
(`@oh-my-pi/pi-ai` `providers/devin.ts`, `@oh-my-pi/pi-catalog`
`discovery/devin.ts` + `wire/devin.ts`, MIT, https://github.com/can1357/oh-my-pi).
Last synced against 18.8.4: Fusion lead routing, the legacy Windsurf
Enterprise catalog fallback, the raw-key retry after a 401, and strict final
tool-argument parsing. Host-specific hooks (`onPayload`) and pure refactors are
not carried over.
