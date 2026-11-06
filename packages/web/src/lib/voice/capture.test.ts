import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMicCapture } from "./capture";
import { VOICE_CHUNK_SAMPLES } from "./pcm";

/** Minimal Web Audio + getUserMedia fakes: the worklet's port is driven by the test. */
class FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  /** Answer to {type: "flush"} (the worklet's partial block), or null to never acknowledge. */
  flushReply: Float32Array | null | "none" = null;
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
  postMessage(data: unknown) {
    this.posted.push(data);
    if ((data as { type?: string }).type === "flush" && this.flushReply !== "none") {
      const reply = this.flushReply;
      queueMicrotask(() => {
        if (reply) this.emit(reply);
        this.emit({ type: "flushed" });
      });
    }
  }
}

const nodes: FakeWorkletNode[] = [];
const contexts: FakeAudioContext[] = [];

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeWorkletNode extends FakeNode {
  port = new FakePort();
  constructor(
    readonly ctx: FakeAudioContext,
    readonly name: string,
    readonly options: unknown,
  ) {
    super();
    nodes.push(this);
  }
}

class FakeAudioContext {
  sampleRate = 48000;
  state = "running";
  onstatechange: (() => void) | null = null;
  destination = new FakeNode();
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  audioWorklet = { addModule: vi.fn(async (_url: string | URL) => undefined) };
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource = vi.fn(() => new FakeNode());
  createGain = () => Object.assign(new FakeNode(), { gain: { value: 1 } });
}

describe("startMicCapture", () => {
  let track: { stop: ReturnType<typeof vi.fn>; listeners: Record<string, () => void>; addEventListener(t: string, f: () => void): void; removeEventListener(t: string): void };
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nodes.length = 0;
    contexts.length = 0;
    track = {
      stop: vi.fn(),
      listeners: {},
      addEventListener(t, f) {
        this.listeners[t] = f;
      },
      removeEventListener(t) {
        delete this.listeners[t];
      },
    };
    getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks for a mono, echo-cancelled microphone and loads the worklet module", async () => {
    const handle = await startMicCapture({ onChunk: () => {}, onLevel: () => {} });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ channelCount: 1, echoCancellation: true, noiseSuppression: true }) });
    const url = String(contexts[0]!.audioWorklet.addModule.mock.calls[0]![0]);
    expect(url).toMatch(/pcm-capture\.worklet\.js$/);
    expect(nodes[0]!.name).toBe("pg-pcm-capture");
    handle.stop();
  });

  it("turns 48 kHz worklet blocks into 100 ms LE Int16 frames at 16 kHz, with levels", async () => {
    const chunks: Uint8Array[] = [];
    const levels: number[] = [];
    const handle = await startMicCapture({ onChunk: (b) => chunks.push(b), onLevel: (l) => levels.push(l) });
    const port = nodes[0]!.port;
    // 2400 samples at 48 kHz = 50 ms → 800 samples at 16 kHz: a frame every two blocks.
    port.emit(new Float32Array(2400).fill(0.5));
    expect(chunks).toHaveLength(0);
    port.emit(new Float32Array(2400).fill(0.5));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.byteLength).toBe(VOICE_CHUNK_SAMPLES * 2);
    expect(new DataView(chunks[0]!.buffer).getInt16(0, true)).toBe(16384);
    expect(levels[0]).toBeCloseTo(0.5);
    port.emit(new Float32Array(1200));
    // The partial frame left is returned by stop() for the caller to send.
    expect(handle.stop()?.byteLength).toBe(400 * 2);
  });

  it("releases the microphone and the AudioContext on stop", async () => {
    const chunks: Uint8Array[] = [];
    const handle = await startMicCapture({ onChunk: (b) => chunks.push(b), onLevel: () => {} });
    handle.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(contexts[0]!.close).toHaveBeenCalled();
    nodes[0]!.port.emit(new Float32Array(4800));
    expect(chunks).toHaveLength(0);
    expect(handle.stop()).toBeNull();
  });

  it("drain delivers the worklet's partial block and the queued blocks before releasing the mic", async () => {
    const chunks: Uint8Array[] = [];
    const handle = await startMicCapture({ onChunk: (b) => chunks.push(b), onLevel: () => {} });
    const port = nodes[0]!.port;
    port.emit(new Float32Array(2400).fill(0.5)); // 800 samples at 16 kHz: no frame yet
    port.flushReply = new Float32Array(1200).fill(0.5); // + 400 → 1200: still under a frame
    const tail = await handle.drain!();
    expect(port.posted).toContainEqual({ type: "flush" });
    expect(chunks).toHaveLength(0);
    expect(tail?.byteLength).toBe(1200 * 2);
    expect(track.stop).toHaveBeenCalled();
    expect(contexts[0]!.close).toHaveBeenCalled();
    expect(handle.stop()).toBeNull();
  });

  it("drain gives up waiting for the worklet after a short timeout", async () => {
    vi.useFakeTimers();
    try {
      const handle = await startMicCapture({ onChunk: () => {}, onLevel: () => {} });
      nodes[0]!.port.flushReply = "none";
      const p = handle.drain!();
      await vi.advanceTimersByTimeAsync(300);
      expect(await p).toBeNull();
      expect(track.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a lost microphone (track ended, context interrupted) once, never after stop", async () => {
    const onEnded = vi.fn();
    const handle = await startMicCapture({ onChunk: () => {}, onLevel: () => {}, onEnded });
    track.listeners.ended!();
    contexts[0]!.state = "interrupted";
    contexts[0]!.onstatechange?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded.mock.calls[0]![0]).toMatch(/disconnected/);
    handle.stop();
    expect(track.listeners.ended).toBeUndefined();

    const onEnded2 = vi.fn();
    const h2 = await startMicCapture({ onChunk: () => {}, onLevel: () => {}, onEnded: onEnded2 });
    contexts[1]!.state = "closed";
    contexts[1]!.onstatechange?.();
    expect(onEnded2).toHaveBeenCalledWith(expect.stringMatching(/interrupted/));
    h2.stop();
  });

  it("reports a denied permission", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await expect(startMicCapture({ onChunk: () => {}, onLevel: () => {} })).rejects.toMatchObject({ kind: "denied" });
  });

  it("releases the microphone when the worklet fails to load", async () => {
    vi.stubGlobal(
      "AudioContext",
      class extends FakeAudioContext {
        override audioWorklet = { addModule: vi.fn(async () => Promise.reject(new Error("404"))) };
      },
    );
    await expect(startMicCapture({ onChunk: () => {}, onLevel: () => {} })).rejects.toMatchObject({ kind: "failed" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("explains a browser without Web Audio", async () => {
    vi.stubGlobal("AudioWorkletNode", undefined);
    await expect(startMicCapture({ onChunk: () => {}, onLevel: () => {} })).rejects.toMatchObject({ kind: "unsupported" });
  });
});
