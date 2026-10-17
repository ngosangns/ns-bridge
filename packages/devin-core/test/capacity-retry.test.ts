import { afterEach, describe, expect, it, vi } from "vitest";
import { streamDevinWithCapacityRetry } from "../src/capacity-retry.js";
import { DevinApiError, DevinStreamError } from "../src/errors.js";
import type { DevinStreamRequest } from "../src/stream.js";
import type { DevinStreamEvent } from "../src/types.js";

const policy = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 };
const request = { model: { id: "m" } } as unknown as DevinStreamRequest;

function capacityTrailer(): Error {
  return new DevinStreamError("We are currently experiencing capacity issues with this serving model.", "unavailable");
}

async function collect(source: AsyncIterable<DevinStreamEvent>) {
  const out: DevinStreamEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

describe("streamDevinWithCapacityRetry", () => {
  it("retries a capacity failure that arrives before any content", async () => {
    let calls = 0;
    const out = await collect(
      streamDevinWithCapacityRetry(request, policy, async function* () {
        calls++;
        yield { type: "start" };
        if (calls < 3) throw capacityTrailer();
        yield { type: "text_start", index: 0 };
        yield { type: "text_end", index: 0, text: "ok" };
        yield { type: "done", stopReason: "stop" };
      }),
    );
    expect(calls).toBe(3);
    expect(out.map((event) => event.type)).toEqual(["start", "text_start", "text_end", "done"]);
  });

  it("does not replay after content was emitted", async () => {
    let calls = 0;
    const source = streamDevinWithCapacityRetry(request, policy, async function* () {
      calls++;
      yield { type: "start" };
      yield { type: "text_start", index: 0 };
      throw capacityTrailer();
    });
    await expect(collect(source)).rejects.toThrow(/capacity/);
    expect(calls).toBe(1);
  });

  it("gives up after the policy's retries and leaves other errors alone", async () => {
    let calls = 0;
    await expect(
      collect(
        streamDevinWithCapacityRetry(request, policy, async function* () {
          calls++;
          yield* [];
          throw new DevinApiError("Devin API error: 503", "API", 503);
        }),
      ),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      collect(
        streamDevinWithCapacityRetry(request, policy, async function* () {
          calls++;
          yield* [];
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("does not retry once a thinking block has committed the attempt", async () => {
    let calls = 0;
    const seen: string[] = [];
    const source = streamDevinWithCapacityRetry(request, policy, async function* () {
      calls++;
      yield { type: "start" };
      yield { type: "thinking_start", index: 0 };
      throw capacityTrailer();
    });
    await expect(
      (async () => {
        for await (const event of source) seen.push(event.type);
      })(),
    ).rejects.toThrow(/capacity/);
    expect(calls).toBe(1);
    expect(seen).toEqual(["start", "thinking_start"]);
  });

  it("does not retry when the policy allows zero retries", async () => {
    let calls = 0;
    await expect(
      collect(
        streamDevinWithCapacityRetry(request, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 }, async function* () {
          calls++;
          yield* [];
          throw capacityTrailer();
        }),
      ),
    ).rejects.toThrow(/capacity/);
    expect(calls).toBe(1);
  });

  it("rejects with the caller reason while waiting out a capacity backoff", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = collect(
      streamDevinWithCapacityRetry(
        { ...request, signal: controller.signal },
        { maxRetries: 2, baseDelayMs: 60_000, maxDelayMs: 60_000 },
        async function* () {
          calls++;
          yield* [];
          throw capacityTrailer();
        },
      ),
    );
    setTimeout(() => controller.abort(new Error("stop")), 15);
    await expect(pending).rejects.toThrow("stop");
    expect(calls).toBe(1);
  });

  it("runs the first attempt when the signal is already aborted, then stops", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already"));
    let calls = 0;
    await expect(
      collect(
        streamDevinWithCapacityRetry({ ...request, signal: controller.signal }, policy, async function* () {
          calls++;
          yield* [];
          throw capacityTrailer();
        }),
      ),
    ).rejects.toThrow("already");
    expect(calls).toBe(1);
  });

  it("caps the backoff at maxDelayMs", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = collect(
      streamDevinWithCapacityRetry(request, { maxRetries: 1, baseDelayMs: 10_000, maxDelayMs: 50 }, async function* () {
        calls++;
        if (calls === 1) throw capacityTrailer();
        yield { type: "text_end", index: 0, text: "ok" };
        yield { type: "done", stopReason: "stop" };
      }),
    );
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(calls).toBe(2);
    expect(out.at(-1)?.type).toBe("done");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
