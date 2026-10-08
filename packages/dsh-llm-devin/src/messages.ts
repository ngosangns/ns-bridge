// ABOUTME: Projects the Harness conversation vocabulary onto the neutral one devin-core reads.
// ABOUTME: The projection is shared by every dsh adapter and lives in ns-bridge-core/dsh.

export {
  type MessageProjectionContext,
  toBridgeMessagesFromDsh as toDevinMessages,
} from "ns-bridge-core/dsh";
