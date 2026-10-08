# ns-bridge sidecar protocol (v1)

The vendor cores are moving from TypeScript to Go. Pi, OMP and the DeepSeek
Harness load providers as in-process JavaScript modules, so the host adapters
and the host bridges stay TypeScript; only the vendor work (wire protocol,
streaming, retries, credentials, catalog) moves into one Go binary,
`ns-bridge`, which an adapter starts once per model call.

```
host adapter (TS) ──► ns-bridge-core/sidecar ──spawn──► ns-bridge stream --vendor kiro (Go)
        ▲                    │  stdin:  request envelope (+ host messages, later)
        │                    │  stdout: BridgeStreamEvent NDJSON … done | error
        └── streamToPi / streamToDsh (unchanged) ◄──┘
```

The seam is the one the in-process cores already use: an
`AsyncIterable<BridgeStreamEvent>` (`packages/bridge-core/src/types.ts`). An
adapter swaps `streamKiro(req)` for `sidecarStream("kiro", req, { signal })`
and nothing downstream changes.

Code: `go/internal/bridge` (vocabulary, envelope, writer), `go/internal/sidecar`
(one call's lifecycle), `go/cmd/ns-bridge` (CLI), and
`packages/bridge-core/src/sidecar` (the TypeScript client).

## Invocation

```
ns-bridge stream --vendor <id>
```

| Command | Does |
| --- | --- |
| `ns-bridge stream --vendor <id>` | One model call (below) |
| `ns-bridge vendors` | Vendor ids this binary serves, one per line |
| `ns-bridge version` | `ns-bridge <version> (protocol <n>)` |

Vendors in v1: `echo` only — a test vendor with no network (see
[echo](#the-echo-vendor)). `kiro` and `devin` arrive with M2/M3.

The client finds the binary via `NS_BRIDGE_BIN`, then an explicit path from the
adapter, then the one `ns-bridge-bin` installed for this machine (from its
`ns-bridge-bin-<os>-<cpu>` optional dependency), then `ns-bridge` on `PATH`.
Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64 (pure Go,
CGO off). `ns-bridge version` reports the npm version it shipped in.

## stdin: the request envelope

The host writes **one JSON value followed by a newline**:

```json
{"protocol":1,"request":{ … vendor request … }}
```

- `protocol` must equal the binary's protocol version, otherwise the call ends
  with an `unsupported` error. Bump it on any incompatible change to this
  document.
- `request` is vendor-specific. Every vendor request embeds the neutral
  `BridgeContext` (`systemPrompt`, `messages`, `tools`); the vendor adds its
  own fields (model, effort, credentials, session id, …).

**stdin then stays open for the whole call.** Closing it is the host's cancel
signal (see [Cancellation](#cancellation)). Bytes after the envelope are
reserved for host→sidecar messages (see [Login](#future-login-and-other-host-callbacks));
v1 binaries read and discard them.

For a request piped in by hand, pass `--ignore-stdin-eof`, otherwise the end
of the pipe cancels the call immediately:

```bash
echo '{"protocol":1,"request":{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}}' \
  | ns-bridge stream --vendor echo --ignore-stdin-eof
```

## stdout: NDJSON events

One JSON object per line, flushed per line. Every line but a terminal error is
a `BridgeStreamEvent`, field for field as in
`packages/bridge-core/src/types.ts`:

```json
{"type":"start"}
{"type":"text_start","index":0}
{"type":"text_delta","index":0,"delta":"echo: "}
{"type":"text_end","index":0,"text":"echo: hi"}
{"type":"tool_call_start","index":1,"id":"c1","name":"read"}
{"type":"tool_call_delta","index":1,"id":"c1","argumentsDelta":"{\"path\":\"a.ts\"}"}
{"type":"tool_call_end","index":1,"id":"c1","name":"read","arguments":{"path":"a.ts"},"argumentsJson":"{\"path\":\"a.ts\"}"}
{"type":"usage","usage":{"input":2,"output":4,"totalTokens":6,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}
{"type":"done","stopReason":"toolUse"}
```

Rules, unchanged from the in-process cores:

- Block indexes are allocated monotonically and never reused, including across
  an internal retry. A `{"type":"reset"}` tells a host that can discard
  already-delivered blocks to do so.
- `text_end` / `thinking_end` / `tool_call_end` carry the final content and win
  over the accumulated deltas.
- Tool-call `arguments` is always a JSON object. `argumentsJson`, when present,
  is the model's raw text, byte for byte (Go keeps it as `json.RawMessage`, so
  number formatting and key order survive).
- Usage counters a vendor does not report are **absent**, not `0`.
- A successful call ends with exactly one `done` line, and the process exits 0.
  Nothing follows `done`.

A client ignores event types it does not know (a newer binary may add some).

## Terminal error

A failed call ends with one line instead of `done`, and the process exits 1:

```json
{"type":"error","error":{"kind":"rate_limit","message":"Too many requests","vendor":"kiro","status":429,"retryAfterMs":1500,"reasonCode":"THROTTLING"}}
```

| Field | |
| --- | --- |
| `kind` | Routing class, below |
| `message` | Human-readable, credentials already redacted |
| `vendor` | The `--vendor` id |
| `status` | Upstream HTTP status, when there was one |
| `retryAfterMs` | Back-off the vendor asked for |
| `reasonCode` | The vendor's own code (`KIRO_REASON_CODES`, a Connect code, …) |

| `kind` | Meaning |
| --- | --- |
| `invalid_request` | The envelope or request is malformed |
| `unsupported` | Protocol version or vendor this binary does not speak |
| `auth` | No session, or the vendor rejected it — re-login |
| `rate_limit` | Throttled — honour `retryAfterMs` |
| `capacity` | The vendor is out of capacity for this model |
| `context_overflow` | Input too large — compact and retry |
| `network` | Transport failure |
| `timeout` | A deadline or stall timeout fired |
| `aborted` | The host cancelled (stdin closed, SIGTERM) |
| `protocol` | The vendor answered something the core cannot read |
| `vendor` | Any other vendor-reported failure |
| `internal` | A bug in the binary |

Events written before the error stay valid: a host has usually rendered them
already, and the error explains why the turn stopped short.

The TypeScript client raises the line as a `SidecarError` carrying every field,
and adds two kinds of its own for failures the binary cannot report:
`unavailable` (could not start the binary) and `crashed` (the process exited
non-zero, or was killed, without a terminal line; the last 8 KiB of stderr ride
along). A clean exit without `done`, or a line that is not JSON, is a
client-side `protocol` error. Host adapters map `SidecarError.kind` to their
own error types (`LlmError` codes in the dsh adapters, Pi `error` events).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The call ended with `done` |
| 1 | The call ended with a terminal error line |
| 2 | Command-line usage error (nothing on stdout) |
| other | Crash — the client reports `crashed` |

## stderr

Free-form diagnostics (debug logs when a vendor's debug switch is on). Never
parsed, never required to be empty; the client keeps the tail for `crashed`
errors only.

## Cancellation

The host cancels in three steps, each after a grace period (2 s by default):

1. **Close stdin.** The binary cancels the call's context, writes a terminal
   `aborted` error (which the host is free to ignore) and exits 1.
2. **SIGTERM**, if it is still running. Handled the same way.
3. **SIGKILL**, if it is still running.

`sidecarStream` runs these steps when the `AbortSignal` fires (and then rejects
with the signal's reason, an `AbortError` by default) and when the consumer
stops iterating early. A host process that dies closes the pipe, so an orphaned
binary also cancels itself.

## Future: login and other host callbacks

Interactive login (Devin PKCE, the Pi/OMP `oauth.login(callbacks)` hooks) needs
the binary to ask the host for things mid-call: open a URL, prompt for a code,
report progress. Planned for M4, as JSON-RPC 2.0 framed one message per line
on the same pipes:

- binary → host: a stdout line with `"jsonrpc":"2.0"` and a `method`
  (`host/openUrl`, `host/prompt`, `host/progress`) — told apart from events by
  having `jsonrpc` instead of `type`;
- host → binary: the response on a stdin line after the envelope.

Commands will be `ns-bridge login --vendor <id>`, `ns-bridge models --vendor
<id>` and `ns-bridge usage --vendor <id>`. A v1 client never sees these lines;
adding them bumps the protocol version only if a v1 client could receive one.

## The echo vendor

`--vendor echo` calls nothing. It answers `echo: <last user message text>`,
word by word, then usage and `done`. Knobs under `request.echo`, for tests:

| Field | Effect |
| --- | --- |
| `text` | Reply with this instead |
| `thinking`, `thinkingSignature` | Stream a thinking block first |
| `toolCall: {id?, name, arguments?}` | Stream a tool call after the text; `done` is `toolUse` |
| `delayMs` | Sleep between events (cancellable) |
| `error: {kind, message, status?, retryAfterMs?, reasonCode?}` | End with this terminal error after the text |
| `hang` | Emit `start`, then wait for cancellation |
| `responseId` | Reported on `done` |

`packages/bridge-core/test/sidecar.test.ts` drives it through `sidecarStream`,
`streamToPi` and `streamToDsh`.
