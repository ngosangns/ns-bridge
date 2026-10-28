import { describe, expect, it } from "vitest";
import { hostToolName, hostToolZodShape } from "../src/tools.js";

describe("host tool schema", () => {
  it("keeps required fields and maps a prefixed MCP name back to the host name", () => {
    const shape = hostToolZodShape({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "integer" },
      },
      required: ["path"],
    });
    expect(shape.path.safeParse("a.ts").success).toBe(true);
    expect(shape.path.safeParse(undefined).success).toBe(false);
    expect(shape.limit.safeParse(undefined).success).toBe(true);
    const known = new Set(["read"]);
    expect(hostToolName("mcp__ns-bridge-host__read", known)).toBe("read");
  });
});
