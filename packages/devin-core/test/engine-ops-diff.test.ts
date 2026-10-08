// Differential tests for Devin's one-shot operations (model discovery and
// usage): the in-process TypeScript core and the Go sidecar
// (`ns-bridge call`) run against one scripted Connect server; results and
// recorded requests must agree. Skipped without Go.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDevinModels } from "../src/discovery.js";
import {
  BillingStrategy,
  ClientModelConfigSchema,
  DevinPlanInfoSchema,
  DisplayOption,
  GetCliModelConfigsResponseSchema,
  GetUserStatusResponseSchema,
  ModelDimensionKind,
  ModelDimensionSchema,
  ModelFamilyMetadataEntrySchema,
  ModelFamilyMetadataSchema,
  ModelFamilyMetadataValueSchema,
  ModelFeaturesSchema,
  ModelInfoSchema,
  PlanInfoSchema,
  PlanStatusSchema,
  TeamsTier,
  TimestampSchema,
  UserStatusSchema,
} from "../src/proto/devin-messages.js";
import { create, toBinary } from "../src/proto/protobuf.js";
import { fetchDevinUsage } from "../src/usage.js";
import { buildSidecar, hasGo } from "./helpers/go-sidecar.js";

interface Reply {
  status?: number;
  body: Uint8Array | string;
}

