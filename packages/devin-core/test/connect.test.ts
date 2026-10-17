import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  ConnectFrameReader,
  encodeConnectFrame,
  MAX_CONNECT_FRAME_PAYLOAD,
} from "../src/connect.js";
import { DevinProtocolError } from "../src/errors.js";

function plainFrame(text: string, flag = 0): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flag;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

describe("ConnectFrameReader", () => {
  it("decodes a plain frame", () => {
    const payload = new TextEncoder().encode("hello");
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    const envelope = reader.next();
    expect(envelope?.endStream).toBe(false);
    expect(new TextDecoder().decode(envelope?.payload)).toBe("hello");
    expect(reader.next()).toBeNull();
  });

  it("decodes a gzipped frame produced by encodeConnectFrame", () => {
    const reader = new ConnectFrameReader();
    reader.push(encodeConnectFrame(new TextEncoder().encode("data")));
    const envelope = reader.next();
    expect(envelope?.flag).toBe(CONNECT_COMPRESSED_FLAG);
    expect(new TextDecoder().decode(envelope?.payload ?? new Uint8Array())).toBe("data");
  });

  it("reassembles a frame split across chunks", () => {
    const payload = new TextEncoder().encode("split me");
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    const reader = new ConnectFrameReader();
    reader.push(frame.subarray(0, 3));
    expect(reader.next()).toBeNull();
    reader.push(frame.subarray(3));
    expect(new TextDecoder().decode(reader.next()?.payload ?? new Uint8Array())).toBe("split me");
  });

  it("flags the end-of-stream trailer frame", () => {
    const trailer = new TextEncoder().encode('{"error":{"code":"x"}}');
    const frame = new Uint8Array(5 + trailer.length);
    frame[0] = CONNECT_END_STREAM_FLAG;
    new DataView(frame.buffer).setUint32(1, trailer.length);
    frame.set(trailer, 5);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    expect(reader.next()?.endStream).toBe(true);
  });

  it("rejects a frame length over the cap", () => {
    const frame = new Uint8Array(5);
    new DataView(frame.buffer).setUint32(1, MAX_CONNECT_FRAME_PAYLOAD + 1);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    expect(() => reader.next()).toThrow(DevinProtocolError);
    // The header is not consumed, so a later next() still refuses the same frame.
    expect(() => reader.next()).toThrow(DevinProtocolError);
  });

  it("waits for bytes when the declared length is exactly the cap", () => {
    const frame = new Uint8Array(5);
    new DataView(frame.buffer).setUint32(1, MAX_CONNECT_FRAME_PAYLOAD);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    expect(reader.next()).toBeNull();
  });

  it("ignores an empty chunk and a split inside the length prefix", () => {
    const frame = plainFrame("edge");
    const reader = new ConnectFrameReader();
    reader.push(frame.subarray(0, 1));
    reader.push(new Uint8Array());
    expect(reader.next()).toBeNull();
    reader.push(frame.subarray(1, 4));
    expect(reader.next()).toBeNull();
    reader.push(frame.subarray(4));
    expect(new TextDecoder().decode(reader.next()?.payload ?? new Uint8Array())).toBe("edge");
  });

  it("returns an empty payload for a zero-length frame", () => {
    const reader = new ConnectFrameReader();
    reader.push(new Uint8Array(5));
    const envelope = reader.next();
    expect(envelope?.payload).toHaveLength(0);
    expect(envelope?.endStream).toBe(false);
    expect(reader.next()).toBeNull();
  });

  it("decodes two frames that arrived in one chunk", () => {
    const first = plainFrame("one");
    const second = plainFrame("two", CONNECT_END_STREAM_FLAG);
    const both = new Uint8Array(first.length + second.length);
    both.set(first, 0);
    both.set(second, first.length);
    const reader = new ConnectFrameReader();
    reader.push(both);
    expect(new TextDecoder().decode(reader.next()?.payload ?? new Uint8Array())).toBe("one");
    const trailer = reader.next();
    expect(trailer?.endStream).toBe(true);
    expect(new TextDecoder().decode(trailer?.payload ?? new Uint8Array())).toBe("two");
    expect(reader.next()).toBeNull();
  });

  it("passes unknown flag bits through and still honors the bits it knows", () => {
    const reader = new ConnectFrameReader();
    reader.push(plainFrame("plain", 0x80));
    const unknown = reader.next();
    expect(unknown?.flag).toBe(0x80);
    expect(unknown?.endStream).toBe(false);
    expect(new TextDecoder().decode(unknown?.payload ?? new Uint8Array())).toBe("plain");

    const compressed = gzipSync(new TextEncoder().encode("both"));
    const frame = new Uint8Array(5 + compressed.length);
    frame[0] = CONNECT_COMPRESSED_FLAG | CONNECT_END_STREAM_FLAG | 0x80;
    new DataView(frame.buffer).setUint32(1, compressed.length);
    frame.set(compressed, 5);
    reader.push(frame);
    const both = reader.next();
    expect(both?.endStream).toBe(true);
    expect(new TextDecoder().decode(both?.payload ?? new Uint8Array())).toBe("both");
  });

  it("consumes a compressed frame whose payload is not gzip", () => {
    const reader = new ConnectFrameReader();
    reader.push(plainFrame("nope", CONNECT_COMPRESSED_FLAG));
    expect(() => reader.next()).toThrow();
    expect(reader.next()).toBeNull();
  });
});
