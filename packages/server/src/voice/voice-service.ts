import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findVoiceModel,
  readClaudeVoicePreferences,
  resolveVoicePreferences,
  sanitizeKeyterms,
  VOICE_BYTES_PER_SAMPLE,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_FRAME_BYTES,
  VOICE_PARTIAL_INTERVAL_MS,
  VOICE_PASS_TIMEOUT_MS,
  VOICE_SAMPLE_RATE,
  VOICE_SETUP_INSTRUCTIONS,
  VOICE_STATUS_CACHE_MS,
  VOICE_WATCHDOG_SECONDS,
  VOICE_WHISPER_BINARIES,
  whisperPromptFromKeyterms,
  type AppSettings,
  type ServerMessage,
  type VoiceSettings,
  type VoiceStatus,
} from "@promptgraph/shared";
import { claudeUserSettingsFile, type PgPaths } from "../config/paths.js";
import { TranscriptionSlot } from "./slot.js";
import { VoiceSession, type VoiceLimits, type VoiceSessionSetup } from "./voice-session.js";
import { findOnPath, isExecutableFile, isReadableFile, smokeTestWhisper, spawnWhisper, type WhisperRunner } from "./whisper.js";

export const DEFAULT_VOICE_LIMITS: VoiceLimits = {
  maxAudioBytes: VOICE_MAX_AUDIO_BYTES,
  maxFrameBytes: VOICE_MAX_FRAME_BYTES,
  partialIntervalBytes: (VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE * VOICE_PARTIAL_INTERVAL_MS) / 1000,
  passTimeoutMs: VOICE_PASS_TIMEOUT_MS,
  watchdogMs: VOICE_WATCHDOG_SECONDS * 1000,
  queueWaitMs: VOICE_PASS_TIMEOUT_MS,
};

const SMOKE_TIMEOUT_MS = 5000;
/** `?refresh=1` re-probes at most this often; faster refreshes share the probe in flight or just done. */
const MIN_REFRESH_INTERVAL_MS = 1000;
/** Per-instance temp dir under PgPaths.tmpDir: `voice-<pid>-<random>`. */
const INSTANCE_DIR = /^voice-(\d+)-[0-9a-f]+$/;
/** Loose `voice-*.wav` directly in tmpDir (layout before per-instance dirs): removed once this old. */
const LOOSE_WAV = /^voice-.+\.wav$/;
/** Final passes waiting for the global slot; beyond this, `busy`. */
const MAX_QUEUED_PASSES = 4;

export interface VoiceServiceOptions {
  settings: { get(): AppSettings };
  paths: Pick<PgPaths, "tmpDir" | "modelsDir">;
  /** Base env: PATH for the binary lookup, CLAUDE_CONFIG_DIR, and the whisper child's env. */
  env: NodeJS.ProcessEnv;
  /** Home of `~/whisper.cpp/models` and `~/.claude/settings.json` (tests inject a temp dir). */
  homeDir?: string;
  /** Whisper runner (tests); defaults to spawning the binary. */
  runner?: WhisperRunner;
  limits?: Partial<VoiceLimits>;
  statusCacheMs?: number;
}

export interface StartVoiceOptions {
  voiceId: string;
  keyterms?: readonly string[];
  /** Overrides the resolved language for this recording. */
  language?: string;
  send(msg: ServerMessage): void;
  onEnd?(session: VoiceSession): void;
}

/**
 * Voice dictation (§22): probes whisper.cpp (binary, model, `--help` smoke; cached), resolves the defaults
 * (promptgraph settings > Claude Code settings > fallback) for GET /api/voice, and creates one VoiceSession per
 * recording, sharing a global transcription slot (one whisper process at a time).
 */
