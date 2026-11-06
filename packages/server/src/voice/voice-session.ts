import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cleanWhisperText, type ServerMessage, type VoiceErrorCode } from "@promptgraph/shared";
import { SlotAbortedError, SlotBusyError, type Release, type TranscriptionSlot } from "./slot.js";
import { encodeWav } from "./wav.js";
import { WhisperError, type WhisperRun, type WhisperRunner } from "./whisper.js";

/** Limits of one recording (defaults from the shared constants; tests shrink them). */
export interface VoiceLimits {
  /** PCM cap (VOICE_MAX_AUDIO_BYTES); reaching it ends the recording with voice:final truncated. */
  maxAudioBytes: number;
  /** Largest binary frame (VOICE_MAX_FRAME_BYTES); a bigger one fails the session. */
  maxFrameBytes: number;
  /** New audio between partial passes (VOICE_PARTIAL_INTERVAL_MS of PCM). */
  partialIntervalBytes: number;
  /** Timeout of one whisper run. */
  passTimeoutMs: number;
  /** Wall-clock watchdog while recording (VOICE_WATCHDOG_SECONDS). */
  watchdogMs: number;
  /** How long a final pass waits for the global slot before `busy`. */
  queueWaitMs: number;
}

/** What a session needs to run whisper; resolved asynchronously (probe) after voice:start. */
export interface VoiceSessionConfig {
  bin: string;
  model: string;
  language: string;
  threads?: number;
  prompt?: string;
}

export type VoiceSessionSetup = { ok: true; config: VoiceSessionConfig } | { ok: false; message: string };

export interface VoiceSessionOptions {
  voiceId: string;
  setup: Promise<VoiceSessionSetup>;
  /** Sends a voice:* message to the owning WS client. */
  send(msg: ServerMessage): void;
  /** Called once when the session ends (any way). */
  onEnd(session: VoiceSession): void;
  slot: TranscriptionSlot;
  runner: WhisperRunner;
  tmpDir: string;
  env: NodeJS.ProcessEnv;
  limits: VoiceLimits;
}

type State = "recording" | "stopping" | "ended";

class SessionEnded extends Error {}

/**
 * One recording (§21.5). Keeps the PCM in memory (≤ maxAudioBytes); while recording, after each
 * `partialIntervalBytes` of new audio and when no pass is running (here or globally), transcribes all the audio
 * so far and sends voice:partial. stop() waits for the running pass, runs the final pass and sends voice:final;
 * every session ends with exactly one voice:final or voice:error, except after cancel() (silent).
 */
export class VoiceSession {
  readonly voiceId: string;
  private state: State = "recording";
  private config: VoiceSessionConfig | null = null;
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** Bytes covered by the pass started last (partial). */
  private scheduledBytes = 0;
  /** Result of the last finished pass and how many bytes it covered (lets stop() skip a redundant final pass). */
  private done: { bytes: number; text: string } | null = null;
  private lastPartial: string | null = null;
  private pass: Promise<void> | null = null;
  private current: { run: WhisperRun | null; wavPath: string } | null = null;
  private readonly abort = new AbortController();
  private readonly watchdog: NodeJS.Timeout;
  private readonly ready: Promise<VoiceSessionConfig>;

  constructor(private readonly opts: VoiceSessionOptions) {
    this.voiceId = opts.voiceId;
    this.watchdog = setTimeout(() => {
      if (this.state === "recording") this.fail("too_long", "The recording never stopped; dictation was ended");
    }, opts.limits.watchdogMs);
    this.watchdog.unref();
    this.ready = opts.setup.then((setup) => {
      if (this.state === "ended") throw new SessionEnded();
      if (!setup.ok) {
        this.fail("unavailable", setup.message);
        throw new SessionEnded();
      }
      this.config = setup.config;
      this.maybePartial();
      return setup.config;
    });
    // Rejections are handled where `ready` is awaited (stop); avoid an unhandled rejection meanwhile.
    this.ready.catch(() => {});
  }

  get ended(): boolean {
    return this.state === "ended";
  }

  /** Bytes of PCM received so far (tests). */
  get audioBytes(): number {
    return this.bytes;
  }

  /** A binary frame of LE Int16 mono 16 kHz PCM. Ignored unless recording. */
  pushAudio(frame: Buffer): void {
    if (this.state !== "recording") return;
    if (frame.length > this.opts.limits.maxFrameBytes) return this.fail("failed", "Audio frame too large");
    const room = this.opts.limits.maxAudioBytes - this.bytes;
    const take = frame.length > room ? frame.subarray(0, room) : frame;
    if (take.length) {
      // Copy: `ws` may reuse the frame's memory.
      this.chunks.push(Buffer.from(take));
      this.bytes += take.length;
    }
    if (this.bytes >= this.opts.limits.maxAudioBytes) return this.stop(true);
    this.maybePartial();
  }

  /** Ends the recording: final pass → voice:final (truncated when the cap stopped it). */
  stop(truncated = false): void {
    if (this.state !== "recording") return;
    this.state = "stopping";
    clearTimeout(this.watchdog);
    void this.finish(truncated);
  }

