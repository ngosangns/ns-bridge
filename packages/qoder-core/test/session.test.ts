import { describe, expect, it } from "vitest";
import { qoderSessionId } from "../src/session.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("qoderSessionId", () => {
  it("keeps a bare UUID", () => {
    expect(qoderSessionId("b9d1c7d4-1111-4abc-9def-0123456789ab")).toBe("b9d1c7d4-1111-4abc-9def-0123456789ab");
  });

  it("takes the UUID a host prefixes with its own label", () => {
    expect(qoderSessionId("session-4adf9210-8254-4c20-ad01-7310b3394f23")).toBe("4adf9210-8254-4c20-ad01-7310b3394f23");
  });

  it("derives a stable UUID for an id that carries none", () => {
    const first = qoderSessionId("plain-host-session");
    expect(first).toMatch(UUID_PATTERN);
    expect(qoderSessionId("plain-host-session")).toBe(first);
    expect(qoderSessionId("another-session")).not.toBe(first);
  });

  it("returns undefined for a missing id", () => {
    expect(qoderSessionId(undefined)).toBeUndefined();
    expect(qoderSessionId("   ")).toBeUndefined();
  });
});
