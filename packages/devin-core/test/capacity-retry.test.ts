import { describe, expect, it } from "vitest";
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
});
