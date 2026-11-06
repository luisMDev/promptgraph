import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage, VoiceStatus } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHttpApp } from "../src/http/app.js";
import { VoiceService } from "../src/voice/voice-service.js";
import { WsHub } from "../src/ws/hub.js";
import { createTempRepo, tempDir, waitFor } from "./helpers.js";
import { createTestDaemon, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

const FAKE_WHISPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-whisper-cli");
const CHUNK = 3200;

let server: Server;
let hub: WsHub;
let port: number;
let daemon: TestDaemon;
const setup = {
  get ctx() {
    return daemon.ctx;
  },
};
let cleanups: Array<() => void>;
let root: string;
let log: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  const r = createTempRepo();
  const t = tempDir();
  root = t.dir;
  cleanups = [r.cleanup, t.cleanup];
  log = path.join(root, "whisper.log");
  const env = { PATH: path.dirname(process.execPath), FAKE_WHISPER_LOG: log, FAKE_WHISPER_TEXT: "spoken {ms}", FAKE_WHISPER_DELAY_MS: "100" };
  daemon = await createTestDaemon({ root, repos: [r.repo], mockEngines: true, env });
  const model = path.join(root, "ggml-base.bin");
  fs.writeFileSync(model, "m");
  setup.ctx.settings.update({ voice: { whisperBin: FAKE_WHISPER, model } });
  // Shorter partial interval (300 ms of audio) so the test sees partials quickly.
  await setup.ctx.voice.shutdown();
  setup.ctx.voice = new VoiceService({
    settings: setup.ctx.settings,
    paths: setup.ctx.paths,
    env: setup.ctx.env,
    homeDir: root,
    limits: { partialIntervalBytes: CHUNK * 3 },
  });
  server = createServer((_req, res) => res.end());
  hub = new WsHub(setup.ctx);
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await daemon.close();
  for (const c of cleanups) c();
});

interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  send(msg: unknown): void;
  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
}

function connect(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
  return new Promise((resolve, reject) => {
    ws.once("open", () =>
      resolve({ ws, messages, send: (m) => ws.send(JSON.stringify(m)), next: (pred) => waitFor(() => messages.find(pred), 5000) }),
    );
    ws.once("error", reject);
  });
}

const audio = (bytes: number) => Buffer.alloc(bytes, 7);
const runs = (): Array<{ wav: { dataBytes: number } }> =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const voiceMessages = (c: TestClient) => c.messages.filter((m) => m.type.startsWith("voice:"));

