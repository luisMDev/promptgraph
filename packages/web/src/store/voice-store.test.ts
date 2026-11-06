import { VOICE_MAX_SECONDS, type ClientMessage, type VoiceStatus } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicError, type CaptureCallbacks } from "../lib/voice/capture";
import { voiceStatusOf } from "../test-fixtures";
import { resetVoiceStore, setVoiceDeps, useVoiceStore } from "./voice-store";

const READY_STATUS: VoiceStatus = voiceStatusOf();

interface FakeCapture {
  callbacks: CaptureCallbacks;
  stop: ReturnType<typeof vi.fn<() => Uint8Array<ArrayBuffer> | null>>;
}

function setup(opts: { connected?: boolean; status?: VoiceStatus; captureError?: unknown } = {}) {
  const sent: ClientMessage[] = [];
  const binary: number[] = [];
  const captures: FakeCapture[] = [];
  let resolveCapture: (() => void) | null = null;
  let deferCapture = false;
  let id = 0;
  setVoiceDeps({
    getStatus: async () => opts.status ?? READY_STATUS,
    send: (msg) => {
      if (opts.connected === false) return false;
      sent.push(msg);
      return true;
    },
    sendBinary: (bytes) => {
      binary.push(bytes.byteLength);
      return opts.connected !== false;
    },
    startCapture: (callbacks) => {
      if (opts.captureError) return Promise.reject(opts.captureError);
      const capture: FakeCapture = { callbacks, stop: vi.fn((): Uint8Array<ArrayBuffer> | null => new Uint8Array(10)) };
      captures.push(capture);
      if (!deferCapture) return Promise.resolve(capture);
      return new Promise((resolve) => {
        resolveCapture = () => resolve(capture);
      });
    },
    newId: () => `v${++id}`,
    now: () => Date.now(),
  });
  return {
    sent,
    binary,
    captures,
    defer: () => {
      deferCapture = true;
    },
    grant: () => resolveCapture?.(),
  };
}

const onFinal = vi.fn();
const store = () => useVoiceStore.getState();