  /** Drops the recording silently: kills whisper, deletes the temp file, frees the buffer. */
  cancel(): void {
    this.end();
  }

  /** Ends the session with voice:error (e.g. `cancelled` on shutdown). */
  fail(code: VoiceErrorCode, message: string): void {
    if (this.state === "ended") return;
    this.opts.send({ type: "voice:error", voiceId: this.voiceId, code, message });
    this.end();
  }

  private async finish(truncated: boolean): Promise<void> {
    try {
      await this.ready;
      if (this.pass) await this.pass;
      if (this.state !== "stopping") return;
      let text: string;
      if (this.bytes < 2) text = "";
      else if (this.done && this.done.bytes === this.bytes) text = this.done.text;
      else {
        const release = await this.opts.slot.acquire(this.opts.limits.queueWaitMs, this.abort.signal);
        text = await this.transcribe(this.bytes, release);
      }
      if (this.state !== "stopping") return;
      this.opts.send({ type: "voice:final", voiceId: this.voiceId, text, ...(truncated ? { truncated: true } : {}) });
      this.end();
    } catch (err) {
      this.onFinalError(err);
    }
  }

  private maybePartial(): void {
    if (this.state !== "recording" || !this.config || this.pass) return;
    if (this.bytes - this.scheduledBytes < this.opts.limits.partialIntervalBytes) return;
    const release = this.opts.slot.tryAcquire();
    if (!release) return; // another session is transcribing: try again after more audio
    const bytes = this.bytes;
    this.scheduledBytes = bytes;
    this.pass = this.transcribe(bytes, release)
      .then((text) => {
        if (this.state === "recording" && text !== this.lastPartial) {
          this.lastPartial = text;
          this.opts.send({ type: "voice:partial", voiceId: this.voiceId, text });
        }
      })
      // A partial is only a lagging preview (§21.5): a failed or timed-out one never ends the recording. Only
      // the final pass decides; a busy slot or an abort here is just a skipped preview.
      .catch((err) => this.onPartialError(err))
      .finally(() => {
        this.pass = null;
        this.maybePartial();
      });
  }

  /** One whisper run over the first `bytes` of PCM. Always releases the slot and deletes the WAV. */
  private async transcribe(bytes: number, release: Release): Promise<string> {
    const config = this.config!;
    const { tmpDir } = this.opts;
    const wavPath = path.join(tmpDir, `voice-${randomUUID()}.wav`);
    this.current = { run: null, wavPath };
    try {
      if (this.state === "ended") throw new SessionEnded();
      if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
      const pcm = (this.chunks[0] ?? Buffer.alloc(0)).subarray(0, bytes);
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(wavPath, encodeWav(pcm), { mode: 0o600, flag: "wx" });
      const run = this.opts.runner({
        bin: config.bin,
        model: config.model,
        wavPath,
        language: config.language,
        threads: config.threads,
        prompt: config.prompt,
        timeoutMs: this.opts.limits.passTimeoutMs,
        env: this.opts.env,
      });
      this.current.run = run;
      const text = cleanWhisperText(await run.result);
      this.done = { bytes, text };
      return text;
    } finally {
      this.current = null;
      removeFile(wavPath);
      release();
    }
  }

  private onPartialError(err: unknown): void {
    if (this.state === "ended" || err instanceof SessionEnded || err instanceof SlotAbortedError || err instanceof SlotBusyError) return;
    // Anything else (timeout, non-zero exit): keep recording; the next partial or the final pass retries.
  }

  /** Final pass failed: fall back to the last good partial (with a notice) rather than losing the dictation. */
  private onFinalError(err: unknown): void {
    if (this.state === "ended" || err instanceof SessionEnded || err instanceof SlotAbortedError) return;
    if (err instanceof WhisperError && err.kind === "cancelled") return;
    if (this.done && this.done.text) {
      const why = err instanceof Error ? err.message : String(err);
      this.opts.send({ type: "voice:final", voiceId: this.voiceId, text: this.done.text, notice: `The final transcription failed (${why}); this is the last preview.` });
      this.end();
      return;
    }
    this.onPassError(err);
  }

  private onPassError(err: unknown): void {
    if (this.state === "ended" || err instanceof SessionEnded || err instanceof SlotAbortedError) return;
    if (err instanceof WhisperError && err.kind === "cancelled") return;
    if (err instanceof SlotBusyError) return this.fail("busy", err.message);
    this.fail("failed", err instanceof Error ? err.message : String(err));
  }

  private end(): void {
    if (this.state === "ended") return;
    this.state = "ended";
    clearTimeout(this.watchdog);
    this.abort.abort();
    if (this.current) {
      this.current.run?.kill();
      removeFile(this.current.wavPath);
    }
    this.chunks = [];
    this.bytes = 0;
    this.done = null;
    this.lastPartial = null;
    this.opts.onEnd(this);
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort: the shutdown sweep removes leftovers.
  }
}
