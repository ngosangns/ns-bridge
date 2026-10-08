// ABOUTME: Projects the Harness conversation vocabulary onto the neutral one kiro-core reads.
// ABOUTME: The projection is shared by every dsh adapter and lives in ns-bridge-core/dsh.

export {
  type MessageProjectionContext,
  toBridgeMessagesFromDsh as toKiroMessages,
} from "ns-bridge-core/dsh";