describe("voice over the WebSocket", () => {
  it("routes binary frames to the client's session: partials, then a final on voice:stop", async () => {
    const c = await connect();
    c.send({ type: "voice:start", voiceId: "a1", sampleRate: 16000, keyterms: ["promptgraph"] });
    for (let i = 0; i < 3; i++) c.ws.send(audio(CHUNK), { binary: true });
    expect(await c.next((m) => m.type === "voice:partial")).toEqual({ type: "voice:partial", voiceId: "a1", text: "spoken 300" });
    c.ws.send(audio(CHUNK), { binary: true });
    c.send({ type: "voice:stop", voiceId: "a1" });
    expect(await c.next((m) => m.type === "voice:final")).toEqual({ type: "voice:final", voiceId: "a1", text: "spoken 400" });
    expect(c.messages.some((m) => m.type === "error")).toBe(false);
  });

  it("ignores binary frames with no active session and stop/cancel for another voiceId", async () => {
    const c = await connect();
    c.ws.send(audio(CHUNK), { binary: true });
    c.send({ type: "voice:stop", voiceId: "nope" });
    c.send({ type: "ping" });
    await c.next((m) => m.type === "pong");
    expect(c.messages.filter((m) => m.type === "error" || m.type.startsWith("voice:"))).toEqual([]);

    c.send({ type: "voice:start", voiceId: "b1", sampleRate: 16000 });
    c.ws.send(audio(CHUNK), { binary: true });
    c.send({ type: "voice:cancel", voiceId: "other" });
    c.send({ type: "voice:stop", voiceId: "b1" });
    expect(await c.next((m) => m.type === "voice:final")).toMatchObject({ voiceId: "b1", text: "spoken 100" });
  });

  it("keeps sessions per client: audio of one client never reaches another", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: "voice:start", voiceId: "a", sampleRate: 16000 });
    b.send({ type: "voice:start", voiceId: "b", sampleRate: 16000 });
    a.ws.send(audio(CHUNK), { binary: true });
    b.ws.send(audio(CHUNK * 2), { binary: true });
    // A JSON round trip so the frames are in before the stops (the hub handles messages in order per socket).
    a.send({ type: "voice:stop", voiceId: "a" });
    b.send({ type: "voice:stop", voiceId: "b" });
    expect(await a.next((m) => m.type === "voice:final")).toMatchObject({ voiceId: "a", text: "spoken 100" });
    expect(await b.next((m) => m.type === "voice:final")).toMatchObject({ voiceId: "b", text: "spoken 200" });
    expect(voiceMessages(a).every((m) => "voiceId" in m && m.voiceId === "a")).toBe(true);
    expect(voiceMessages(b).every((m) => "voiceId" in m && m.voiceId === "b")).toBe(true);
  });

  it("a new voice:start silently cancels the previous session", async () => {
    const c = await connect();
    c.send({ type: "voice:start", voiceId: "old", sampleRate: 16000 });
    c.ws.send(audio(CHUNK), { binary: true });
    c.send({ type: "voice:start", voiceId: "new", sampleRate: 16000 });
    c.ws.send(audio(CHUNK * 2), { binary: true });
    c.send({ type: "voice:stop", voiceId: "new" });
    expect(await c.next((m) => m.type === "voice:final")).toMatchObject({ voiceId: "new", text: "spoken 200" });
    await new Promise((r) => setTimeout(r, 100));
    expect(voiceMessages(c).filter((m) => "voiceId" in m && m.voiceId === "old")).toEqual([]);
  });

  it("closing the socket cancels the session", async () => {
    const c = await connect();
    c.send({ type: "voice:start", voiceId: "z", sampleRate: 16000 });
    for (let i = 0; i < 3; i++) c.ws.send(audio(CHUNK), { binary: true });
    await waitFor(() => setup.ctx.voice.activeSessions === 1 || null);
    c.ws.close();
    await waitFor(() => setup.ctx.voice.activeSessions === 0 || null);
    const dir = setup.ctx.voice.tempDir;
    await waitFor(() => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0 || null);
  });

  it("rejects an invalid voice:start", async () => {
    const c = await connect();
    c.send({ type: "voice:start", voiceId: "x", sampleRate: 44100 });
    expect(await c.next((m) => m.type === "error")).toMatchObject({ message: "Invalid message" });
    expect(runs()).toEqual([]);
  });
});

describe("GET /api/voice", () => {
  it("requires the token and returns the status", async () => {
    const app = createHttpApp(setup.ctx);
    const host = { host: "127.0.0.1:4777" };
    expect((await app.request("/api/voice", { headers: host })).status).toBe(401);
    const res = await app.request("/api/voice", { headers: { ...host, authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VoiceStatus;
    expect(body).toMatchObject({ available: true, whisperBin: FAKE_WHISPER, mode: "hold", language: "auto", autoSubmit: false });
    expect(body.setup.length).toBeGreaterThan(0);
  });

  it("honours ?refresh=1 only for same-origin (or Sec-Fetch-Site-less) requests", async () => {
    const app = createHttpApp(setup.ctx);
    const calls: Array<boolean | undefined> = [];
    const original = setup.ctx.voice.status.bind(setup.ctx.voice);
    setup.ctx.voice.status = (opts = {}) => {
      calls.push(opts.refresh);
      return original(opts);
    };
    try {
      const headers = { host: "127.0.0.1:4777", authorization: `Bearer ${TEST_TOKEN}` };
      await app.request("/api/voice?refresh=1", { headers });
      await app.request("/api/voice?refresh=1", { headers: { ...headers, "sec-fetch-site": "same-origin" } });
      await app.request("/api/voice?refresh=1", { headers: { ...headers, "sec-fetch-site": "same-site" } });
      expect(calls).toEqual([true, true, false]);
    } finally {
      setup.ctx.voice.status = original;
    }
  });
});
