import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppSettingsSchema, VOICE_SETUP_INSTRUCTIONS, type ServerMessage, type VoiceSettings } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptionSlot } from "../src/voice/slot.js";
import { VoiceService, type VoiceServiceOptions } from "../src/voice/voice-service.js";
import type { VoiceSession } from "../src/voice/voice-session.js";
import { encodeWav, wavHeader } from "../src/voice/wav.js";
import { whisperArgs } from "../src/voice/whisper.js";
import { tempDir, waitFor } from "./helpers.js";

const FAKE_WHISPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-whisper-cli");
/** PATH for the fake's `#!/usr/bin/env node`; never used for the whisper lookup (whisperBin is configured). */
const NODE_PATH = path.dirname(process.execPath);
/** 100 ms of 16 kHz Int16 mono. */
const CHUNK = 3200;

let root: string;
let cleanup: () => void;
let model: string;
let log: string;
let services: VoiceService[];

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("pg-voice-"));
  model = path.join(root, "models", "ggml-small.bin");
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, "fake model");
  log = path.join(root, "whisper.log");
  services = [];
});

afterEach(async () => {
  for (const s of services) await s.shutdown();
  cleanup();
});

interface Harness {
  service: VoiceService;
  /** This service's private temp dir (where its WAVs go). */
  tmpDir: string;
  /** The shared PgPaths.tmpDir. */
  sharedTmp: string;
}

function makeService(
  voice: VoiceSettings | undefined,
  env: Record<string, string> = {},
  extra: Partial<VoiceServiceOptions> = {},
): Harness {
  const tmpDir = path.join(root, "pg-home", "tmp");
  const service = new VoiceService({
    settings: { get: () => AppSettingsSchema.parse(voice ? { voice } : {}) },
    paths: { tmpDir, modelsDir: path.join(root, "pg-home", "models") },
    env: { PATH: NODE_PATH, FAKE_WHISPER_LOG: log, ...env },
    homeDir: path.join(root, "home"),
    statusCacheMs: 0,
    ...extra,
  });
  services.push(service);
  return { service, tmpDir: service.tempDir, sharedTmp: tmpDir };
}

const configured = (more: VoiceSettings = {}): VoiceSettings => ({ whisperBin: FAKE_WHISPER, model, ...more });

function record(service: VoiceService, opts: { keyterms?: string[]; language?: string } = {}) {
  const messages: ServerMessage[] = [];
  let ended = false;
  const session = service.start({ voiceId: "v1", ...opts, send: (m) => messages.push(m), onEnd: () => (ended = true) });
  return { session, messages, isEnded: () => ended };
}

const pcm = (bytes: number) => Buffer.alloc(bytes, 1);

