# ns-bridge-bin

Installs the `ns-bridge` Go sidecar binary for the machine it lands on, and
tells you where it is:

```js
import { binaryPath } from "ns-bridge-bin";
binaryPath(); // …/node_modules/ns-bridge-bin-darwin-arm64/bin/ns-bridge
```

The binaries live in one package per target, listed here as optional
dependencies with `os` / `cpu` set, so npm, pnpm and bun install only the one
that matches — no postinstall script, so it works under `--ignore-scripts`:

| Target | Package |
| --- | --- |
| macOS arm64 | `ns-bridge-bin-darwin-arm64` |
| macOS x64 | `ns-bridge-bin-darwin-x64` |
| Linux x64 | `ns-bridge-bin-linux-x64` |
| Linux arm64 | `ns-bridge-bin-linux-arm64` |
| Windows x64 | `ns-bridge-bin-win32-x64` |

All six packages are released together at one version.
[`ns-bridge-core/sidecar`](https://github.com/ngosangns/ns-bridge/tree/main/packages/bridge-core)
finds the binary through this package (after `NS_BRIDGE_BIN`) and runs vendor
calls in it; see the
[sidecar protocol](https://github.com/ngosangns/ns-bridge/blob/main/docs/SIDECAR-PROTOCOL.md).

`binaryPath()` throws, naming the fix, when the target is unsupported or its
package was not installed (optional dependencies omitted).
