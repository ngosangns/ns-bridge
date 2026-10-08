// ns-bridge-core/sidecar: run a vendor call in the ns-bridge Go binary.
// The events it yields feed `streamToPi` (./pi) and `streamToDsh` (./dsh)
// exactly as an in-process vendor core's would.

export { DEFAULT_SIDECAR_COMMAND, NS_BRIDGE_BIN_ENV, resolveSidecarBinary } from "./binary.js";
export {
  isSidecarError,
  SidecarError,
  type SidecarErrorDetails,
  type SidecarErrorKind,
  type SidecarErrorPayload,
} from "./errors.js";
export { SIDECAR_PROTOCOL_VERSION, type SidecarStreamOptions, sidecarStream } from "./stream.js";
