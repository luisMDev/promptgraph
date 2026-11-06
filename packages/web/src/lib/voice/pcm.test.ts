import { NODE_TYPES, VOICE_MAX_KEYTERMS } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { linearGraph } from "../../test-fixtures";
import { dictationKeyterms } from "./keyterms";
import { PcmChunker, PcmResampler, VOICE_CHUNK_SAMPLES, floatToInt16, formatElapsed, insertTranscript, int16ToLittleEndian, rms } from "./pcm";

describe("pcm helpers", () => {
  it("converts floats to clamped Int16", () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    expect(floatToInt16(2)).toBe(32767);
    expect(floatToInt16(-3)).toBe(-32768);
    expect(floatToInt16(0.5)).toBe(16384);
    expect(floatToInt16(Number.NaN)).toBe(0);
  });

  it("encodes Int16 as little-endian bytes", () => {
    const bytes = int16ToLittleEndian(Int16Array.from([1, -2, 0x1234]));
    expect([...bytes]).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12]);
  });

  it("computes the RMS level", () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(Float32Array.from([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it("downsamples 48 kHz to 16 kHz, keeping a constant signal", () => {
    const r = new PcmResampler(48000);
    const out = r.push(new Float32Array(4800).fill(0.25));
    expect(out.length).toBe(1600);
    expect(new Set(out)).toEqual(new Set([floatToInt16(0.25)]));
  });

  it("gives the same samples whether the input comes at once or in blocks (44.1 kHz)", () => {
    const input = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 7) * 0.8);
    const once = new PcmResampler(44100).push(input);
    const streamed = new PcmResampler(44100);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...streamed.push(input.subarray(i, i + 128)));
    expect(once.length).toBe(16000);
    expect(parts.length).toBe(once.length);
    expect(parts).toEqual([...once]);
  });

  it("averages each output period (low-pass): alternating samples cancel out", () => {
    const out = new PcmResampler(32000).push(Float32Array.from({ length: 320 }, (_, i) => (i % 2 ? 1 : -1)));
    expect(out.length).toBe(160);
    expect(Math.max(...out.map(Math.abs))).toBe(0);
  });

  it("upsamples 8 kHz without reading past the block: blocks give the same result as one push", () => {
    const streamed = new PcmResampler(8000);
    const parts: number[] = [];
    for (let i = 0; i < 4; i++) parts.push(...streamed.push(new Float32Array(5).fill(0.5)));
    expect(parts).toEqual(new Array(40).fill(16384));
    const input = Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 5) * 0.7);
    const once = new PcmResampler(8000).push(input);
    const blocks = new PcmResampler(8000);
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 400) out.push(...blocks.push(input.subarray(i, i + 400)));
    expect(once.length).toBe(16000);
    expect(out).toEqual([...once]);
  });

  it("flush turns the incomplete last period into one more sample", () => {
    const r = new PcmResampler(48000);
    expect(r.push(new Float32Array(5).fill(0.5))).toHaveLength(1); // 3 used, 2 pending
    expect([...r.flush()]).toEqual([16384]);
    expect(r.flush()).toHaveLength(0);
    expect(new PcmResampler(48000).flush()).toHaveLength(0);
  });

  it("passes 16 kHz through unchanged", () => {
    const out = new PcmResampler(16000).push(Float32Array.from([0, 0.5, -0.5]));
    expect([...out]).toEqual([0, 16384, -16384]);
  });

  it("chunks into 100 ms frames and flushes the rest", () => {
    const c = new PcmChunker();
    expect(c.push(new Int16Array(1000))).toEqual([]);
    const frames = c.push(new Int16Array(2500));
    expect(frames.map((f) => f.byteLength)).toEqual([VOICE_CHUNK_SAMPLES * 2, VOICE_CHUNK_SAMPLES * 2]);
    expect(c.flush()?.byteLength).toBe((3500 - 2 * VOICE_CHUNK_SAMPLES) * 2);
    expect(c.flush()).toBeNull();
  });
});

describe("insertTranscript", () => {
  it("inserts into an empty composer", () => {
    expect(insertTranscript("", 0, 0, " hello world ")).toEqual({ value: "hello world", caret: 11 });
  });

  it("adds separating spaces at the cursor", () => {
    expect(insertTranscript("Add a node", 5, 5, "commit")).toEqual({ value: "Add a commit node", caret: 12 });
    expect(insertTranscript("Add", 3, 3, "a test")).toEqual({ value: "Add a test", caret: 10 });
    expect(insertTranscript("node", 0, 0, "Add a")).toEqual({ value: "Add a node", caret: 5 });
  });

  it("does not double existing spaces", () => {
    expect(insertTranscript("Add  node", 4, 4, "a")).toEqual({ value: "Add a node", caret: 5 });
  });

  it("replaces the selection", () => {
    expect(insertTranscript("Add a shell node", 6, 11, "commit")).toEqual({ value: "Add a commit node", caret: 12 });
  });

  it("leaves the value alone for an empty transcript", () => {
    expect(insertTranscript("abc", 1, 1, "  ")).toEqual({ value: "abc", caret: 1 });
  });

  it("clamps a stale cursor", () => {
    expect(insertTranscript("abc", 10, 12, "d")).toEqual({ value: "abc d", caret: 5 });
  });
});

describe("dictation helpers", () => {
  it("formats the elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
  });

  it("builds keyterms from promptgraph, node types and node labels, capped", () => {
    const graph = linearGraph();
    graph.nodes[0]!.label = "Write the tests";
    const terms = dictationKeyterms(graph);
    expect(terms.slice(0, 1 + NODE_TYPES.length)).toEqual(["promptgraph", ...NODE_TYPES]);
    expect(terms).toContain("Write the tests");
    const big = linearGraph();
    big.nodes = Array.from({ length: 80 }, (_, i) => ({ ...graph.nodes[0]!, id: `n${i}`, label: `Step ${i}` }));
    expect(dictationKeyterms(big)).toHaveLength(VOICE_MAX_KEYTERMS);
    expect(dictationKeyterms(null)).toEqual(["promptgraph", ...NODE_TYPES]);
  });
});
