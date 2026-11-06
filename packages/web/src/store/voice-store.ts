import {
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  VOICE_SILENCE_STOP_SECONDS,
  sanitizeKeyterms,
  type ClientMessage,
  type ServerMessage,
  type VoiceErrorCode,
  type VoiceMode,
  type VoiceStatus,
} from "@promptgraph/shared";
import { create } from "zustand";
import { daemonApi, errorMessage } from "../api/rest";
import { wsClient } from "../api/ws";
import { micErrorFrom, startMicCapture, type CaptureHandle, type StartCapture } from "../lib/voice/capture";
import { SPEECH_RMS_THRESHOLD } from "../lib/voice/pcm";

/**
 * Voice dictation in the chat composer (DESIGN §22): the status from GET /api/voice and the state machine of one
 * recording. Audio goes to the server as binary WS frames; voice:partial / voice:final / voice:error come back
 * through handleServerMessage. One recording at a time (the server allows one per WS client too).
 *
 *   idle → requesting_mic → recording → transcribing → idle
 *                 ↘ error         ↘ (cancel) idle   ↘ error
 */

export type DictationState = "idle" | "requesting_mic" | "recording" | "transcribing" | "error";

export interface DictationResult {
  /** The recording reached the 2-minute cap and was stopped (by the server or the client). */
  truncated: boolean;
  /** voice.autoSubmit as resolved by the server: send the message right away. */
  autoSubmit: boolean;
}

export interface StartDictationOptions {
  mode: VoiceMode;
  keyterms?: readonly string[];
  /** Receives the final transcript (possibly empty) once. Not called after cancel or on error. */
  onFinal: (text: string, result: DictationResult) => void;
}

export interface VoiceDeps {
  /** GET /api/voice; `refresh` skips the server-side probe cache. */
  getStatus(refresh?: boolean): Promise<VoiceStatus>;
  /** JSON client message; false when the socket is down. */
  send(msg: ClientMessage): boolean;
  /** Binary audio frame; false when the socket is down. */
  sendBinary(bytes: Uint8Array<ArrayBuffer>): boolean;
  startCapture: StartCapture;
  newId(): string;
  now(): number;
}

