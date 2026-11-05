import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { QoderApiError } from "ns-qoder-core";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

describe("toLlmError", () => {
  it("classifies an oversized Qoder prompt as a context overflow", () => {
    const error = new QoderApiError(
      "Qoder prompt is too long for this model's context window (341139 bytes > 262144 bytes)",
    );
    expect(toLlmError(error).code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE);
  });

  it("leaves the model server's generic HTTP 500 as a provider error", () => {
    const error = new QoderApiError('Qoder model server returned HTTP 500: {"error":"internal server error"}');
    expect(toLlmError(error).code).toBe("PROVIDER_ERROR");
  });
});