describe("voice store", () => {
  beforeEach(() => {
    resetVoiceStore();
    onFinal.mockReset();
  });
  afterEach(() => {
    resetVoiceStore();
    vi.useRealTimers();
  });

  it("starts: voice:start with sanitized keyterms, then streams binary frames", async () => {
    const t = setup();
    const started = await store().start({ mode: "hold", keyterms: ["promptgraph", " Promptgraph ", "commit"], onFinal });
    expect(started).toBe(true);
    expect(store().state).toBe("recording");
    expect(t.sent).toEqual([{ type: "voice:start", voiceId: "v1", sampleRate: 16000, keyterms: ["promptgraph", "commit"] }]);
    t.captures[0]!.callbacks.onChunk(new Uint8Array(3200));
    t.captures[0]!.callbacks.onLevel(0.2);
    expect(t.binary).toEqual([3200]);
    expect(store().level).toBe(0.2);
  });

  it("sends frames captured before voice:start only after it", async () => {
    const t = setup();
    t.defer();
    const p = store().start({ mode: "tap", onFinal });
    await Promise.resolve();
    expect(store().state).toBe("requesting_mic");
    t.captures[0]!.callbacks.onChunk(new Uint8Array(3200));
    expect(t.binary).toEqual([]);
    t.grant();
    await p;
    expect(t.sent[0]?.type).toBe("voice:start");
    expect(t.binary).toEqual([3200]);
  });

  it("replaces the partial and delivers the final transcript once", async () => {
    setup();
    await store().start({ mode: "hold", onFinal });
    store().applyServerMessage({ type: "voice:partial", voiceId: "v1", text: "add a" });
    store().applyServerMessage({ type: "voice:partial", voiceId: "v1", text: "add a commit" });
    expect(store().partial).toBe("add a commit");
    store().stop();
    expect(store().state).toBe("transcribing");
    store().applyServerMessage({ type: "voice:final", voiceId: "v1", text: " add a commit node " });
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("add a commit node", { truncated: false, autoSubmit: false });
    expect(store().state).toBe("idle");
    expect(store().partial).toBe("");
    store().applyServerMessage({ type: "voice:final", voiceId: "v1", text: "again" });
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it("stop flushes the last frame, releases the mic and sends voice:stop", async () => {
    const t = setup();
    await store().start({ mode: "hold", onFinal });
    store().stop();
    expect(t.captures[0]!.stop).toHaveBeenCalledTimes(1);
    expect(t.binary).toEqual([10]);
    expect(t.sent.at(-1)).toEqual({ type: "voice:stop", voiceId: "v1" });
  });

  it("passes autoSubmit from the status", async () => {
    setup();
    useVoiceStore.setState({ status: { ...READY_STATUS, autoSubmit: true } });
    await store().start({ mode: "hold", onFinal });
    store().stop();
    store().applyServerMessage({ type: "voice:final", voiceId: "v1", text: "ship it" });
    expect(onFinal).toHaveBeenCalledWith("ship it", { truncated: false, autoSubmit: true });
  });

  it("ignores messages of another recording", async () => {
    setup();
    await store().start({ mode: "hold", onFinal });
    store().applyServerMessage({ type: "voice:partial", voiceId: "old", text: "stale" });
    store().applyServerMessage({ type: "voice:final", voiceId: "old", text: "stale" });
    expect(store().partial).toBe("");
    expect(store().state).toBe("recording");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("cancel sends voice:cancel, releases the mic and never delivers a transcript", async () => {
    const t = setup();
    await store().start({ mode: "hold", onFinal });
    store().cancel();
    expect(t.sent.at(-1)).toEqual({ type: "voice:cancel", voiceId: "v1" });
    expect(t.captures[0]!.stop).toHaveBeenCalled();
    expect(store().state).toBe("idle");
    t.captures[0]!.callbacks.onChunk(new Uint8Array(3200));
    expect(t.binary).toEqual([]);
    store().applyServerMessage({ type: "voice:final", voiceId: "v1", text: "late" });
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("cancel while the browser asks for the mic releases it once granted, without voice:start", async () => {
    const t = setup();
    t.defer();
    const p = store().start({ mode: "hold", onFinal });
    await Promise.resolve();
    store().stop(); // = cancel while requesting_mic
    expect(store().state).toBe("idle");
    t.grant();
    expect(await p).toBe(false);
    expect(t.captures[0]!.stop).toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it("explains a denied microphone", async () => {
    setup({ captureError: new MicError("denied", "Microphone access was denied.") });
    expect(await store().start({ mode: "hold", onFinal })).toBe(false);
    expect(store().state).toBe("error");
    expect(store().error).toMatch(/denied/);
    store().dismiss();
    expect(store().state).toBe("idle");
  });

  it("maps a DOMException NotAllowedError to the permission message", async () => {
    setup({ captureError: Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }) });
    await store().start({ mode: "hold", onFinal });
    expect(store().error).toMatch(/Microphone access was denied/);
  });

  it("fails cleanly when the socket is down", async () => {
    const t = setup({ connected: false });
    expect(await store().start({ mode: "hold", onFinal })).toBe(false);
    expect(store().state).toBe("error");
    expect(t.captures[0]!.stop).toHaveBeenCalled();
  });

  it("shows server errors and refreshes the status when whisper is unavailable", async () => {
    const getStatus = vi.fn(async () => ({ ...READY_STATUS, available: false, reason: "model_not_found" as const }));
    setup();
    setVoiceDeps({ getStatus });
    await store().start({ mode: "hold", onFinal });
    store().applyServerMessage({ type: "voice:error", voiceId: "v1", code: "unavailable", message: "model missing" });
    expect(store().state).toBe("error");
    expect(store().error).toBe("Voice dictation is unavailable: model missing");
    expect(getStatus).toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("marks a truncated final with the 2-minute notice", async () => {
    setup();
    await store().start({ mode: "tap", onFinal });
    store().applyServerMessage({ type: "voice:final", voiceId: "v1", text: "long talk", truncated: true });
    expect(onFinal).toHaveBeenCalledWith("long talk", { truncated: true, autoSubmit: false });
    expect(store().notice).toMatch(/2-minute limit/);
  });

  it("stops by itself after 15 s of silence", async () => {
    vi.useFakeTimers();
    const t = setup();
    await store().start({ mode: "tap", onFinal });
    t.captures[0]!.callbacks.onLevel(0.3);
    await vi.advanceTimersByTimeAsync(10_000);
    t.captures[0]!.callbacks.onLevel(0.3); // speech resets the silence clock
    await vi.advanceTimersByTimeAsync(14_000);
    expect(store().state).toBe("recording");
    expect(store().elapsedMs).toBeGreaterThanOrEqual(24_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store().state).toBe("transcribing");
    expect(store().notice).toMatch(/15 s of silence/);
    expect(t.sent.at(-1)).toEqual({ type: "voice:stop", voiceId: "v1" });
  });

  it("stops at the 2-minute cap even while speaking", async () => {
    vi.useFakeTimers();
    const t = setup();
    await store().start({ mode: "tap", onFinal });
    for (let s = 0; s < VOICE_MAX_SECONDS; s += 5) {
      t.captures[0]!.callbacks.onLevel(0.3);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(store().state).toBe("transcribing");
    expect(store().notice).toMatch(/2-minute limit/);
  });

  it("a lost connection ends the recording with an error", async () => {
    const t = setup();
    await store().start({ mode: "hold", onFinal });
    store().connectionLost();
    expect(store().state).toBe("error");
    expect(store().error).toMatch(/connection/);
    expect(t.captures[0]!.stop).toHaveBeenCalled();
  });

  it("caches the status unless forced", async () => {
    const getStatus = vi.fn(async () => READY_STATUS);
    setup();
    setVoiceDeps({ getStatus });
    await store().loadStatus();
    await store().loadStatus();
    expect(getStatus).toHaveBeenCalledTimes(1);
    await store().loadStatus(true);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});

describe("voice store: graceful stop and microphone loss", () => {
  beforeEach(() => {
    resetVoiceStore();
    onFinal.mockReset();
  });
  afterEach(() => resetVoiceStore());

  it("drains the capture before voice:stop: the last frames go out first", async () => {
    const t = setup();
    await store().start({ mode: "hold", onFinal });
    const c = t.captures[0]!;
    let finishDrain: (() => void) | null = null;
    const drain = vi.fn(
      () =>
        new Promise<Uint8Array<ArrayBuffer> | null>((resolve) => {
          finishDrain = () => {
            c.callbacks.onChunk(new Uint8Array(3200)); // the worklet's last block, delivered while draining
            resolve(new Uint8Array(6));
          };
        }),
    );
    Object.assign(c, { drain });
    store().stop();
    expect(store().state).toBe("transcribing");
    expect(t.sent.at(-1)?.type).toBe("voice:start"); // no voice:stop yet
    finishDrain!();
    await vi.waitFor(() => expect(t.sent.at(-1)).toEqual({ type: "voice:stop", voiceId: "v1" }));
    expect(t.binary).toEqual([3200, 6]);
    expect(c.stop).not.toHaveBeenCalled();
  });

  it("a cancel while draining sends no voice:stop", async () => {
    const t = setup();
    await store().start({ mode: "hold", onFinal });
    let finishDrain: (() => void) | null = null;
    Object.assign(t.captures[0]!, {
      drain: () =>
        new Promise<Uint8Array<ArrayBuffer> | null>((resolve) => {
          finishDrain = () => resolve(null);
        }),
    });
    store().stop();
    store().cancel();
    finishDrain!();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.sent.map((m) => m.type)).toEqual(["voice:start", "voice:cancel"]);
  });

  it("losing the microphone stops the recording with a notice", async () => {
    const t = setup();
    await store().start({ mode: "tap", onFinal });
    t.captures[0]!.callbacks.onEnded?.("The microphone was disconnected.");
    expect(store().state).toBe("transcribing");
    expect(store().notice).toMatch(/microphone was disconnected/);
    expect(t.sent.at(-1)).toEqual({ type: "voice:stop", voiceId: "v1" });
  });

  it("a fallback final (with a notice) shows it and is never auto-submitted", async () => {
    setup();
    useVoiceStore.setState({ status: { ...READY_STATUS, autoSubmit: true } });
    await store().start({ mode: "hold", onFinal });
    store().stop();
    store().applyServerMessage({ type: "voice:final", voiceId: "v1", text: "partial text", notice: "The final transcription failed" });
    expect(onFinal).toHaveBeenCalledWith("partial text", { truncated: false, autoSubmit: false });
    expect(store().notice).toBe("The final transcription failed");
  });
});
