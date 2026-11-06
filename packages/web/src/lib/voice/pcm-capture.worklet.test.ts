import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Runs the plain-JS worklet processor in a sandbox with a fake AudioWorkletGlobalScope. The port transfers the
 * buffer like the real one, so a block reused after postMessage would be detached (length 0).
 */
type FakeProcessor = { process(inputs: Float32Array[][]): boolean; port: { onmessage: ((ev: { data: unknown }) => void) | null } };

function loadProcessor(sampleRate: number) {
  const posted: Float32Array[] = [];
  const control: unknown[] = [];
  let Processor: (new () => FakeProcessor) | null = null;
  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage(data: unknown, transfer: ArrayBuffer[] = []) {
        if (!(data instanceof Float32Array)) {
          control.push(data);
          return;
        }
        posted.push(data.slice());
        // Detach like a real transfer.
        for (const buf of transfer) structuredClone(buf, { transfer: [buf] });
      },
    };
  }
  const code = fs.readFileSync(new URL("./pcm-capture.worklet.js", import.meta.url), "utf8");
  vm.runInNewContext(code, {
    sampleRate,
    Float32Array,
    Math,
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name: string, cls: typeof Processor) => {
      Processor = cls;
    },
  });
  if (!Processor) throw new Error("registerProcessor was not called");
  return { processor: new (Processor as new () => FakeProcessor)(), posted, control };
}

describe("pcm-capture worklet", () => {
  it("keeps posting ~50 ms mono blocks after the first transfer", () => {
    const { processor, posted } = loadProcessor(48000);
    const quantum = (v: number) => new Float32Array(128).fill(v);
    // 1 s of stereo audio in 128-frame render quanta.
    for (let i = 0; i < 375; i++) expect(processor.process([[quantum(0.5), quantum(-0.25)]])).toBe(true);
    expect(posted).toHaveLength(Math.floor((375 * 128) / 2400));
    for (const block of posted) {
      expect(block).toHaveLength(2400);
      expect(block[0]).toBeCloseTo(0.125);
    }
  });

  it("on flush posts the partial block, then the acknowledgement", () => {
    const { processor, posted, control } = loadProcessor(48000);
    processor.process([[new Float32Array(128).fill(0.5)]]);
    processor.port.onmessage!({ data: { type: "flush" } });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(128);
    expect(control).toEqual([{ type: "flushed" }]);
    // A flush with nothing pending only acknowledges.
    processor.port.onmessage!({ data: { type: "flush" } });
    expect(posted).toHaveLength(1);
    expect(control).toHaveLength(2);
  });

  it("ignores render quanta without input", () => {
    const { processor, posted } = loadProcessor(16000);
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(posted).toHaveLength(0);
  });
});
