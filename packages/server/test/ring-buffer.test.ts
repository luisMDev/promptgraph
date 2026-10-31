import { describe, expect, it } from "vitest";
import { PTY_RING_BYTES, RingBuffer } from "../src/pty/ring-buffer.js";

describe("RingBuffer", () => {
  it("defaults to 2 MB and keeps everything below capacity", () => {
    const rb = new RingBuffer();
    expect(rb.capacity).toBe(PTY_RING_BYTES);
    rb.push(Buffer.from("hello "));
    rb.push(Buffer.from("world"));
    expect(rb.snapshot().toString()).toBe("hello world");
    expect(rb.size).toBe(11);
  });

  it("drops the oldest bytes, also inside a chunk", () => {
    const rb = new RingBuffer(8);
    rb.push(Buffer.from("abcde"));
    rb.push(Buffer.from("fghij"));
    expect(rb.snapshot().toString()).toBe("cdefghij");
    rb.push(Buffer.from("0123456789xyz"));
    expect(rb.snapshot().toString()).toBe("6789xyz".padStart(8, "5"));
    expect(rb.size).toBe(8);
  });

  it("returns a copy", () => {
    const rb = new RingBuffer(4);
    rb.push(Buffer.from("ab"));
    const snap = rb.snapshot();
    snap[0] = 0x7a;
    expect(rb.snapshot().toString()).toBe("ab");
  });
});
