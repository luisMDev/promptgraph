import { PcmChunker, PcmResampler, rms } from "./pcm";

/**
 * Microphone capture of voice dictation (DESIGN §22): getUserMedia → AudioContext → the `pg-pcm-capture` worklet,
 * whose Float32 blocks are resampled to 16 kHz Int16 and grouped into ~100 ms little-endian frames for the WS.
 */

export interface CaptureCallbacks {
  /** One binary frame (LE Int16 mono PCM, 16 kHz, ~100 ms). */
  onChunk(bytes: Uint8Array<ArrayBuffer>): void;
  /** RMS level (0..1) of each block, for the meter and the silence auto-stop. */
  onLevel(level: number): void;
  /**
   * The microphone went away mid-recording (track ended: unplugged, Bluetooth dropped, permission revoked; or the
   * AudioContext was closed / interrupted / could not resume). Called at most once, never after stop/drain.
   */
  onEnded?(message: string): void;
}

export interface CaptureHandle {
  /** Stops capturing at once and releases the microphone (tracks stopped, AudioContext closed). Returns the last partial frame. */
  stop(): Uint8Array<ArrayBuffer> | null;
  /**
   * Graceful stop: asks the worklet for the block it is filling, waits for it and the blocks still queued on the
   * port (bounded by DRAIN_TIMEOUT_MS), delivers them through onChunk, then releases the microphone like stop().
   * Resolves with the last partial frame. Optional: a capture without it is stopped with stop().
   */
  drain?(): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** Longest wait for the worklet's flush acknowledgement on drain. */
export const DRAIN_TIMEOUT_MS = 250;

export type StartCapture = (callbacks: CaptureCallbacks) => Promise<CaptureHandle>;

/** Thrown when capture cannot start; `kind` drives the message shown in the composer. */
export class MicError extends Error {
  constructor(
    readonly kind: "denied" | "no_device" | "unsupported" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export function micErrorFrom(err: unknown): MicError {
  if (err instanceof MicError) return err;
  const name = err instanceof Error || (typeof DOMException !== "undefined" && err instanceof DOMException) ? (err as Error).name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return new MicError("denied", "Microphone access was denied. Allow it for this page in the browser's site settings and try again.");
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError")
    return new MicError("no_device", "No microphone was found.");
  if (name === "NotReadableError" || name === "TrackStartError")
    return new MicError("failed", "The microphone is in use by another application or could not be started.");
  return new MicError("failed", `Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`);
}

const WORKLET_NAME = "pg-pcm-capture";

/** Real capture: microphone + AudioWorklet. Throws a MicError when it cannot start. */
export const startMicCapture: StartCapture = async ({ onChunk, onLevel, onEnded }) => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
    throw new MicError("unsupported", "This browser cannot capture audio (getUserMedia / AudioWorklet unavailable).");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    throw micErrorFrom(err);
  }
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL("./pcm-capture.worklet.js", import.meta.url));
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
    // A muted sink keeps the graph pulling audio through the worklet in every browser.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const resampler = new PcmResampler(ctx.sampleRate);
    const chunker = new PcmChunker();
    let stopped = false;
    let ended = false;
    let flushed: (() => void) | null = null;
    node.port.onmessage = (ev: MessageEvent<unknown>) => {
      if (stopped) return;
      const data = ev.data;
      if (data instanceof Float32Array) {
        onLevel(rms(data));
        for (const frame of chunker.push(resampler.push(data))) onChunk(frame);
      } else if (data && typeof data === "object" && (data as { type?: unknown }).type === "flushed") {
        flushed?.();
      }
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const context = ctx;

    const lost = (message: string) => {
      if (stopped || ended) return;
      ended = true;
      onEnded?.(message);
    };
    const onTrackEnded = () => lost("The microphone was disconnected.");
    const tracks = stream.getTracks();
    for (const track of tracks) track.addEventListener?.("ended", onTrackEnded);
    context.onstatechange = () => {
      if (stopped) return;
      const state = context.state as string;
      if (state === "closed" || state === "interrupted") lost("Audio capture was interrupted by the browser or the system.");
      else if (state === "suspended") {
        context.resume().then(
          () => {
            if ((context.state as string) !== "running") lost("Audio capture was suspended by the browser.");
          },
          () => lost("Audio capture was suspended by the browser."),
        );
      }
    };

    const release = () => {
      stopped = true;
      node.port.onmessage = null;
      context.onstatechange = null;
      for (const track of tracks) track.removeEventListener?.("ended", onTrackEnded);
      try {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        // Already disconnected.
      }
      for (const track of tracks) track.stop();
      void context.close().catch(() => undefined);
    };

    let draining: Promise<Uint8Array<ArrayBuffer> | null> | null = null;
    return {
      stop() {
        if (stopped) return null;
        release();
        return chunker.flush();
      },
      drain() {
        if (draining) return draining;
        if (stopped) return Promise.resolve(null);
        draining = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          flushed = () => {
            clearTimeout(timer);
            resolve();
          };
          try {
            node.port.postMessage({ type: "flush" });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        }).then(() => {
          if (stopped) return null;
          for (const frame of chunker.push(resampler.flush())) onChunk(frame);
          release();
          return chunker.flush();
        });
        return draining;
      },
    };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    void ctx?.close().catch(() => undefined);
    throw err instanceof MicError ? err : new MicError("failed", `Could not start audio capture: ${err instanceof Error ? err.message : String(err)}`);
  }
};
