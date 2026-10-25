// ABOUTME: Redaction tests — a non-JSON body, a JSON body, or a request id echoing the
// ABOUTME: API key must never leak the key or its bearer form into the error message.

import { describe, expect, it } from "vitest";
import { arnictApiErrorFromResponse } from "../src/errors.js";

const KEY = "sk-secret123";

describe("arnictApiErrorFromResponse redaction", () => {
  it("redacts the bearer token and the raw key in a non-JSON body", async () => {
    const response = new Response("upstream said: Authorization: Bearer sk-secret123 rejected for key sk-secret123", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const error = await arnictApiErrorFromResponse(response, KEY);
    expect(error.status).toBe(500);
    expect(error.message).not.toContain("sk-secret123");
    expect(error.message).not.toContain("Bearer sk-secret123");
    expect(error.message).toContain("Bearer [redacted]");
    expect(error.message).toContain("key [redacted]");
  });

  it("redacts the key echoed inside a JSON error message", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: `Key ${KEY} is invalid`, type: "auth", code: "invalid_api_key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    const error = await arnictApiErrorFromResponse(response, KEY);
    expect(error.code).toBe("invalid_api_key");
    expect(error.message).not.toContain("sk-secret123");
    expect(error.message).toContain("[redacted]");
  });

  it("redacts the key echoed in the request id header", async () => {
    const response = new Response("bad gateway", {
      status: 502,
      headers: { "content-type": "text/plain", "x-request-id": `req-${KEY}` },
    });
    const error = await arnictApiErrorFromResponse(response, KEY);
    expect(error.message).not.toContain("sk-secret123");
    expect(error.message).toContain("[request id: req-[redacted]]");
  });
});