function readLog(): Array<{ pid: number; args: string[]; wav: { mode: number; dataBytes: number; valid: boolean } }> {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function terminal(messages: ServerMessage[]) {
  return messages.find((m) => m.type === "voice:final" || m.type === "voice:error");
}

const ls = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("WAV encoding", () => {
  it("writes a 44-byte RIFF header for PCM16 mono 16 kHz", () => {
    const h = wavHeader(32000);
    expect(h.length).toBe(44);
    expect(h.toString("ascii", 0, 4)).toBe("RIFF");
    expect(h.readUInt32LE(4)).toBe(36 + 32000);
    expect(h.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(h.readUInt32LE(16)).toBe(16);
    expect(h.readUInt16LE(20)).toBe(1);
    expect(h.readUInt16LE(22)).toBe(1);
    expect(h.readUInt32LE(24)).toBe(16000);
    expect(h.readUInt32LE(28)).toBe(32000);
    expect(h.readUInt16LE(32)).toBe(2);
    expect(h.readUInt16LE(34)).toBe(16);
    expect(h.toString("ascii", 36, 40)).toBe("data");
    expect(h.readUInt32LE(40)).toBe(32000);
  });

  it("drops a trailing half sample", () => {
    const wav = encodeWav(Buffer.from([1, 2, 3]));
    expect(wav.length).toBe(46);
    expect(wav.readUInt32LE(40)).toBe(2);
    expect([...wav.subarray(44)]).toEqual([1, 2]);
  });
});

describe("whisperArgs", () => {
  it("builds the argument array", () => {
    expect(whisperArgs({ model: "/m.bin", wavPath: "/t.wav", language: "es" })).toEqual(["-m", "/m.bin", "-f", "/t.wav", "-l", "es", "-nt", "-np"]);
    expect(whisperArgs({ model: "/m.bin", wavPath: "/t.wav", language: "auto", threads: 4, prompt: "a, b" })).toEqual([
      "-m", "/m.bin", "-f", "/t.wav", "-l", "auto", "-nt", "-np", "-t", "4", "--prompt", "a, b",
    ]);
  });
});

describe("TranscriptionSlot", () => {
  it("serialises holders, queues waiters FIFO and reports busy when full", async () => {
    const slot = new TranscriptionSlot(1);
    const first = slot.tryAcquire()!;
    expect(slot.tryAcquire()).toBeNull();
    const queued = slot.acquire(1000);
    await expect(slot.acquire(1000)).rejects.toThrow(/Another transcription/);
    first();
    const second = await queued;
    expect(slot.busy).toBe(true);
    second();
    expect(slot.busy).toBe(false);
    const hold = slot.tryAcquire()!;
    await expect(slot.acquire(20)).rejects.toThrow(/Another transcription/);
    const ac = new AbortController();
    const aborted = slot.acquire(1000, ac.signal);
    ac.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    hold();
  });
});

describe("VoiceService.status", () => {
  it("is unavailable with binary_not_found when nothing is on PATH, and lists the setup", async () => {
    const empty = path.join(root, "empty-bin");
    fs.mkdirSync(empty);
    const { service } = makeService(undefined, { PATH: empty });
    const s = await service.status();
    expect(s).toMatchObject({ available: false, reason: "binary_not_found", mode: "hold", language: "auto", autoSubmit: false });
    expect(s.setup).toEqual([...VOICE_SETUP_INSTRUCTIONS]);
    expect(s.defaultsFrom).toEqual({ mode: "fallback", language: "fallback", autoSubmit: "fallback" });
  });

  it("reports a configured binary that does not exist", async () => {
    const { service } = makeService({ whisperBin: path.join(root, "nope") });
    expect(await service.status()).toMatchObject({ available: false, reason: "binary_not_found", detail: expect.stringContaining("nope") });
  });

  it("finds whisper-cli, then whisper-cpp, on PATH", async () => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const script = "#!/bin/sh\necho 'usage: whisper'\n";
    fs.writeFileSync(path.join(bin, "whisper-cpp"), script, { mode: 0o755 });
    const { service } = makeService({ model }, { PATH: bin });
    expect(await service.status()).toMatchObject({ available: true, whisperBin: path.join(bin, "whisper-cpp"), whisperBinFrom: "path" });
    fs.writeFileSync(path.join(bin, "whisper-cli"), script, { mode: 0o755 });
    expect(await service.status()).toMatchObject({ whisperBin: path.join(bin, "whisper-cli") });
  });

  it("auto-detects the model: ~/.promptgraph/models first, then ~/whisper.cpp/models by family", async () => {
    const { service } = makeService({ whisperBin: FAKE_WHISPER });
    expect(await service.status()).toMatchObject({ available: false, reason: "model_not_found", whisperBin: FAKE_WHISPER });

    const cpp = path.join(root, "home", "whisper.cpp", "models");
    fs.mkdirSync(cpp, { recursive: true });
    for (const f of ["ggml-tiny.bin", "ggml-medium.bin", "ggml-base.en.bin", "ggml-silero-v5.1.2.bin"]) fs.writeFileSync(path.join(cpp, f), "m");
    expect(await service.status()).toMatchObject({ available: true, model: path.join(cpp, "ggml-base.en.bin"), modelFrom: "detected" });

    const own = path.join(root, "pg-home", "models");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "ggml-custom.bin"), "m");
    expect(await service.status()).toMatchObject({ model: path.join(own, "ggml-custom.bin") });
  });

  it("reports a configured model that does not exist", async () => {
    const { service } = makeService({ whisperBin: FAKE_WHISPER, model: path.join(root, "missing.bin") });
    expect(await service.status()).toMatchObject({ available: false, reason: "model_not_found" });
  });

  it("reports binary_failed when --help fails", async () => {
    const { service } = makeService(configured(), { FAKE_WHISPER_HELP_FAIL: "1" });
    expect(await service.status()).toMatchObject({ available: false, reason: "binary_failed", detail: expect.stringContaining("code 3") });
  });

  it("is available with a working binary and model", async () => {
    const { service } = makeService(configured({ threads: 2 }));
    expect(await service.status()).toMatchObject({ available: true, whisperBin: FAKE_WHISPER, whisperBinFrom: "promptgraph", model, modelFrom: "promptgraph", threads: 2 });
  });

  it("resolves defaults: promptgraph > Claude Code ~/.claude/settings.json > fallback", async () => {
    const claudeDir = path.join(root, "home", ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const write = (v: unknown) => fs.writeFileSync(path.join(claudeDir, "settings.json"), typeof v === "string" ? v : JSON.stringify(v));

    write({ language: "Español", voice: { enabled: true, mode: "tap", autoSubmit: true } });
    const a = await makeService(configured()).service.status();
    expect(a).toMatchObject({ mode: "tap", language: "es", autoSubmit: true, defaultsFrom: { mode: "claude", language: "claude", autoSubmit: "claude" } });

    const b = await makeService(configured({ mode: "hold", language: "en" })).service.status();
    expect(b).toMatchObject({ mode: "hold", language: "en", autoSubmit: true, defaultsFrom: { mode: "promptgraph", language: "promptgraph", autoSubmit: "claude" } });

    write({ language: "klingon", voice: { mode: "sideways", autoSubmit: "yes" } });
    const c = await makeService(configured()).service.status();
    expect(c).toMatchObject({ mode: "hold", language: "auto", autoSubmit: false, defaultsFrom: { mode: "fallback", language: "fallback", autoSubmit: "fallback" } });

    write("{ not json");
    expect(await makeService(configured()).service.status()).toMatchObject({ mode: "hold", available: true });
  });

  it("reads Claude Code settings from CLAUDE_CONFIG_DIR when set", async () => {
    const dir = path.join(root, "claude-config");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ voice: { mode: "tap" } }));
    const s = await makeService(configured(), { CLAUDE_CONFIG_DIR: dir }).service.status();
    expect(s).toMatchObject({ mode: "tap", defaultsFrom: { mode: "claude" } });
  });

  it("caches the probe briefly", async () => {
    const { service } = makeService(configured(), {}, { statusCacheMs: 60_000 });
    const first = await service.status();
    fs.rmSync(model);
    expect(await service.status()).toEqual(first);
    expect(await service.status({ refresh: true })).toMatchObject({ available: false, reason: "model_not_found" });
  });

  it("coalesces concurrent and rapid refreshes into one probe", async () => {
    const { service } = makeService(configured(), {}, { statusCacheMs: 60_000 });
    const a = service.status({ refresh: true });
    const b = service.status({ refresh: true });
    expect(b).toBe(a);
    await a;
    expect(service.status({ refresh: true })).toBe(a); // under the minimum refresh interval
  });
});

