// ABOUTME: Mirrors host tools on an in-process MCP server so the model sees schemas.
// The host executes every call. This process must not run the tool.

import { createSdkMcpServer, tool } from "@qoder-ai/qoder-agent-sdk";
import { type ZodType, z } from "zod";
import type { QoderTool } from "./types.js";

const HOST_SERVER = "ns-bridge-host";

export function hostToolName(raw: string, known: ReadonlySet<string>): string {
  if (known.has(raw)) return raw;
  const prefixed = `mcp__${HOST_SERVER}__`;
  if (raw.startsWith(prefixed) && known.has(raw.slice(prefixed.length))) return raw.slice(prefixed.length);
  const tail = raw.split("__").at(-1) ?? raw;
  return known.has(tail) ? tail : raw;
}

function fieldSchema(prop: Record<string, unknown>): ZodType {
  const type = prop.type;
  let schema: ZodType;
  if (type === "string") schema = z.string();
  else if (type === "integer") schema = z.number().int();
  else if (type === "number") schema = z.number();
  else if (type === "boolean") schema = z.boolean();
  else if (type === "array") schema = z.array(z.unknown());
  else if (type === "object") schema = z.record(z.string(), z.unknown());
  else schema = z.unknown();
  if (typeof prop.description === "string" && prop.description) schema = schema.describe(prop.description);
  return schema;
}

/** Zod raw shape for one host tool. Required fields stay required. */
export function hostToolZodShape(parameters: unknown): Record<string, ZodType> {
  if (!parameters || typeof parameters !== "object") return {};
  const schema = parameters as { properties?: Record<string, unknown>; required?: unknown };
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : [],
  );
  const shape: Record<string, ZodType> = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") continue;
    const field = fieldSchema(prop as Record<string, unknown>);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

export function createHostToolMcpServer(tools: readonly QoderTool[] | undefined) {
  if (!tools?.length) return undefined;
  const defs = tools.map((entry) =>
    tool(
      entry.name,
      entry.description || entry.name,
      hostToolZodShape(entry.parameters),
      async () => ({
        content: [{ type: "text" as const, text: "Deferred to the host. This process does not run the tool." }],
        isError: false,
      }),
      { alwaysLoad: true, exposedName: entry.name, permissionPolicy: "always_ask" },
    ),
  );
  return createSdkMcpServer({ name: HOST_SERVER, version: "1.0.0", tools: defs });
}
