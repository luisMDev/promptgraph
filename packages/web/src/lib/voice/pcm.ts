import { VOICE_BYTES_PER_SAMPLE, VOICE_CHUNK_MS, VOICE_SAMPLE_RATE } from "@promptgraph/shared";

/**
 * Pure audio helpers of voice dictation (DESIGN §22): resampling the microphone to 16 kHz, Float32 → Int16 and the
 * little-endian byte layout of the binary WS frames, ~100 ms chunking and the RMS level used by the meter and the
 * silence detection. No DOM or Web Audio here, so they are unit-tested directly.
 */

/** Samples of one binary frame: VOICE_CHUNK_MS of 16 kHz audio (1600 samples = 3200 bytes). */
export const VOICE_CHUNK_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_CHUNK_MS) / 1000;

/** RMS (0..1) above which a block counts as speech for the silence auto-stop. */
export const SPEECH_RMS_THRESHOLD = 0.01;

/** Float sample in [-1, 1] → signed 16-bit (clamped, rounded). */
export function floatToInt16(sample: number): number {
  const s = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
}

/** Root mean square of a block of float samples (0 for an empty block). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** Int16 samples → little-endian bytes (explicitly LE, whatever the platform's endianness). */
export function int16ToLittleEndian(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * VOICE_BYTES_PER_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * VOICE_BYTES_PER_SAMPLE, samples[i]!, true);
  return out;
}

/**
 * Streaming resampler from the AudioContext rate (typically 48 kHz or 44.1 kHz) to 16 kHz Int16. Downsampling
 * averages the input samples that fall into each output period (a box low-pass filter, enough for speech); state
 * carries over between pushes, so feeding the audio in blocks gives the same result as feeding it at once.
 */
export class PcmResampler {
  private pending: Float32Array = new Float32Array(0);
  /** Output samples produced so far. */
  private produced = 0;
  /** Input samples dropped from the front of `pending` so far. */
  private consumed = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number = VOICE_SAMPLE_RATE,
  ) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new Error("Sample rates must be positive integers");
    }
  }

  /** Input index where output sample `k` starts: exact integer arithmetic, so blocks never drift. */
  private boundary(k: number): number {
    return Math.floor((k * this.inputRate) / this.outputRate);
  }

  push(input: Float32Array): Int16Array {
    const buf = new Float32Array(this.pending.length + input.length);
    buf.set(this.pending);
    buf.set(input, this.pending.length);
    const available = this.consumed + buf.length;
    const out: number[] = [];
    let k = this.produced;
    // Output k averages input [boundary(k), boundary(k+1)); it needs the whole period, and the period must start
    // inside the data. When upsampling a period can be empty (boundary(k) === boundary(k+1)): it then repeats
    // input boundary(k), which must already be here (never read past the end of `buf`).
    while (this.boundary(k) < available && (this.boundary(k + 1) <= available || this.boundary(k + 1) === this.boundary(k))) {
      const start = this.boundary(k) - this.consumed;
      const end = Math.max(start + 1, this.boundary(k + 1) - this.consumed);
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i]!;
      out.push(floatToInt16(sum / (end - start)));
      k++;
    }
    this.produced = k;
    const keep = Math.min(this.boundary(k) - this.consumed, buf.length);
    this.pending = buf.slice(keep);
    this.consumed += keep;
    return Int16Array.from(out);
  }

  /**
   * End of the stream: the incomplete last period still pending (less than one output sample's worth) becomes one
   * more sample, the average of what arrived. Call once, when the recording stops.
   */
  flush(): Int16Array {
    const n = this.pending.length;
    if (n === 0 || this.boundary(this.produced) >= this.consumed + n) return new Int16Array(0);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.pending[i]!;
    this.pending = new Float32Array(0);
    this.consumed += n;
    this.produced++;
    return Int16Array.from([floatToInt16(sum / n)]);
  }
}

/** Groups 16 kHz Int16 samples into frames of VOICE_CHUNK_SAMPLES, as little-endian bytes. */
export class PcmChunker {
  private buf: Int16Array;
  private n = 0;

  constructor(readonly chunkSamples: number = VOICE_CHUNK_SAMPLES) {
    this.buf = new Int16Array(chunkSamples);
  }

  push(samples: Int16Array): Uint8Array<ArrayBuffer>[] {
    const out: Uint8Array<ArrayBuffer>[] = [];
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.chunkSamples - this.n, samples.length - i);
      this.buf.set(samples.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.chunkSamples) {
        out.push(int16ToLittleEndian(this.buf));
        this.n = 0;
      }
    }
    return out;
  }

  /** The partial frame left (null when empty). */
  flush(): Uint8Array<ArrayBuffer> | null {
    if (this.n === 0) return null;
    const out = int16ToLittleEndian(this.buf.subarray(0, this.n));
    this.n = 0;
    return out;
  }
}

/**
 * Inserts a transcript into `value` in place of the selection [start, end), adding a space on either side when it
 * would otherwise touch a non-space character. Returns the new value and the caret position after the insertion.
 */
export function insertTranscript(value: string, start: number, end: number, transcript: string): { value: string; caret: number } {
  const text = transcript.trim();
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  if (!text) return { value, caret: b };
  const before = value.slice(0, a);
  const after = value.slice(b);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return { value: before + inserted + after, caret: a + lead.length + text.length };
}

/** "m:ss" of an elapsed time in milliseconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
