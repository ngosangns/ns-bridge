// Differential tests for Kiro's one-shot operations: the catalog refresh that
// feeds the disk cache, the usage report and the token refresh, through the
// in-process TypeScript core and the Go sidecar (`ns-bridge call`), against
// one scripted server. Results, errors, requests and the cache file must
// agree. Skipped without Go.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KiroApiError } from "../src/errors.js";
import { KiroManagementHttpError, resetKiroProfileArnCache } from "../src/management.js";
import { getCachedModels, KIRO_MANAGEMENT_CACHE_PATH, updateKiroModelsCache } from "../src/models.js";
import { type KiroCredentials, refreshKiroToken } from "../src/oauth.js";
import { fetchKiroUsage } from "../src/usage.js";
import { buildSidecar, hasGo } from "./helpers/go-sidecar.js";

interface Reply {
  status?: number;
  body: string;
}

let server: Server;
let baseUrl = "";
let routes: Record<string, Reply[]> = {};
let recorded: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
let sidecar: { bin: string; cleanup: () => void } | undefined;
const ENV_KEYS = [
  "KIRO_MANAGEMENT_ENDPOINT",
  "KIRO_DESKTOP_REFRESH_ENDPOINT",
  "KIRO_OIDC_ENDPOINT",
  "NS_BRIDGE_ENGINE_KIRO",
  "NS_BRIDGE_BIN",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const IGNORED = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "accept-language",
  "sec-fetch-mode",
]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  if (!hasGo) return;
  sidecar = buildSidecar();
  // A fake kiro-cli on the test PATH, so both engines read the same rates.
  const fake = join(process.env.HOME ?? "", "kiro-cli");
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = chat ]; then echo '{"models":[{"model_id":"claude-sonnet-4.5","rate_multiplier":1.3,"rate_unit":"credit"},{"model_id":"glm-5","rate_multiplier":0.25}]}'; exit 0; fi\nexit 1\n`,
  );
  chmodSync(fake, 0o755);
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!IGNORED.has(k)) headers[k] = String(v);
    recorded.push({ method: req.method ?? "", url, headers, body });
    const route = Object.keys(routes).find((prefix) => url.includes(prefix));
    const list = route ? routes[route] : undefined;
    const count = recorded.filter((r) => route && r.url.includes(route)).length - 1;
    const reply = list?.[Math.min(count, list.length - 1)] ?? { status: 404, body: "no route" };
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KIRO_MANAGEMENT_ENDPOINT = `${baseUrl}/management/{region}/`;
  process.env.KIRO_DESKTOP_REFRESH_ENDPOINT = `${baseUrl}/desktop/{region}/refreshToken`;
  process.env.KIRO_OIDC_ENDPOINT = `${baseUrl}/oidc/{region}`;
}, 180_000);

afterAll(async () => {
  for (const key of ENV_KEYS)
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  sidecar?.cleanup();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function describeError(error: unknown) {
  if (error instanceof KiroApiError) return { class: "KiroApiError", message: error.message, status: error.status };
  if (error instanceof KiroManagementHttpError)
    return { class: "KiroManagementHttpError", message: error.message, status: error.status };
  return { class: "Error", message: error instanceof Error ? error.message : String(error) };
}

/** Timestamps within a few seconds of now are run-dependent. */
function normalize(value: unknown): unknown {
  const now = Date.now();
  return JSON.parse(JSON.stringify(value ?? null), (key, v) =>
    typeof v === "number" && (key === "expires" || key === "fetchedAt") && Math.abs(v - now) < 3_600_000 * 2
      ? "<now>"
      : v,
  );
}

async function run<T>(engine: "go" | "ts", fn: () => Promise<T>) {
  recorded = [];
  resetKiroProfileArnCache();
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
  process.env.NS_BRIDGE_ENGINE_KIRO = engine;
  if (engine === "go") process.env.NS_BRIDGE_BIN = sidecar?.bin;
  let result: unknown;
  let error: unknown;
  try {
    result = await fn();
  } catch (caught) {
    error = describeError(caught);
  } finally {
    process.env.NS_BRIDGE_ENGINE_KIRO = "ts";
  }
  const cache = existsSync(KIRO_MANAGEMENT_CACHE_PATH)
    ? JSON.parse(readFileSync(KIRO_MANAGEMENT_CACHE_PATH, "utf8"))
    : null;
  const requests = recorded.map((r) => ({ ...r, headers: { ...r.headers, "user-agent": r.headers["user-agent"] } }));
  return normalize({ result, error, cache, requests });
}

async function compare<T>(r: Record<string, Reply[]>, fn: () => Promise<T>) {
  routes = r;
  const ts = await run("ts", fn);
  const go = await run("go", fn);
  expect(go).toEqual(ts);
  return ts as { result: unknown; error?: unknown; cache: unknown };
}

const profiles = {
  body: JSON.stringify({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/P" }] }),
};
const catalog = {
  body: JSON.stringify({
    models: [
      {
        modelId: "claude-sonnet-4.5",
        displayName: "Claude Sonnet 4.5",
        tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
        additionalModelRequestFieldsSchema: {
          type: "object",
          properties: { output_config: { properties: { effort: { enum: ["low", "medium", "high"] } } } },
        },
      },
      { modelId: "glm-5" },
      { modelId: "gpt-5.6-luna", additionalModelRequestFieldsSchema: null },
      { modelId: "minimax-m2.5", displayName: "", tokenLimits: { maxInputTokens: 196000 } },
      { modelId: "fresh-model-1.2" },
    ],
  }),
};

describe.skipIf(!hasGo)("Kiro operations: Go sidecar vs in-process core", { timeout: 60_000 }, () => {
  it("refreshes the catalog into the disk cache", async () => {
    const out = await compare({ "List-Available-Profiles": [profiles], "List-Available-Models": [catalog] }, () =>
      updateKiroModelsCache("tok-1", "us-east-1"),
    );
    expect(out.cache).not.toBeNull();
    expect(getCachedModels("us-east-1").map((m) => m.id)).toContain("fresh-model-1-2");
  });

  it("rejects an invalid catalog", async () => {
    const out = await compare(
      {
        "List-Available-Profiles": [profiles],
        "List-Available-Models": [
          { body: JSON.stringify({ models: [{ modelId: "x", tokenLimits: { maxInputTokens: -1 } }] }) },
        ],
      },
      () => updateKiroModelsCache("tok-1", "us-east-1"),
    );
    expect(out.error).toBeDefined();
  });

  it("surfaces a management rejection", async () => {
    await compare(
      { "List-Available-Profiles": [{ status: 403, body: "{}" }], "List-Available-Models": [catalog] },
      () => updateKiroModelsCache("tok-1", "eu-central-1", undefined),
    );
  });

  it("builds the usage report", async () => {
    const usage = {
      body: JSON.stringify({
        nextDateReset: 1798761600,
        daysUntilReset: 12,
        subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        overageConfiguration: { overageStatus: "ENABLED" },
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            displayName: "Credit",
            displayNamePlural: "Credits",
            currentUsage: 120,
            currentUsageWithPrecision: 120.456,
            currentOverages: 3,
            usageLimit: 1000,
            overageCharges: 1234.5,
            currency: "USD",
            nextDateReset: "2027-01-01T00:00:00Z",
            freeTrialInfo: { currentUsage: 5, usageLimit: 50, freeTrialExpiry: 1800000000 },
          },
          { currentUsage: 0, currentOverages: 0, usageLimit: 10, overageCharges: 0 },
        ],
      }),
    };
    const out = await compare({ "List-Available-Profiles": [profiles], "Get-Usage-Limits": [usage] }, () =>
      fetchKiroUsage({
        access: "tok-2",
        refresh: "r|c|s|idc",
        expires: Date.now() + 3_600_000,
        clientId: "c",
        clientSecret: "s",
        region: "eu-west-2",
        authMethod: "idc",
      }),
    );
    expect(JSON.stringify(out.result)).toContain("$1,234.50");
  });

  const stale = (refresh: string, authMethod: KiroCredentials["authMethod"]): KiroCredentials => ({
    access: "old",
    refresh,
    expires: 0,
    clientId: "",
    clientSecret: "",
    region: "us-east-1",
    authMethod,
    profileArn: "arn:aws:codewhisperer:us-east-1:111111111111:profile/P",
    startUrl: "https://example.awsapps.com/start",
  });

  it("refreshes a desktop token", async () => {
    await compare(
      { "/desktop/": [{ body: JSON.stringify({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 }) }] },
      () => refreshKiroToken(stale("r1|desktop", "desktop")),
    );
  });

  it("refreshes an Identity Center token", async () => {
    await compare(
      { "/oidc/": [{ body: JSON.stringify({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 }) }] },
      () => refreshKiroToken({ ...stale("r1|cid|secret|idc", "idc"), isEnterprise: true }),
    );
  });

  it("refreshes an external IdP token", async () => {
    await compare({ "/idp/token": [{ body: JSON.stringify({ access_token: "new", expires_in: 1800 }) }] }, () =>
      refreshKiroToken(stale(`r1|client 1|${baseUrl}/idp/token|external-idp`, "external-idp")),
    );
  });

  it("reports a refused refresh", async () => {
    const out = await compare({ "/oidc/": [{ status: 400, body: "{}" }] }, () =>
      refreshKiroToken(stale("r1|cid|secret|idc", "idc")),
    );
    expect(out.error).toEqual({ class: "Error", message: "Token refresh failed: 400" });
  });
});