export class VoiceService {
  readonly limits: VoiceLimits;
  private readonly slot = new TranscriptionSlot(MAX_QUEUED_PASSES);
  private readonly sessions = new Set<VoiceSession>();
  private readonly runner: WhisperRunner;
  private readonly homeDir: string;
  private readonly cacheMs: number;
  private cache: { key: string; at: number; pending: boolean; status: Promise<VoiceStatus> } | null = null;
  private lastRefreshAt = 0;
  /**
   * This instance's private temp dir (`<tmpDir>/voice-<pid>-<random>`). Several servers (one per repository)
   * share PgPaths.tmpDir, so each one only ever deletes its own WAVs, plus the dirs of servers that are gone.
   */
  readonly tempDir: string;

  constructor(private readonly opts: VoiceServiceOptions) {
    this.limits = { ...DEFAULT_VOICE_LIMITS, ...opts.limits };
    this.runner = opts.runner ?? spawnWhisper;
    this.homeDir = opts.homeDir ?? os.homedir();
    this.cacheMs = opts.statusCacheMs ?? VOICE_STATUS_CACHE_MS;
    this.tempDir = path.join(opts.paths.tmpDir, `voice-${process.pid}-${randomBytes(4).toString("hex")}`);
    // At startup: audio left behind by a server that crashed mid-pass must not wait for the next dictation.
    this.sweepTmp();
  }

  /**
   * GET /api/voice. Cached for VOICE_STATUS_CACHE_MS per `voice` settings value. `refresh` re-probes, but
   * concurrent or rapid refreshes (under MIN_REFRESH_INTERVAL_MS) share one probe: each probe spawns
   * `whisper-cli --help`, so a burst of requests never becomes a burst of processes.
   */
  status(opts: { refresh?: boolean } = {}): Promise<VoiceStatus> {
    const voice = this.opts.settings.get().voice;
    const key = JSON.stringify(voice ?? {});
    const now = Date.now();
    const cached = this.cache && this.cache.key === key ? this.cache : null;
    if (cached) {
      if (!opts.refresh && now - cached.at < this.cacheMs) return cached.status;
      if (opts.refresh && (cached.pending || now - this.lastRefreshAt < MIN_REFRESH_INTERVAL_MS)) return cached.status;
    }
    if (opts.refresh) this.lastRefreshAt = now;
    const entry = { key, at: now, pending: true, status: this.probe(voice) };
    void entry.status.finally(() => (entry.pending = false)).catch(() => {});
    this.cache = entry;
    return entry.status;
  }

  /** Starts a recording; the caller routes binary frames and stop/cancel to the returned session. */
  start(opts: StartVoiceOptions): VoiceSession {
    const keyterms = sanitizeKeyterms(opts.keyterms);
    const setup: Promise<VoiceSessionSetup> = this.status().then((s) =>
      s.available && s.whisperBin && s.model
        ? {
            ok: true,
            config: {
              bin: s.whisperBin,
              model: s.model,
              language: opts.language ?? s.language,
              threads: s.threads,
              prompt: whisperPromptFromKeyterms(keyterms),
            },
          }
        : { ok: false, message: unavailableMessage(s) },
    );
    const session = new VoiceSession({
      voiceId: opts.voiceId,
      setup: setup.catch((err: unknown) => ({ ok: false, message: `Voice dictation is unavailable: ${String(err)}` })),
      send: opts.send,
      onEnd: (s) => {
        this.sessions.delete(s);
        opts.onEnd?.(s);
      },
      slot: this.slot,
      runner: this.runner,
      tmpDir: this.tempDir,
      env: this.opts.env,
      limits: this.limits,
    });
    if (!session.ended) this.sessions.add(session);
    return session;
  }

  /** Active recordings (tests, shutdown). */
  get activeSessions(): number {
    return this.sessions.size;
  }

  /** Graceful shutdown: ends every session with `cancelled` (killing whisper) and deletes leftover temp files. */
  async shutdown(): Promise<void> {
    for (const s of [...this.sessions]) s.fail("cancelled", "The promptgraph server is shutting down");
    this.sessions.clear();
    removeTree(this.tempDir);
    this.sweepTmp();
  }

