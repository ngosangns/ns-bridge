import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDevinCredentials, saveDevinCredentials } from "../src/credentials.js";
import { getCachedModels, isCacheStale, updateDevinModelsCache } from "../src/models.js";

const dir = join(process.env.HOME ?? "/tmp", "state");
const path = join(dir, "credentials.toml");
const cachePath = join(dir, "models.json");

describe("credentials.toml", () => {
  afterEach(() => {
    delete process.env.DEVIN_CREDENTIALS_PATH;
    delete process.env.NS_DEVIN_MODEL_CACHE;
  });

  it("reads the flat key=value file the CLI writes", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'windsurf_api_key = "tok-123"\napi_server_url = "https://edge.example.com/"\n# comment\n');
    process.env.DEVIN_CREDENTIALS_PATH = path;
    const stored = resolveDevinCredentials();
    expect(stored?.apiKey).toBe("tok-123");
    expect(stored?.apiServerUrl).toBe("https://edge.example.com");
  });

  it("returns undefined when the file is missing or has no token", () => {
    process.env.DEVIN_CREDENTIALS_PATH = join(dir, "absent.toml");
    expect(resolveDevinCredentials()).toBeUndefined();
    writeFileSync(join(dir, "empty.toml"), 'other_key = "x"\n');
    process.env.DEVIN_CREDENTIALS_PATH = join(dir, "empty.toml");
    expect(resolveDevinCredentials()).toBeUndefined();
  });

  it("writes the token back preserving unrelated keys", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'windsurf_api_key = "old"\ncustom_key = "keep"\n');
    process.env.DEVIN_CREDENTIALS_PATH = path;
    saveDevinCredentials("new-tok", { apiServerUrl: "https://edge.example.com" });
    const stored = resolveDevinCredentials();
    expect(stored?.apiKey).toBe("new-tok");
    expect(stored?.apiServerUrl).toBe("https://edge.example.com");
    expect(resolveDevinCredentials()).toBeTruthy();
    expect(readFileSync(path, "utf8")).toContain('custom_key = "keep"');
  });

  it("prefers windsurf_api_key and falls through when that value is blank", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'windsurf_api_key = "wind"\napi_key = "other"\n');
    process.env.DEVIN_CREDENTIALS_PATH = path;
    expect(resolveDevinCredentials()?.apiKey).toBe("wind");

    writeFileSync(path, 'windsurf_api_key = "   "\napi_key = "from-api"\n');
    expect(resolveDevinCredentials()?.apiKey).toBe("from-api");

    writeFileSync(path, 'windsurf_api_key = ""\napi_key = ""\n');
    expect(resolveDevinCredentials()).toBeUndefined();
  });

  it("ignores unquoted values, comments, and table headers", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      ['# windsurf_api_key = "nope"', "[profile]", "windsurf_api_key = bare", 'api_key = "quoted"', ""].join("\n"),
    );
    process.env.DEVIN_CREDENTIALS_PATH = path;
    expect(resolveDevinCredentials()?.apiKey).toBe("quoted");
  });

  it("decodes escaped quotes and backslashes, including a CRLF line", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'windsurf_api_key = "say \\"hi\\" \\\\now"\r\napi_server_url = ""\r\n');
    process.env.DEVIN_CREDENTIALS_PATH = path;
    const stored = resolveDevinCredentials();
    expect(stored?.apiKey).toBe('say "hi" \\now');
    expect(stored?.apiServerUrl).toBeUndefined();
  });

  it("creates a missing file and round-trips quotes inside the token", () => {
    const nested = join(dir, "nested", "missing", "credentials.toml");
    process.env.DEVIN_CREDENTIALS_PATH = nested;
    saveDevinCredentials('tok"with\\slash', {
      apiServerUrl: "https://edge.example.com///",
      devinApiUrl: "   ",
      devinWebappHost: "https://app.example.com/",
    });
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    const stored = resolveDevinCredentials();
    expect(stored?.apiKey).toBe('tok"with\\slash');
    expect(stored?.apiServerUrl).toBe("https://edge.example.com");
    expect(stored?.devinApiUrl).toBeUndefined();
    expect(stored?.devinWebappHost).toBe("https://app.example.com");
    expect(readFileSync(nested, "utf8").match(/windsurf_api_key/g)).toHaveLength(1);

    saveDevinCredentials("second");
    expect(readFileSync(nested, "utf8").match(/windsurf_api_key/g)).toHaveLength(1);
    expect(resolveDevinCredentials()?.apiKey).toBe("second");
  });
});

describe("model cache", () => {
  afterEach(() => {
    delete process.env.NS_DEVIN_MODEL_CACHE;
  });

  it("serves the seed catalog until a fetch lands", () => {
    process.env.NS_DEVIN_MODEL_CACHE = join(dir, "absent.json");
    expect(getCachedModels().map((m) => m.id)).toContain("swe-1-6");
    expect(isCacheStale()).toBe(true);
  });

  it("round-trips a fetched catalog through disk", () => {
    mkdirSync(dir, { recursive: true });
    process.env.NS_DEVIN_MODEL_CACHE = cachePath;
    const fetched = [
      {
        id: "adaptive",
        name: "Adaptive",
        reasoning: true,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
        isModelRouter: true,
      },
    ];
    updateDevinModelsCache(fetched);
    expect(getCachedModels().map((m) => m.id)).toEqual(["adaptive"]);
    expect(isCacheStale()).toBe(false);
  });
});