let server: Server;
let baseUrl = "";
let routes: Record<string, Reply[]> = {};
let recorded: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
let sidecar: { bin: string; cleanup: () => void } | undefined;
const ENV_KEYS = ["NS_BRIDGE_ENGINE_DEVIN", "NS_BRIDGE_BIN"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const IGNORED = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "accept-language",
  "sec-fetch-mode",
  "user-agent",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  if (!hasGo) return;
  sidecar = buildSidecar();
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!IGNORED.has(k)) headers[k] = String(v);
    recorded.push({ method: req.method ?? "", url, headers, body: body.toString("base64") });
    const route = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    const list = route ? routes[route] : undefined;
    const count = recorded.filter((r) => route && r.url.endsWith(route)).length - 1;
    const reply = list?.[Math.min(count, list.length - 1)] ?? { status: 404, body: "no route" };
    res.writeHead(reply.status ?? 200, { "content-type": "application/proto" });
    res.end(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  for (const key of ENV_KEYS)
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  sidecar?.cleanup();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run<T>(engine: "go" | "ts", fn: () => Promise<T>) {
  recorded = [];
  process.env.NS_BRIDGE_ENGINE_DEVIN = engine;
  if (engine === "go") process.env.NS_BRIDGE_BIN = sidecar?.bin;
  try {
    return { result: await fn(), requests: recorded };
  } finally {
    process.env.NS_BRIDGE_ENGINE_DEVIN = "ts";
  }
}

async function compare<T>(r: Record<string, Reply[]>, fn: () => Promise<T>) {
  routes = r;
  const ts = await run("ts", fn);
  const go = await run("go", fn);
  expect(go).toEqual(ts);
  return ts;
}

const MODELS = "/GetCliModelConfigs";
const STATUS = "/GetUserStatus";

const features = (supportsThinking: boolean, extra: Record<string, unknown> = {}) =>
  create(ModelFeaturesSchema, { supportsThinking, supportsToolCalls: true, ...extra });
const family = (label: string, entries: [string, number, string][], isDefault = false) =>
  create(ModelFamilyMetadataSchema, {
    modelFamilyLabel: label,
    isDefaultModelInFamily: isDefault,
    entries: entries.map(([key, order, name]) =>
      create(ModelFamilyMetadataEntrySchema, { key, value: create(ModelFamilyMetadataValueSchema, { order, name }) }),
    ),
  });
const cost = (label: string, value: number, denominator: string, kind = ModelDimensionKind.COST) =>
  create(ModelDimensionSchema, { label, value, denominator, kind });
const catalog = (configs: Record<string, unknown>[]) =>
  toBinary(
    GetCliModelConfigsResponseSchema,
    create(GetCliModelConfigsResponseSchema, {
      clientModelConfigs: configs.map((c) => create(ClientModelConfigSchema, c)),
    }),
  );

const richCatalog = catalog([
  {
    label: "SWE-1.7",
    modelUid: "swe-1-7",
    maxTokens: 400_000,
    isNew: true,
    description: "  Fast agent model ",
    modelInfo: create(ModelInfoSchema, {
      modelFeatures: features(true, { supportsImages: true, supportsParallelToolCalls: true }),
      maxOutputTokens: 128_000,
    }),
    modelDimensions: [
      cost("Input", 0.1, "1M tokens"),
      cost("Cached Input", 0.01, "1M"),
      cost("Output", 2.5, "1k tokens", ModelDimensionKind.COST_FUZZY),
    ],
  },
  { label: "SWE-1.6", modelUid: "swe-1-6", supportsImages: true },
  { label: "Off", modelUid: "off", disabled: true },
  {
    label: "Review",
    modelUid: "review",
    modelInfo: create(ModelInfoSchema, { displayOption: DisplayOption.QUICK_REVIEW }),
  },
  {
    label: "Adaptive",
    modelUid: "adaptive",
    modelInfo: create(ModelInfoSchema, { displayOption: DisplayOption.MODEL_ROUTER }),
  },
  {
    label: "Fusion",
    modelUid: "fusion-swe-1-7-fast-sidekick-gpt",
    isBeta: true,
    modelInfo: create(ModelInfoSchema, { isModelRouter: true, harnessUids: ["h1"] }),
    modelDimensions: [cost("Input", 9, "1M"), cost("Sidekick", 0, ""), cost("Output", 9, "1M")],
  },
  { label: "Orphan fusion", modelUid: "fusion-ghost-sidekick-gpt" },
  ...["Low", "Medium", "High", "XHigh"].map((effort, i) => ({
    label: `GPT-5.6 Sol ${effort}`,
    modelUid: `gpt-5-6-sol-${effort.toLowerCase()}`,
    isRecommended: i === 1,
    isDefaultModelInFamily: i === 2,
    modelInfo: create(ModelInfoSchema, { modelFeatures: features(true), maxOutputTokens: 100_000 }),
    modelFamilyMetadata: family("GPT-5.6 Sol", [["Reasoning Effort", i, effort]]),
  })),
  {
    label: "GPT-5.6 Sol High Fast",
    modelUid: "gpt-5-6-sol-high-fast",
    modelFamilyMetadata: family("GPT-5.6 Sol", [
      ["Reasoning Effort", 2, "High"],
      ["Fast Mode", 1, "On"],
    ]),
  },
  {
    label: "Claude Opus",
    modelUid: "claude-opus",
    modelFamilyMetadata: family("Claude Opus", [
      ["Effort", 2, "High"],
      ["Thinking", 0, "Off"],
    ]),
  },
  {
    label: "Claude Opus Thinking",
    modelUid: "claude-opus-thinking",
    modelFamilyMetadata: family(
      "Claude Opus",
      [
        ["Effort", 2, "High"],
        ["Thinking", 1, "On"],
      ],
      true,
    ),
  },
  {
    label: "Claude Opus 1M",
    modelUid: "claude-opus-1m",
    modelFamilyMetadata: family("Claude Opus", [
      ["Effort", 2, "Max"],
      ["1M Context", 1, "On"],
    ]),
  },
  { label: "Kimi K2 no thinking", modelUid: "Kimi-K2" },
]);

const seedCatalog = catalog([
  { label: "SWE-1.6", modelUid: "swe-1-6" },
  { label: "SWE-1.6 Fast", modelUid: "swe-1-6-fast" },
]);

function status(fields: {
  user?: Record<string, unknown>;
  planStatus?: Record<string, unknown>;
  planInfo?: Record<string, unknown>;
}) {
  return toBinary(
    GetUserStatusResponseSchema,
    create(GetUserStatusResponseSchema, {
      userStatus: create(UserStatusSchema, {
        ...fields.user,
        ...(fields.planStatus ? { planStatus: create(PlanStatusSchema, fields.planStatus) } : {}),
      }),
      ...(fields.planInfo ? { planInfo: create(PlanInfoSchema, fields.planInfo) } : {}),
    }),
  );
}

describe.skipIf(!hasGo)("Devin operations: Go sidecar vs in-process core", { timeout: 60_000 }, () => {
  it("normalizes a rich native catalog", async () => {
    const out = await compare({ [MODELS]: [{ body: richCatalog }] }, () =>
      fetchDevinModels({ apiKey: "tok", baseUrl }),
    );
    expect(out.result?.map((m) => m.id)).toContain("gpt-5-6-sol");
    expect(out.requests).toHaveLength(1);
  });

  it("falls back to the legacy identity for a seed-only roster", async () => {
    const out = await compare({ [MODELS]: [{ body: seedCatalog }, { body: richCatalog }] }, () =>
      fetchDevinModels({ apiKey: "legacy-key", baseUrl: `${baseUrl}/` }),
    );
    expect(out.requests).toHaveLength(2);
  });

  it("keeps the seed when the legacy call fails", async () => {
    await compare({ [MODELS]: [{ body: seedCatalog }, { status: 500, body: "boom" }] }, () =>
      fetchDevinModels({ baseUrl }),
    );
  });

  it("returns null for failed and empty catalogs", async () => {
    const out = await compare({ [MODELS]: [{ status: 401, body: "nope" }, { body: catalog([]) }] }, () =>
      fetchDevinModels({ apiKey: "tok", baseUrl }),
    );
    expect(out.result).toBeNull();
  });

  it("builds the usage report", async () => {
    const body = status({
      user: { email: " a@b.c ", userId: "u-1", teamId: "team-1", teamsTier: TeamsTier.DEVIN_PRO },
      planStatus: {
        planEnd: create(TimestampSchema, { seconds: 1_800_000_000n, nanos: 500_000_000 }),
        availablePromptCredits: 400,
        usedPromptCredits: 100,
        availableFlowCredits: 0,
        usedFlowCredits: 0,
        availableFlexCredits: 50,
        usedFlexCredits: -3,
        dailyQuotaRemainingPercent: 120,
        dailyQuotaResetAtUnix: 1_800_000_100n,
        weeklyQuotaRemainingPercent: 35,
        overageBalanceMicros: 1_250_000n,
      },
      planInfo: {
        monthlyPromptCredits: 500,
        billingStrategy: BillingStrategy.QUOTA,
        teamsTier: TeamsTier.DEVIN_MAX,
        devinInfo: create(DevinPlanInfoSchema, { orgId: " org-9 ", accountDisplayName: "Acme" }),
      },
    });
    const out = await compare({ [STATUS]: [{ body }] }, () => fetchDevinUsage({ apiKey: " tok ", baseUrl }));
    expect(out.result?.limits.length).toBeGreaterThan(0);
  });

  it("hides undated quota windows on credit plans", async () => {
    const body = status({
      user: { email: "", teamsTier: TeamsTier.PRO },
      planStatus: {
        planInfo: create(PlanInfoSchema, { planName: "Teams", hideWeeklyQuota: true, monthlyFlowCredits: 10 }),
      },
    });
    await compare({ [STATUS]: [{ body }] }, () => fetchDevinUsage({ apiKey: "tok", baseUrl }));
  });

  it("retries a raw legacy key after a 401", async () => {
    const body = status({ user: { email: "legacy@x.y" } });
    const out = await compare({ [STATUS]: [{ status: 401, body: "unauthenticated" }, { body }] }, () =>
      fetchDevinUsage({ apiKey: "raw-legacy-key", baseUrl }),
    );
    expect(out.requests).toHaveLength(2);
  });

  it("fails soft", async () => {
    await compare({ [STATUS]: [{ status: 401, body: "x" }] }, () =>
      fetchDevinUsage({ apiKey: "devin-session-token$abc", baseUrl }),
    );
    await compare({ [STATUS]: [{ status: 500, body: "x" }] }, () => fetchDevinUsage({ apiKey: "tok", baseUrl }));
    await compare({ [STATUS]: [{ body: "\u0000garbage" }] }, () => fetchDevinUsage({ apiKey: "tok", baseUrl }));
    await compare({ [STATUS]: [{ body: status({}).subarray(0, 0) }] }, () =>
      fetchDevinUsage({ apiKey: "tok", baseUrl }),
    );
  });
});