let deps: VoiceDeps = {
  getStatus: (refresh) => daemonApi.voiceStatus(refresh),
  send: (msg) => {
    if (!wsClient.isOpen()) return false;
    wsClient.send(msg);
    return true;
  },
  sendBinary: (bytes) => wsClient.sendBinary(bytes),
  startCapture: startMicCapture,
  newId: () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`),
  now: () => Date.now(),
};

/** Test seam. */
export function setVoiceDeps(d: Partial<VoiceDeps>): void {
  deps = { ...deps, ...d };
}

const TICK_MS = 250;
const SILENCE_MS = VOICE_SILENCE_STOP_SECONDS * 1000;
const MAX_MS = VOICE_MAX_SECONDS * 1000;

export interface VoiceState {
  /** Last GET /api/voice answer; null until fetched (or when the fetch failed). */
  status: VoiceStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  state: DictationState;
  /** voiceId of the recording in progress (requesting_mic, recording, transcribing). */
  voiceId: string | null;
  /** Mode of the recording in progress. */
  mode: VoiceMode | null;
  /** Latest voice:partial (the whole transcript so far). */
  partial: string;
  /** RMS level of the last audio block (0..1). */
  level: number;
  startedAt: number | null;
  elapsedMs: number;
  /** Set in the `error` state. */
  error: string | null;
  /** Informational message about the last recording (auto-stop, 2-minute cap, nothing recognised). */
  notice: string | null;
}

export interface VoiceStore extends VoiceState {
  /** Fetches GET /api/voice; without `force` a cached answer is reused. */
  loadStatus(force?: boolean): Promise<VoiceStatus | null>;
  /** Asks for the microphone and starts streaming. Resolves false when it did not start. */
  start(opts: StartDictationOptions): Promise<boolean>;
  /** Ends the recording: the server transcribes all of it and answers voice:final. */
  stop(reason?: string): void;
  /** Drops the recording (no transcript). */
  cancel(): void;
  /** Clears the error / notice. */
  dismiss(): void;
  /** Shows an informational notice about the last recording (e.g. an autoSubmit that could not send). */
  setNotice(notice: string | null): void;
  applyServerMessage(msg: ServerMessage): void;
  /** The WS went down: an active recording cannot finish. */
  connectionLost(): void;
}

const initial: VoiceState = {
  status: null,
  statusLoading: false,
  statusError: null,
  state: "idle",
  voiceId: null,
  mode: null,
  partial: "",
  level: 0,
  startedAt: null,
  elapsedMs: 0,
  error: null,
  notice: null,
};

// Per-recording resources: not state (React never renders them).
let capture: CaptureHandle | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let onFinal: StartDictationOptions["onFinal"] | null = null;
let lastSpeechAt = 0;
/** Bumped by every start / cancel: a start that resolves after it was superseded releases its microphone. */
let attempt = 0;
/** Attempt whose capture is draining (stop in progress): its last frames still go out before voice:stop. */
let drainingAttempt = -1;
let statusRequest: Promise<VoiceStatus | null> | null = null;

function releaseCapture(): Uint8Array<ArrayBuffer> | null {
  if (ticker) clearInterval(ticker);
  ticker = null;
  const handle = capture;
  capture = null;
  return handle ? handle.stop() : null;
}

const ERROR_TEXT: Record<VoiceErrorCode, string> = {
  unavailable: "Voice dictation is unavailable",
  too_long: "The recording ran too long and was stopped",
  failed: "Transcription failed",
  busy: "Another transcription is running; try again in a moment",
  cancelled: "The dictation was cancelled by the server",
};

export function isDictationActive(state: DictationState): boolean {
  return state === "requesting_mic" || state === "recording" || state === "transcribing";
}

export const useVoiceStore = create<VoiceStore>()((set, get) => ({
  ...initial,

  loadStatus(force = false) {
    if (!force && get().status) return Promise.resolve(get().status);
    if (statusRequest && !force) return statusRequest;
    set({ statusLoading: true });
    const req = deps
      .getStatus(force)
      .then((status) => {
        if (statusRequest === req) set({ status, statusLoading: false, statusError: null });
        return status;
      })
      .catch((err: unknown) => {
        if (statusRequest === req) set({ statusLoading: false, statusError: errorMessage(err) });
        return null;
      })
      .finally(() => {
        if (statusRequest === req) statusRequest = null;
      });
    statusRequest = req;
    return req;
  },

  async start(opts) {
    if (isDictationActive(get().state)) return false;
    const my = ++attempt;
    const voiceId = deps.newId();
    onFinal = opts.onFinal;
    set({ state: "requesting_mic", voiceId, mode: opts.mode, partial: "", level: 0, startedAt: null, elapsedMs: 0, error: null, notice: null });

    // Frames captured before voice:start is on the wire wait here, so the server never sees orphan audio.
    let streaming = false;
    const early: Uint8Array<ArrayBuffer>[] = [];
    let handle: CaptureHandle;
    try {
      handle = await deps.startCapture({
        onChunk: (bytes) => {
          if (my !== attempt) return;
          if (!streaming) early.push(bytes);
          else if (get().state === "recording" || drainingAttempt === my) deps.sendBinary(bytes);
        },
        onEnded: (message) => {
          if (my !== attempt || get().state !== "recording") return;
          get().stop(`${message} Transcribing what was recorded.`);
        },
        onLevel: (level) => {
          if (my !== attempt) return;
          if (level >= SPEECH_RMS_THRESHOLD) lastSpeechAt = deps.now();
          set({ level });
        },
      });
    } catch (err) {
      if (my !== attempt) return false;
      onFinal = null;
      set({ state: "error", voiceId: null, mode: null, error: micErrorFrom(err).message });
      return false;
    }
    if (my !== attempt) {
      // Cancelled (or released) while the browser was asking for the microphone.
      handle.stop();
      return false;
    }
    capture = handle;
    const keyterms = sanitizeKeyterms(opts.keyterms ?? []);
    const sent = deps.send({ type: "voice:start", voiceId, sampleRate: VOICE_SAMPLE_RATE, ...(keyterms.length ? { keyterms } : {}) });
    if (!sent) {
      releaseCapture();
      onFinal = null;
      set({ state: "error", voiceId: null, mode: null, error: "Not connected to the promptgraph server." });
      return false;
    }
    const now = deps.now();
    lastSpeechAt = now;
    set({ state: "recording", startedAt: now, elapsedMs: 0 });
    streaming = true;
    for (const bytes of early.splice(0)) deps.sendBinary(bytes);
    ticker = setInterval(() => {
      const s = get();
      if (s.state !== "recording" || s.startedAt === null) return;
      const t = deps.now();
      const elapsedMs = t - s.startedAt;
      set({ elapsedMs });
      if (elapsedMs >= MAX_MS) get().stop(`Recording stopped at the ${VOICE_MAX_SECONDS / 60}-minute limit.`);
      else if (t - lastSpeechAt >= SILENCE_MS) get().stop(`Recording stopped after ${VOICE_SILENCE_STOP_SECONDS} s of silence.`);
    }, TICK_MS);
    return true;
  },

  stop(reason) {
    const s = get();
    if (s.state === "requesting_mic") {
      get().cancel();
      return;
    }
    if (s.state !== "recording" || !s.voiceId) return;
    const voiceId = s.voiceId;
    const sendStop = () => {
      if (!deps.send({ type: "voice:stop", voiceId })) {
        onFinal = null;
        set({ state: "error", voiceId: null, mode: null, level: 0, partial: "", error: "Not connected to the promptgraph server: the dictation was lost." });
        return false;
      }
      return true;
    };
    const handle = capture;
    if (handle?.drain) {
      // Graceful: the worklet's last block and the frames still queued are sent before voice:stop, so the last
      // syllable of a hold released right at the end of a word is not clipped.
      const my = attempt;
      if (ticker) clearInterval(ticker);
      ticker = null;
      capture = null;
      drainingAttempt = my;
      set({ state: "transcribing", level: 0, ...(reason ? { notice: reason } : {}) });
      void handle
        .drain()
        .catch(() => handle.stop())
        .then((tail) => {
          if (drainingAttempt === my) drainingAttempt = -1;
          if (my !== attempt) return; // cancelled meanwhile
          if (tail) deps.sendBinary(tail);
          sendStop();
        });
      return;
    }
    const tail = releaseCapture();
    if (tail) deps.sendBinary(tail);
    if (!sendStop()) return;
    set({ state: "transcribing", level: 0, ...(reason ? { notice: reason } : {}) });
  },

  cancel() {
    attempt++;
    const s = get();
    releaseCapture();
    onFinal = null;
    if (s.voiceId && (s.state === "recording" || s.state === "transcribing")) deps.send({ type: "voice:cancel", voiceId: s.voiceId });
    if (isDictationActive(s.state)) set({ state: "idle", voiceId: null, mode: null, partial: "", level: 0, startedAt: null, elapsedMs: 0 });
  },

  setNotice(notice) {
    set({ notice });
  },

  dismiss() {
    const s = get();
    set({ error: null, notice: null, ...(s.state === "error" ? { state: "idle" as const } : {}) });
  },

  applyServerMessage(msg) {
    if (msg.type !== "voice:partial" && msg.type !== "voice:final" && msg.type !== "voice:error") return;
    const s = get();
    if (!s.voiceId || msg.voiceId !== s.voiceId) return;
    if (msg.type === "voice:partial") {
      if (s.state === "recording" || s.state === "transcribing") set({ partial: msg.text });
      return;
    }
    attempt++;
    releaseCapture();
    const handler = onFinal;
    onFinal = null;
    const reset = { voiceId: null, mode: null, partial: "", level: 0, startedAt: null, elapsedMs: 0 } as const;
    if (msg.type === "voice:error") {
      set({ ...reset, state: "error", error: `${ERROR_TEXT[msg.code]}${msg.message ? `: ${msg.message}` : "."}` });
      if (msg.code === "unavailable") void get().loadStatus(true);
      return;
    }
    const truncated = msg.truncated === true;
    const text = msg.text.trim();
    const notice = msg.notice
      ? msg.notice
      : truncated
        ? `Recording stopped at the ${VOICE_MAX_SECONDS / 60}-minute limit.`
        : !text
          ? "No speech was recognised."
          : s.notice;
    set({ ...reset, state: "idle", notice });
    // A fallback transcript (msg.notice: the final pass failed) is never auto-sent: the user reviews it first.
    handler?.(text, { truncated, autoSubmit: !msg.notice && (get().status?.autoSubmit ?? false) });
  },

  connectionLost() {
    const s = get();
    if (!isDictationActive(s.state)) return;
    attempt++;
    releaseCapture();
    onFinal = null;
    set({ state: "error", voiceId: null, mode: null, partial: "", level: 0, startedAt: null, elapsedMs: 0, error: "The connection to the promptgraph server was lost: the dictation was cancelled." });
  },
}));

/** Test helper: back to the initial state, releasing anything held. */
export function resetVoiceStore(): void {
  attempt++;
  drainingAttempt = -1;
  releaseCapture();
  onFinal = null;
  statusRequest = null;
  useVoiceStore.setState({ ...initial });
}