describe("VoiceSession", () => {
  it("sends partials every ~2 s of audio and a final on stop, deleting the WAVs", async () => {
    const { service, tmpDir } = makeService(configured({ language: "es", threads: 3 }), { FAKE_WHISPER_TEXT: "dictated {ms}" }, { limits: { partialIntervalBytes: CHUNK * 5 } });
    const { session, messages, isEnded } = record(service, { keyterms: ["promptgraph", " Prompt  ", "merge"] });
    for (let i = 0; i < 5; i++) session.pushAudio(pcm(CHUNK));
    expect((await waitFor(() => messages.find((m) => m.type === "voice:partial"))) as ServerMessage).toEqual({
      type: "voice:partial",
      voiceId: "v1",
      text: "dictated 500",
    });
    await waitFor(() => !ls(tmpDir).length || null);
    for (let i = 0; i < 3; i++) session.pushAudio(pcm(CHUNK)); // below the interval: no new partial
    session.stop();
    const final = await waitFor(() => terminal(messages));
    expect(final).toEqual({ type: "voice:final", voiceId: "v1", text: "dictated 800" });
    expect(isEnded()).toBe(true);
    expect(messages.filter((m) => m.type === "voice:partial")).toHaveLength(1);
    expect(ls(tmpDir)).toEqual([]);

    const runs = readLog();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.wav.dataBytes)).toEqual([CHUNK * 5, CHUNK * 8]);
    for (const r of runs) {
      expect(r.wav.valid).toBe(true);
      expect(r.wav.mode).toBe(0o600);
      expect(r.args).toEqual(["-m", model, "-f", expect.stringMatching(/voice-.+\.wav$/), "-l", "es", "-nt", "-np", "-t", "3", "--prompt", "promptgraph, Prompt, merge"]);
      expect(path.dirname(r.args[3]!)).toBe(tmpDir);
    }
  });

  it("uses the per-recording language override", async () => {
    const { service } = makeService(configured({ language: "es" }));
    const { session, messages } = record(service, { language: "fr" });
    session.pushAudio(pcm(CHUNK));
    session.stop();
    await waitFor(() => terminal(messages));
    expect(readLog()[0]!.args).toContain("fr");
  });

  it("reuses the last partial for the final when no audio arrived since", async () => {
    const { service } = makeService(configured(), {}, { limits: { partialIntervalBytes: CHUNK } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    await waitFor(() => messages.find((m) => m.type === "voice:partial"));
    session.stop();
    expect(await waitFor(() => terminal(messages))).toEqual({ type: "voice:final", voiceId: "v1", text: "hello world" });
    expect(readLog()).toHaveLength(1);
  });

  it("finishes the running pass before the final pass (one whisper per session)", async () => {
    const { service } = makeService(configured(), { FAKE_WHISPER_DELAY_MS: "300", FAKE_WHISPER_TEXT: "{ms}" }, { limits: { partialIntervalBytes: CHUNK } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    await waitFor(() => readLog().length === 1 || null);
    session.pushAudio(pcm(CHUNK));
    session.stop();
    expect(await waitFor(() => terminal(messages))).toMatchObject({ type: "voice:final", text: "200" });
    // The partial that was running when stop arrived is not sent after it.
    expect(messages.map((m) => m.type)).toEqual(["voice:final"]);
    expect(readLog().map((r) => r.wav.dataBytes)).toEqual([CHUNK, CHUNK * 2]);
  });

  it("sends an empty final without running whisper when there is no audio", async () => {
    const { service } = makeService(configured());
    const { session, messages } = record(service);
    session.stop();
    expect(await waitFor(() => terminal(messages))).toEqual({ type: "voice:final", voiceId: "v1", text: "" });
    expect(readLog()).toEqual([]);
  });

  it("cancel kills the running whisper, deletes the WAV and sends nothing", async () => {
    const { service, tmpDir } = makeService(configured(), { FAKE_WHISPER_HANG: "1" }, { limits: { partialIntervalBytes: CHUNK } });
    const { session, messages, isEnded } = record(service);
    session.pushAudio(pcm(CHUNK));
    const run = await waitFor(() => readLog()[0]);
    expect(ls(tmpDir)).toHaveLength(1);
    session.cancel();
    expect(isEnded()).toBe(true);
    expect(ls(tmpDir)).toEqual([]);
    await waitFor(() => !processAlive(run.pid));
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual([]);
    expect(service.activeSessions).toBe(0);
    session.pushAudio(pcm(CHUNK)); // ignored after the end
    expect(session.audioBytes).toBe(0);
  });

  it("stops at the audio cap with a truncated final and ignores later frames", async () => {
    const { service } = makeService(configured(), { FAKE_WHISPER_TEXT: "{ms}" }, { limits: { maxAudioBytes: CHUNK * 3, partialIntervalBytes: CHUNK * 100 } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK * 2));
    session.pushAudio(pcm(CHUNK * 2));
    session.pushAudio(pcm(CHUNK));
    expect(await waitFor(() => terminal(messages))).toEqual({ type: "voice:final", voiceId: "v1", text: "300", truncated: true });
    expect(readLog().map((r) => r.wav.dataBytes)).toEqual([CHUNK * 3]);
  });

  it("the watchdog ends a recording that never stops with too_long", async () => {
    const { service } = makeService(configured(), {}, { limits: { watchdogMs: 100 } });
    const { session, messages, isEnded } = record(service);
    session.pushAudio(pcm(CHUNK));
    expect(await waitFor(() => terminal(messages))).toMatchObject({ type: "voice:error", code: "too_long" });
    expect(isEnded()).toBe(true);
  });

  it("fails with unavailable when whisper is not set up", async () => {
    const empty = path.join(root, "empty-bin");
    fs.mkdirSync(empty);
    const { service } = makeService(undefined, { PATH: empty });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    expect(await waitFor(() => terminal(messages))).toMatchObject({ type: "voice:error", code: "unavailable", message: expect.stringContaining("whisper-cli was not found") });
  });

  it("fails with failed when whisper exits non-zero, and on an oversized frame", async () => {
    const { service } = makeService(configured(), { FAKE_WHISPER_FAIL: "1" });
    const a = record(service);
    a.session.pushAudio(pcm(CHUNK));
    a.session.stop();
    expect(await waitFor(() => terminal(a.messages))).toMatchObject({ type: "voice:error", code: "failed", message: expect.stringContaining("exited with code 1") });

    const b = record(service);
    b.session.pushAudio(pcm(service.limits.maxFrameBytes + 2));
    expect(await waitFor(() => terminal(b.messages))).toMatchObject({ type: "voice:error", code: "failed", message: "Audio frame too large" });
  });

  it("times out a pass", async () => {
    const { service } = makeService(configured(), { FAKE_WHISPER_HANG: "1" }, { limits: { passTimeoutMs: 200 } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    session.stop();
    expect(await waitFor(() => terminal(messages))).toMatchObject({ type: "voice:error", code: "failed", message: expect.stringContaining("timed out") });
  });

  it("runs one whisper at a time across sessions and answers busy when the slot cannot be had", async () => {
    const { service } = makeService(configured(), { FAKE_WHISPER_HANG: "1" }, { limits: { partialIntervalBytes: CHUNK, queueWaitMs: 150 } });
    const a = record(service);
    a.session.pushAudio(pcm(CHUNK));
    await waitFor(() => readLog().length === 1 || null);
    const bMessages: ServerMessage[] = [];
    const b = service.start({ voiceId: "v2", send: (m) => bMessages.push(m) });
    b.pushAudio(pcm(CHUNK)); // partial skipped: the slot is taken
    b.stop();
    expect(await waitFor(() => terminal(bMessages))).toMatchObject({ type: "voice:error", voiceId: "v2", code: "busy" });
    expect(readLog()).toHaveLength(1);
    a.session.cancel();
  });

  it("shutdown ends sessions with cancelled and removes its own temp dir", async () => {
    const { service, tmpDir, sharedTmp } = makeService(configured(), { FAKE_WHISPER_HANG: "1" }, { limits: { partialIntervalBytes: CHUNK } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    const run = await waitFor(() => readLog()[0]);
    fs.writeFileSync(path.join(tmpDir, "voice-stale.wav"), "x");
    await service.shutdown();
    expect(terminal(messages)).toMatchObject({ type: "voice:error", code: "cancelled" });
    expect(fs.existsSync(tmpDir)).toBe(false);
    expect(ls(sharedTmp)).toEqual([]);
    await waitFor(() => !processAlive(run.pid));
    expect((session as VoiceSession).ended).toBe(true);
  });

  it("never deletes the in-flight WAVs of another live instance sharing the tmp dir", async () => {
    const a = makeService(configured(), { FAKE_WHISPER_HANG: "1" }, { limits: { partialIntervalBytes: CHUNK } });
    const rec = record(a.service);
    rec.session.pushAudio(pcm(CHUNK));
    await waitFor(() => readLog()[0]);
    expect(ls(a.tmpDir)).toHaveLength(1);
    // A second server (same shared tmp) starts, dictates and shuts down: A's WAV survives.
    const b = makeService(configured());
    const other = record(b.service);
    other.session.pushAudio(pcm(CHUNK));
    other.session.stop();
    await waitFor(() => terminal(other.messages));
    await b.service.shutdown();
    expect(ls(a.tmpDir)).toHaveLength(1);
    rec.session.cancel();
  });

  it("sweeps the dirs of dead servers and old loose WAVs at startup, but not recent loose ones", () => {
    const sharedTmp = path.join(root, "pg-home", "tmp");
    const dead = path.join(sharedTmp, "voice-999999999-abcd");
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, "voice-x.wav"), "x");
    const alive = path.join(sharedTmp, `voice-${process.ppid}-beef`);
    fs.mkdirSync(alive);
    const old = path.join(sharedTmp, "voice-old.wav");
    fs.writeFileSync(old, "x");
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(old, past, past);
    fs.writeFileSync(path.join(sharedTmp, "voice-new.wav"), "x");
    // An entry that cannot be removed with rmSync (a directory named like a WAV) must not throw.
    fs.mkdirSync(path.join(sharedTmp, "voice-dir.wav"));
    fs.utimesSync(path.join(sharedTmp, "voice-dir.wav"), past, past);
    makeService(configured());
    expect(ls(sharedTmp).sort()).toEqual([`voice-${process.ppid}-beef`, "voice-dir.wav", "voice-new.wav"]);
  });
});

describe("VoiceSession partial failures", () => {
  it("a failed partial pass does not end the recording; the final still runs", async () => {
    const marker = path.join(root, "fail-once");
    const { service } = makeService(configured(), { FAKE_WHISPER_FAIL_FIRST: marker, FAKE_WHISPER_TEXT: "{ms}" }, { limits: { partialIntervalBytes: CHUNK } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    await waitFor(() => readLog().length === 1 || null);
    await new Promise((r) => setTimeout(r, 100));
    expect(session.ended).toBe(false);
    session.pushAudio(pcm(CHUNK));
    session.stop();
    expect(await waitFor(() => terminal(messages))).toMatchObject({ type: "voice:final", text: "200" });
  });

  it("a failed final pass falls back to the last good partial with a notice", async () => {
    const marker = path.join(root, "fail-after");
    const { service } = makeService(configured(), { FAKE_WHISPER_FAIL_AFTER_FIRST: marker, FAKE_WHISPER_TEXT: "{ms}" }, { limits: { partialIntervalBytes: CHUNK } });
    const { session, messages } = record(service);
    session.pushAudio(pcm(CHUNK));
    await waitFor(() => messages.find((m) => m.type === "voice:partial"));
    session.pushAudio(pcm(CHUNK / 2));
    session.stop();
    const final = await waitFor(() => terminal(messages));
    expect(final).toMatchObject({ type: "voice:final", text: "100", notice: expect.stringContaining("final transcription failed") });
  });
});

describe("AppSettingsStore", () => {
  it("drops only the invalid fields of a hand-edited file, keeping every other setting", async () => {
    const { AppSettingsStore } = await import("../src/config/app-settings.js");
    const file = path.join(root, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ notifications: false, voice: { language: "es-ES", whisperBin: "~/whisper.cpp/build/bin/whisper-cli", mode: "tap", threads: 4 } }),
    );
    const store = new AppSettingsStore(file);
    expect(store.get()).toEqual({ notifications: false, bypassPermissions: false, voice: { mode: "tap", threads: 4 } });
    store.update({ voice: { mode: "hold" } });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ notifications: false, bypassPermissions: false, voice: { mode: "hold" } });
  });
});