  private async probe(voice: VoiceSettings | undefined): Promise<VoiceStatus> {
    const prefs = resolveVoicePreferences(voice, readClaudeVoicePreferences(this.readClaudeSettings()));
    const base: VoiceStatus = {
      available: false,
      mode: prefs.mode,
      language: prefs.language,
      autoSubmit: prefs.autoSubmit,
      ...(voice?.threads !== undefined ? { threads: voice.threads } : {}),
      setup: [...VOICE_SETUP_INSTRUCTIONS],
      defaultsFrom: prefs.defaultsFrom,
    };

    let whisperBin: string | null;
    let whisperBinFrom: "promptgraph" | "path";
    if (voice?.whisperBin) {
      whisperBinFrom = "promptgraph";
      whisperBin = isExecutableFile(voice.whisperBin) ? voice.whisperBin : null;
      if (!whisperBin) {
        return { ...base, reason: "binary_not_found", detail: `${voice.whisperBin} does not exist or is not executable` };
      }
    } else {
      whisperBinFrom = "path";
      whisperBin = findOnPath(VOICE_WHISPER_BINARIES, this.opts.env.PATH);
      if (!whisperBin) return { ...base, reason: "binary_not_found", detail: `Neither ${VOICE_WHISPER_BINARIES.join(" nor ")} was found on PATH` };
    }
    const withBin = { ...base, whisperBin, whisperBinFrom };

    let model: string | null;
    let modelFrom: "promptgraph" | "detected";
    if (voice?.model) {
      modelFrom = "promptgraph";
      model = isReadableFile(voice.model) ? voice.model : null;
      if (!model) return { ...withBin, reason: "model_not_found", detail: `${voice.model} does not exist or is not readable` };
    } else {
      modelFrom = "detected";
      const search = {
        promptgraphModelsDir: this.opts.paths.modelsDir,
        whisperCppModelsDir: path.join(this.homeDir, "whisper.cpp", "models"),
        listDir: (dir: string) => fs.readdirSync(dir),
      };
      model = findVoiceModel(search);
      if (!model) {
        return {
          ...withBin,
          reason: "model_not_found",
          detail: `No ggml-*.bin model in ${search.promptgraphModelsDir} or ${search.whisperCppModelsDir}`,
        };
      }
    }
    const withModel = { ...withBin, model, modelFrom };

    const smoke = await smokeTestWhisper(whisperBin, this.opts.env, SMOKE_TIMEOUT_MS);
    if (smoke) return { ...withModel, reason: "binary_failed", detail: smoke };
    return { ...withModel, available: true };
  }

  /** Parsed Claude Code user settings, or null (missing/invalid file: ignored). Read-only. */
  private readClaudeSettings(): unknown {
    try {
      return JSON.parse(fs.readFileSync(claudeUserSettingsFile(this.opts.env, this.homeDir), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Removes audio left behind by servers that are gone (a crash or SIGKILL mid-pass): `voice-<pid>-*` dirs whose
   * pid is no longer running, and loose `voice-*.wav` older than two pass timeouts. Never touches the dir of a
   * live server, so concurrent instances cannot delete each other's in-flight WAVs. Best effort: never throws.
   */
  private sweepTmp(): void {
    const root = this.opts.paths.tmpDir;
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of entries) {
      const full = path.join(root, name);
      if (full === this.tempDir) continue;
      const instance = INSTANCE_DIR.exec(name);
      if (instance) {
        if (!processAlive(Number(instance[1]))) removeTree(full);
      } else if (LOOSE_WAV.test(name)) {
        try {
          if (now - fs.statSync(full).mtimeMs > 2 * this.limits.passTimeoutMs) fs.rmSync(full, { force: true });
        } catch {
          // Unremovable or vanished: leave it.
        }
      }
    }
  }
}

/** True when `pid` runs (EPERM: it runs as another user). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function unavailableMessage(s: VoiceStatus): string {
  const why =
    s.reason === "binary_not_found"
      ? "whisper-cli was not found"
      : s.reason === "model_not_found"
        ? "no whisper model was found"
        : s.reason === "binary_failed"
          ? "whisper-cli does not run"
          : "whisper.cpp is not set up";
  return `Voice dictation is unavailable: ${why}${s.detail ? ` (${s.detail})` : ""}`;
}
