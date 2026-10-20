import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGrokAccess, pickGrokAccount, resetGrokAuthCacheForTests } from "../src/auth.js";
import { GrokAuthError } from "../src/errors.js";

const dirs: string[] = [];

afterEach(async () => {
  resetGrokAuthCacheForTests();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function authFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grok-auth-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify(contents, null, 2), { mode: 0o600 });
  return path;
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    key: "access-old",
    refresh_token: "refresh-old",
    expires_at: "2026-10-20T00:00:00.000Z",
    auth_mode: "oidc",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "client-1",
    email: "person@example.com",
    ...overrides,
  };
}

describe("Grok CLI session", () => {
  it("prefers the auth.x.ai record that can refresh", () => {
    const picked = pickGrokAccount({
      "https://accounts.example/other": account({ key: "other" }),
      "https://auth.x.ai::client-1": account(),
    });
    expect(picked?.key).toBe("https://auth.x.ai::client-1");
    expect(picked?.account.email).toBe("person@example.com");
  });

  it("refreshes an expiring token and writes only the token fields", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account(),
      other: { note: "leave-me" },
    });
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.x.ai/oauth2/token");
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      expect(String(init?.body)).toContain("refresh_token=refresh-old");
      expect(String(init?.body)).toContain("client_id=client-1");
      return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 120 });
    };
    const loaded = await loadGrokAccess({
      authPath: path,
      now: Date.parse("2026-10-20T00:00:30.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(loaded.accessToken).toBe("access-new");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      other: { note: string };
      "https://auth.x.ai::client-1": { key: string; refresh_token: string; expires_at: string; email: string };
    };
    const record = saved["https://auth.x.ai::client-1"];
    expect(record.key).toBe("access-new");
    expect(record.refresh_token).toBe("refresh-new");
    expect(record.email).toBe("person@example.com");
    expect(record.expires_at).toBe("2026-10-20T00:02:30.000Z");
    expect(saved.other.note).toBe("leave-me");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps a still-valid token when refresh fails", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account({ expires_at: "2026-10-20T00:00:30.000Z" }),
    });
    const fetchImpl = async () => new Response("nope", { status: 400 });
    const loaded = await loadGrokAccess({
      authPath: path,
      now: Date.parse("2026-10-20T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(loaded.accessToken).toBe("access-old");
    const saved = JSON.parse(await readFile(path, "utf8")) as { [key: string]: { key: string } };
    expect(saved["https://auth.x.ai::client-1"]?.key).toBe("access-old");
  });

  it("tells the user to log in when the token is expired and refresh fails", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account({ expires_at: "2026-10-19T00:00:00.000Z" }),
    });
    const fetchImpl = async () => new Response("nope", { status: 400 });
    await expect(
      loadGrokAccess({
        authPath: path,
        now: Date.parse("2026-10-20T00:00:00.000Z"),
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(GrokAuthError);
    await expect(
      loadGrokAccess({
        authPath: path,
        now: Date.parse("2026-10-20T00:00:00.000Z"),
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/grok login/);
  });

  it("does not refresh a token that is still outside the window", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account({ expires_at: "2026-10-20T02:00:00.000Z" }),
    });
    const fetchImpl = async () => {
      throw new Error("refresh was not required");
    };
    const loaded = await loadGrokAccess({
      authPath: path,
      now: Date.parse("2026-10-20T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(loaded.accessToken).toBe("access-old");
  });

  it("shares one refresh across overlapping calls", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account(),
    });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 120 });
    };
    const input = {
      authPath: path,
      now: Date.parse("2026-10-20T00:00:30.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
    };
    const [first, second] = await Promise.all([loadGrokAccess(input), loadGrokAccess(input)]);
    expect(calls).toBe(1);
    expect(first.accessToken).toBe("access-new");
    expect(second.accessToken).toBe("access-new");
  });

  it("refuses a rotated refresh token that could not be stored", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account(),
    });
    const dir = join(path, "..");
    const fetchImpl = async () => {
      await chmod(dir, 0o500);
      return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 120 });
    };
    try {
      await expect(
        loadGrokAccess({
          authPath: path,
          now: Date.parse("2026-10-20T00:00:30.000Z"),
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow(/grok login/);
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        [key: string]: { key: string; refresh_token: string };
      };
      expect(saved["https://auth.x.ai::client-1"]?.key).toBe("access-old");
      expect(saved["https://auth.x.ai::client-1"]?.refresh_token).toBe("refresh-old");
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it("keeps the new access token when the server did not rotate and the write failed", async () => {
    const path = await authFile({
      "https://auth.x.ai::client-1": account(),
    });
    const dir = join(path, "..");
    const fetchImpl = async () => {
      await chmod(dir, 0o500);
      return Response.json({ access_token: "access-new", expires_in: 120 });
    };
    try {
      const loaded = await loadGrokAccess({
        authPath: path,
        now: Date.parse("2026-10-20T00:00:30.000Z"),
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(loaded.accessToken).toBe("access-new");
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        [key: string]: { refresh_token: string };
      };
      expect(saved["https://auth.x.ai::client-1"]?.refresh_token).toBe("refresh-old");
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it("returns a fresh token without waiting on another process's refresh lock", async () => {
    const path = await authFile({ "https://auth.x.ai::client-1": account({ expires_at: "2026-10-20T01:00:00.000Z" }) });
    // A lock another process holds (or left behind) must not stall a token that needs no refresh.
    await writeFile(`${path}.lock`, "");
    const fetchImpl = async () => {
      throw new Error("no refresh expected");
    };
    const started = Date.now();
    const loaded = await loadGrokAccess({
      authPath: path,
      now: Date.parse("2026-10-20T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(loaded.accessToken).toBe("access-old");
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(stat(`${path}.lock`)).resolves.toBeTruthy();
  });
});
