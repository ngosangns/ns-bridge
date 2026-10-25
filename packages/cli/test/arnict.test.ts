import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ArnictIo } from "../src/arnict.js";
import { run } from "../src/cli.js";

const KEY = "sk-arnict-totally-secret-4321";
const MASK = "sk-a…4321";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    log: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
  };
}

function tempHome(): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "ns-bridge-arnict-"));
  return { home, path: join(home, ".ns-bridge", "arnict.json") };
}

function savedKey(home: string, apiKey: string): void {
  const path = join(home, ".ns-bridge", "arnict.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ apiKey }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function ioFor(home: string, env: NodeJS.ProcessEnv, overrides: Partial<ArnictIo> = {}): Partial<ArnictIo> {
  return {
    env,
    home,
    stdinIsTTY: false,
    readStdinText: async () => "",
    fetch: async () => {
      throw new Error("the models probe must not run in this test");
    },
    prompt: async () => {
      throw new Error("the prompt must not run in this test");
    },
    ...overrides,
  };
}

describe("ns-bridge arnict", () => {
  it("login --stdin saves the first stdin line trimmed, 0600, and never prints the key", async () => {
    const { home, path } = tempHome();
    const io = capture();
    const code = await run(["arnict", "login", "--stdin"], {
      ...io,
      arnictIo: ioFor(home, {}, { readStdinText: async () => `  ${KEY}  \nignored second line\n` }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ apiKey: KEY });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(io.stdout).toEqual([`Saved Arnict API key ${MASK} to ${path}`]);
    expect(io.stderr).toEqual([]);
    expect([...io.stdout, ...io.stderr].join("\n")).not.toContain(KEY);
  });

  it("login with an empty key fails and saves nothing", async () => {
    const { home, path } = tempHome();
    const io = capture();
    const code = await run(["arnict", "login", "--stdin"], {
      ...io,
      arnictIo: ioFor(home, {}, { readStdinText: async () => "   \n" }),
    });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("no key");
    expect(existsSync(path)).toBe(false);
  });

  it("login prompts hidden on a TTY and aborts when the prompt is cancelled", async () => {
    const { home, path } = tempHome();
    const prompt = vi.fn(async () => KEY);
    const io = capture();
    const code = await run(["arnict", "login"], { ...io, arnictIo: ioFor(home, {}, { stdinIsTTY: true, prompt }) });
    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalledWith("Arnict API key: ");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ apiKey: KEY });
    expect([...io.stdout, ...io.stderr].join("\n")).not.toContain(KEY);

    const cancelled = capture();
    const codeCancelled = await run(["arnict", "login"], {
      ...cancelled,
      arnictIo: ioFor(
        home,
        {},
        {
          stdinIsTTY: true,
          prompt: async () => {
            throw new Error("cancelled");
          },
        },
      ),
    });
    expect(codeCancelled).toBe(1);
    expect(cancelled.stderr.join("\n")).toContain("cancelled");
  });

  it("logout removes the saved file", async () => {
    const { home, path } = tempHome();
    savedKey(home, KEY);
    const io = capture();
    const code = await run(["arnict", "logout"], { ...io, arnictIo: ioFor(home, {}) });
    expect(code).toBe(0);
    expect(io.stdout).toEqual([`Removed ${path}`]);
    expect(existsSync(path)).toBe(false);
  });

  it("logout without a saved file says so and warns when ARNICT_API_KEY is still set", async () => {
    const { home, path } = tempHome();
    const io = capture();
    const code = await run(["arnict", "logout"], {
      ...io,
      arnictIo: ioFor(home, { ARNICT_API_KEY: "sk-env-still-set-9999" }),
    });
    expect(code).toBe(0);
    expect(io.stdout).toEqual([`No saved key at ${path}`]);
    expect(io.stderr.join("\n")).toContain("ARNICT_API_KEY is set and still applies");
  });

  it("status probes /v1/models with the saved key", async () => {
    const { home, path } = tempHome();
    savedKey(home, KEY);
    let url = "";
    let auth = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ data: [{ id: "zai/glm-5.3-flash-uncensored" }] }), { status: 200 });
    };
    const io = capture();
    const code = await run(["arnict", "status"], { ...io, arnictIo: ioFor(home, {}, { fetch: fetchImpl }) });
    expect(code).toBe(0);
    expect(url).toBe("https://api.arnict.com/v1/models");
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(io.stdout).toEqual([
      `key: ${MASK} (config)`,
      `path: ${path}`,
      "models: ok (1) zai/glm-5.3-flash-uncensored",
    ]);
  });

  it("status redacts Bearer tokens and the key from a 401", async () => {
    const { home } = tempHome();
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: `Invalid key ${KEY} (also Bearer ${KEY})` } }), { status: 401 });
    const io = capture();
    const code = await run(["arnict", "status"], {
      ...io,
      arnictIo: ioFor(home, { ARNICT_API_KEY: KEY }, { fetch: fetchImpl }),
    });
    expect(code).toBe(1);
    const out = [...io.stdout, ...io.stderr].join("\n");
    expect(out).toContain("models: error 401");
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(KEY);
    expect(io.stdout.join("\n")).toContain(`key: ${MASK} (env)`);
  });

  it("status without a key says so, exits 1, and never calls the network", async () => {
    const { home, path } = tempHome();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const io = capture();
    const code = await run(["arnict", "status"], { ...io, arnictIo: ioFor(home, {}, { fetch: fetchImpl }) });
    expect(code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(io.stdout).toEqual(["key: none", `path: ${path}`]);
    expect(io.stderr).toEqual(["no key: run ns-bridge arnict login"]);
  });

  it("status prefers ARNICT_API_KEY over the file and honors ARNICT_BASE_URL", async () => {
    const { home, path } = tempHome();
    savedKey(home, "sk-file-only-key-111111");
    let url = "";
    let auth = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const io = capture();
    const code = await run(["arnict", "status"], {
      ...io,
      arnictIo: ioFor(
        home,
        { ARNICT_API_KEY: "sk-env-key-222222", ARNICT_BASE_URL: "https://arnict.test/v1/" },
        { fetch: fetchImpl },
      ),
    });
    expect(code).toBe(0);
    expect(url).toBe("https://arnict.test/v1/models");
    expect(auth).toBe("Bearer sk-env-key-222222");
    expect(io.stdout).toEqual(["key: sk-e…2222 (env)", `path: ${path}`, "models: ok (0)"]);
  });

  it("status --json prints one JSON report", async () => {
    const { home } = tempHome();
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "zai/glm-5.3-flash-uncensored" }] }), { status: 200 });
    const io = capture();
    const code = await run(["arnict", "status", "--json"], {
      ...io,
      arnictIo: ioFor(home, { ARNICT_API_KEY: "sk-json-key-5555555" }, { fetch: fetchImpl }),
    });
    expect(code).toBe(0);
    const report = JSON.parse(io.stdout.join("\n")) as {
      source: string;
      key: string;
      models: { ok: boolean; count: number; ids: string[] };
    };
    expect(report.source).toBe("env");
    expect(report.key).toBe("sk-j…5555");
    expect(report.models).toEqual({ ok: true, count: 1, ids: ["zai/glm-5.3-flash-uncensored"] });
  });

  it("rejects unknown actions, extra arguments, and shows the commands in help", async () => {
    const { home } = tempHome();
    const io = capture();
    expect(await run(["arnict", "bogus"], { ...io, arnictIo: ioFor(home, {}) })).toBe(1);
    expect(io.stderr).toEqual(["usage: ns-bridge arnict login|logout|status"]);
    const extra = capture();
    expect(await run(["arnict", "login", "extra"], { ...extra, arnictIo: ioFor(home, {}) })).toBe(1);
    expect(extra.stderr).toEqual(["unexpected argument extra"]);
    const help = capture();
    await run(["help"], help);
    expect(help.stdout.join("\n")).toContain("ns-bridge arnict login [--stdin]");
    expect(help.stdout.join("\n")).toContain("ns-bridge arnict status [--json]");
  });
});
