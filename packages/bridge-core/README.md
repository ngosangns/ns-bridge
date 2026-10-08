# ns-bridge-core

The host-neutral half of [ns-bridge](https://github.com/ngosangns/ns-bridge): the
vocabulary every vendor core speaks, and one bridge per host family that turns
that vocabulary into the host's own types. A dependency of the ns-bridge
adapters — not meant to be installed on its own.

## The vocabulary (`ns-bridge-core`)

`BridgeMessage`, `BridgeTool`, `BridgeContext`, `BridgeStreamEvent`,
`BridgeUsage`, `BridgeEffort`, `BridgeStopReason`. `ns-kiro-core` and
`ns-devin-core` emit this shape structurally — their own request and event
types are assignable to it — so a vendor core does not depend on this package,
and this package does not depend on a vendor core.

## Pi-family bridge (`ns-bridge-core/pi`)

For hosts built on Pi's provider API: Pi itself and OMP. Typed against
structural `*Like` shapes, so it serves both `@earendil-works/pi-ai` and
`@oh-my-pi/pi-ai` without importing either.

| Export | Does |
| --- | --- |
| `toBridgeContext`, `toBridgeMessages`, `toBridgeTools` | Pi context in: system prompt (string or OMP's `string[]`), messages, tools |
| `streamToPi` | Vendor events out, as the host's `AssistantMessageEventStream` |
| `toBridgeEffort`, `toPiThinkingLevelMap`, `toOmpThinking` | Reasoning effort, both directions |
| `getCurrentSystemPrompt`, `getCurrentTools`, `withoutInitialSystemMessage` | Pi 1.0 transcript helpers OMP does not ship |

## Harness bridge (`ns-bridge-core/dsh`)

For the DeepSeek Harness (`@deepseek-ai/dsh-llm`, an optional peer).

| Export | Does |
| --- | --- |
| `toBridgeMessagesFromDsh` | Harness messages in (dsh 0.2 tool-role messages and dsh 0.1 `tool-result` blocks), images through the attachment store |
| `streamToDsh`, `toDshUsage` | Vendor events out, as Harness `StreamChunk`s |

## Adding a vendor or a host

A new vendor is a core that emits `BridgeStreamEvent`s; every host gets it
through the existing bridges. A new host is one bridge here; every vendor gets it
for free. Host adapters stay glue: credentials and the model catalog come from
the vendor core, translation from here.
