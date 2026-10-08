# ns-bridge-bin-darwin-x64

The `ns-bridge` Go sidecar binary (`bin/ns-bridge`) for macOS x64.

Do not install this directly: [`ns-bridge-bin`](https://www.npmjs.com/package/ns-bridge-bin)
lists it as an optional dependency, the package manager installs the one
matching the machine, and `binaryPath()` finds it. See
[ns-bridge](https://github.com/ngosangns/ns-bridge) and its
[sidecar protocol](https://github.com/ngosangns/ns-bridge/blob/main/docs/SIDECAR-PROTOCOL.md).

The binary is not in git: `scripts/build-sidecar.mjs` cross-compiles it from
`go/` when the package is packed for release.
