import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { NodeRun, RunSummary, ServerMessage } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SIGN_OUT_TERMINATE_MS, WsHub } from "../src/ws/hub.js";
import { createTempRepo, tempDir, waitFor } from "./helpers.js";
import { createTestDaemon, sessionCookie, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  send(msg: unknown): void;
  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
}

let REPO_ID: string;
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
const clients: WebSocket[] = [];

beforeEach(async () => {
  const r = createTempRepo();
  const t = tempDir();
  cleanups = [r.cleanup, t.cleanup];
  daemon = await createTestDaemon({ root: t.dir, repos: [r.repo], mockEngines: true });
  REPO_ID = daemon.repoIds[0]!;
  server = createServer((_req, res) => res.end());
  hub = new WsHub(setup.ctx);
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await daemon.close();
  for (const c of cleanups) c();
});

const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };

function connect(headers: Record<string, string> = BEARER, query = ""): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
  clients.push(ws);
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
  const client: TestClient = {
    ws,
    messages,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (pred) => waitFor(() => messages.find(pred), 5000),
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

/**
 * A raw TCP WebSocket client that never answers the close frame (the `ws` client always does), as a
 * non-browser peer replaying a stolen cookie could. Sends masked text frames; resolves once upgraded.
 */
async function rawConnect(headers: Record<string, string>): Promise<{ socket: net.Socket; send(msg: unknown): void; closed: Promise<void>; received: () => Buffer }> {
  const socket = net.connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  socket.on("data", (d: Buffer) => (buf = Buffer.concat([buf, d])));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const lines = [
    "GET /ws HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  await waitFor(() => buf.includes("\r\n\r\n"), 5000);
  expect(buf.toString("latin1").split("\r\n")[0]).toContain("101");
  const send = (msg: unknown) => {
    const payload = Buffer.from(JSON.stringify(msg));
    expect(payload.length).toBeLessThan(126);
    const mask = randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  };
  return { socket, send, closed, received: () => buf };
}

const summary = (id: string) => ({ id }) as RunSummary;
const nodeRun = (id: string, runId: string) => ({ id, runId }) as NodeRun;

describe("WsHub", () => {
  it("rejects unauthenticated and non-local upgrades", async () => {
    await expect(connect({})).rejects.toThrow("HTTP 401");
    await expect(connect({ authorization: "Bearer wrong" })).rejects.toThrow("HTTP 401");
    await expect(connect({ ...BEARER, origin: "http://evil.example" })).rejects.toThrow("HTTP 403");
    // The URL carries no credential: ?t= is ignored.
    await expect(connect({}, `?t=${TEST_TOKEN}`)).rejects.toThrow("HTTP 401");
    setup.ctx.port = port;
    const cookie = sessionCookie(setup.ctx);
    // Another app on a different localhost port must not reach the PTYs with the user's cookie.
    await expect(connect({ cookie, origin: "http://127.0.0.1:3000" })).rejects.toThrow("HTTP 403");
    const sameOrigin = await connect({ cookie, origin: `http://127.0.0.1:${port}` });
    expect((await sameOrigin.next((m) => m.type === "hello")).type).toBe("hello");
    const viaCookie = await connect({ cookie });
    expect((await viaCookie.next((m) => m.type === "hello")).type).toBe("hello");
    // A wrong Authorization header is not rescued by a valid cookie.
    await expect(connect({ cookie, authorization: "Bearer wrong" })).rejects.toThrow("HTTP 401");
    await expect(connect({ cookie: "pg_session=not-a-session" })).rejects.toThrow("HTTP 401");
  });

  it("applies the Fetch Metadata rule to cookie upgrades only", async () => {
    const cookie = sessionCookie(setup.ctx);
    await expect(connect({ cookie, "sec-fetch-site": "same-site" })).rejects.toThrow("HTTP 403");
    await expect(connect({ cookie, "sec-fetch-site": "cross-site" })).rejects.toThrow("HTTP 403");
    const same = await connect({ cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket" });
    expect((await same.next((m) => m.type === "hello")).type).toBe("hello");
    // Bearer clients are not browsers: no Fetch Metadata check.
    const bearer = await connect({ ...BEARER, "sec-fetch-site": "cross-site" });
    expect((await bearer.next((m) => m.type === "hello")).type).toBe("hello");
  });

  it("closes a revoked session's sockets with 4401 and keeps the others", async () => {
    const one = sessionCookie(setup.ctx, "one");
    const two = sessionCookie(setup.ctx, "two");
    const a = await connect({ cookie: one });
    const a2 = await connect({ cookie: one });
    const b = await connect({ cookie: two });
    const c = await connect();
    const closes = [a, a2, b, c].map((x) => new Promise<number>((resolve) => x.ws.once("close", (code) => resolve(code))));
    const [listed] = setup.ctx.sessions.list().filter((s) => s.label === "one");
    expect(setup.ctx.sessions.revoke(listed!.id)).toBe(1);
    expect(await closes[0]).toBe(4401);
    expect(await closes[1]).toBe(4401);
    b.send({ type: "ping" });
    await b.next((m) => m.type === "pong");
    c.send({ type: "ping" });
    await c.next((m) => m.type === "pong");
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    // The other session still upgrades; the revoked one no longer does.
    await expect(connect({ cookie: one })).rejects.toThrow("HTTP 401");
    expect((await (await connect({ cookie: two })).next((m) => m.type === "hello")).type).toBe("hello");
  });

  it("ignores what a signed-out peer sends while it withholds the close handshake, then terminates it", async () => {
    const { ptys, paths } = setup.ctx;
    ptys.spawn({ id: "p1", file: "sh", args: ["-c", "cat"], cwd: paths.home, env: { PATH: process.env.PATH ?? "" }, logPath: path.join(paths.home, "p1.log") });
    const userInput = vi.spyOn(ptys, "userInput");
    const resize = vi.spyOn(ptys, "resize");
    const activate = vi.spyOn(setup.ctx.registry, "activate");
    const cookie = sessionCookie(setup.ctx, "stolen");
    const raw = await rawConnect({ Cookie: cookie });
    // Proves the socket acts before the revocation.
    raw.send({ type: "pty:input", ptyId: "p1", data: "before\r" });
    await waitFor(() => userInput.mock.calls.length === 1, 5000);

    const [listed] = setup.ctx.sessions.list().filter((s) => s.label === "stolen");
    setup.ctx.sessions.revoke(listed!.id);
    // The server's close frame (opcode 0x8, code 4401) arrives; the peer does not answer it.
    await waitFor(() => raw.received().includes(Buffer.from([0x88, 0x0c, 0x11, 0x31])), 5000);
    raw.send({ type: "pty:input", ptyId: "p1", data: "after\r" });
    raw.send({ type: "pty:resize", ptyId: "p1", cols: 10, rows: 5 });
    raw.send({ type: "repo:subscribe", repoId: REPO_ID });
    const started = Date.now();
    await raw.closed;
    expect(Date.now() - started).toBeLessThan(SIGN_OUT_TERMINATE_MS + 2000);
    expect(userInput).toHaveBeenCalledTimes(1);
    expect(resize).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("closes every socket, Bearer ones included, with 4401 on token rotation", async () => {
    const a = await connect({ cookie: sessionCookie(setup.ctx) });
    const b = await connect();
    const closes = [a, b].map((x) => new Promise<number>((resolve) => x.ws.once("close", (code) => resolve(code))));
    setup.ctx.bus.emit("token:rotated", {});
    expect(await Promise.all(closes)).toEqual([4401, 4401]);
  });

  it("sends run and graph updates to repository subscribers and node updates to run subscribers", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: "repo:subscribe", repoId: REPO_ID });
    a.send({ type: "subscribe", runId: "r1" });
    a.send({ type: "ping" });
    await a.next((m) => m.type === "pong");

    setup.ctx.bus.emit("run:update", { repoId: REPO_ID, run: summary("r1") });
    setup.ctx.bus.emit("run:update", { repoId: "other-0123abcd", run: summary("r9") });
    setup.ctx.bus.emit("node:update", { nodeRun: nodeRun("n1", "r1") });
    setup.ctx.bus.emit("node:update", { nodeRun: nodeRun("n2", "r2") });
    setup.ctx.bus.emit("graphs:changed", { repoId: REPO_ID, graphId: "g" });

    await a.next((m) => m.type === "graphs:changed");
    expect(a.messages.filter((m) => m.type === "node:update")).toEqual([{ type: "node:update", nodeRun: nodeRun("n1", "r1") }]);
    expect(a.messages.filter((m) => m.type === "run:update")).toEqual([{ type: "run:update", repoId: REPO_ID, run: summary("r1") }]);
    expect(a.messages.find((m) => m.type === "graphs:changed")).toEqual({ type: "graphs:changed", repoId: REPO_ID, graphId: "g" });
    // b subscribed to nothing: a ping round trip proves the events were not merely late.
    b.send({ type: "ping" });
    await b.next((m) => m.type === "pong");
    expect(b.messages.some((m) => m.type === "run:update" || m.type === "graphs:changed" || m.type === "node:update")).toBe(false);

    a.send({ type: "unsubscribe", runId: "r1" });
    a.send({ type: "repo:unsubscribe", repoId: REPO_ID });
    a.send({ type: "ping" });
    await waitFor(() => a.messages.filter((m) => m.type === "pong").length === 2);
    setup.ctx.bus.emit("node:update", { nodeRun: nodeRun("n3", "r1") });
    setup.ctx.bus.emit("graphs:changed", { repoId: REPO_ID, graphId: "g2" });
    a.send({ type: "ping" });
    await waitFor(() => a.messages.filter((m) => m.type === "pong").length === 3);
    expect(a.messages.filter((m) => m.type === "node:update")).toHaveLength(1);
    expect(a.messages.filter((m) => m.type === "graphs:changed")).toHaveLength(1);
  });

  it("repo:subscribe activates the repository; unknown and invalid ids are errors", async () => {
    const a = await connect();
    a.send({ type: "repo:subscribe", repoId: REPO_ID });
    a.send({ type: "ping" });
    await a.next((m) => m.type === "pong");
    expect(a.messages.some((m) => m.type === "error")).toBe(false);
    a.send({ type: "repo:subscribe", repoId: "missing-0123abcd" });
    expect(await a.next((m) => m.type === "error")).toMatchObject({ message: expect.stringContaining("missing-0123abcd") });
    a.send({ type: "repo:subscribe", repoId: "../x" });
    await waitFor(() => a.messages.filter((m) => m.type === "error").length === 2);
  });

  it("debounces repo:changed into one repo:status for every client and sends repo:removed to every client", async () => {
    const a = await connect();
    const b = await connect();
    for (let i = 0; i < 5; i++) setup.ctx.bus.emit("repo:changed", { repoId: REPO_ID });
    const status = await b.next((m) => m.type === "repo:status");
    expect(status).toMatchObject({ type: "repo:status", repo: { id: REPO_ID, active: true } });
    await a.next((m) => m.type === "repo:status");
    await new Promise((r) => setTimeout(r, 400));
    expect(b.messages.filter((m) => m.type === "repo:status")).toHaveLength(1);

    await setup.ctx.registry.remove(REPO_ID);
    expect(await a.next((m) => m.type === "repo:removed")).toEqual({ type: "repo:removed", repoId: REPO_ID });
    await b.next((m) => m.type === "repo:removed");
  });

  it("attaches to a PTY with replay, live output, input and exit", async () => {
    const { ptys, paths } = setup.ctx;
    ptys.spawn({ id: "p1", file: "sh", args: ["-c", "echo READY; cat"], cwd: paths.home, env: { PATH: process.env.PATH ?? "" }, logPath: path.join(paths.home, "p1.log") });
    await waitFor(() => ptys.attach("p1").replay.toString().includes("READY"));

    const c = await connect();
    c.send({ type: "pty:attach", ptyId: "p1", cols: 100, rows: 30 });
    const attached = await c.next((m) => m.type === "pty:attached");
    expect(attached).toEqual({ type: "pty:attached", ptyId: "p1", live: true, cols: 100, rows: 30 });
    const text = () =>
      c.messages
        .filter((m): m is Extract<ServerMessage, { type: "pty:data" }> => m.type === "pty:data")
        .map((m) => Buffer.from(m.data, "base64").toString())
        .join("");
    await waitFor(() => text().includes("READY"));

    c.send({ type: "pty:input", ptyId: "p1", data: "hello\r" });
    await waitFor(() => text().includes("hello"));
    c.send({ type: "pty:resize", ptyId: "p1", cols: 90, rows: 20 });

    c.send({ type: "pty:input", ptyId: "p1", data: "\x04" });
    const exit = await c.next((m) => m.type === "pty:exit");
    expect(exit).toMatchObject({ ptyId: "p1", code: 0 });

    c.send({ type: "pty:input", ptyId: "p1", data: "x" });
    expect(await c.next((m) => m.type === "pty:error")).toMatchObject({ ptyId: "p1" });

    c.send({ type: "pty:attach", ptyId: "p1" });
    await waitFor(() => c.messages.filter((m) => m.type === "pty:attached").length === 2);
    expect(c.messages.filter((m) => m.type === "pty:attached")[1]).toMatchObject({ live: false });
  });

  it("chunks large replays and reports unknown PTYs and invalid messages", async () => {
    const { ptys, paths } = setup.ctx;
    ptys.spawn({
      id: "big",
      file: "sh",
      args: ["-c", "head -c 200000 /dev/zero | tr '\\0' x; echo; echo END; cat"],
      cwd: paths.home,
      env: { PATH: process.env.PATH ?? "" },
      logPath: path.join(paths.home, "big.log"),
    });
    await waitFor(() => ptys.attach("big").replay.toString().includes("END"));
    const c = await connect();
    c.send({ type: "pty:attach", ptyId: "big" });
    await waitFor(() => c.messages.filter((m) => m.type === "pty:data").length >= 4);
    const sizes = c.messages.filter((m) => m.type === "pty:data").map((m) => Buffer.from(m.data, "base64").length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);

    c.send({ type: "pty:attach", ptyId: "missing" });
    expect(await c.next((m) => m.type === "pty:error")).toMatchObject({ ptyId: "missing" });
    c.ws.send("not json");
    expect(await c.next((m) => m.type === "error")).toMatchObject({ message: "Invalid message" });
  });

  it("routes chat messages to the repository's ChatManager and sends chat:* to its subscribers only", async () => {
    const a = await connect();
    const b = await connect();
    const outsider = await connect();
    a.send({ type: "repo:subscribe", repoId: REPO_ID });
    b.send({ type: "repo:subscribe", repoId: REPO_ID });
    const context = { graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: null, readOnly: false };
    a.send({ type: "chat:send", repoId: REPO_ID, sessionId: "missing", text: "hi", context });
    expect(await a.next((m) => m.type === "error")).toMatchObject({ message: "Chat session missing not found" });
    // Subscriptions are processed in order: b's has been handled once a ping it sent after it is answered.
    b.send({ type: "ping" });
    await b.next((m) => m.type === "pong");

    const session = (await daemon.repo(REPO_ID)).chat.create();
    expect(await b.next((m) => m.type === "chat:session")).toMatchObject({ repoId: REPO_ID, session: { id: session.id } });
    // The test daemon never starts claude: the send ends with an error item.
    a.send({ type: "chat:send", repoId: REPO_ID, sessionId: session.id, text: "hi", context });
    expect(await b.next((m) => m.type === "chat:item" && m.item.kind === "user")).toMatchObject({
      repoId: REPO_ID,
      sessionId: session.id,
      item: { text: "hi" },
    });
    expect(await b.next((m) => m.type === "chat:item" && m.item.kind === "error")).toMatchObject({ item: { message: expect.stringContaining("Could not start") } });
    expect(await a.next((m) => m.type === "chat:status" && m.status === "error")).toMatchObject({ repoId: REPO_ID, sessionId: session.id });

    a.send({ type: "chat:permission", repoId: REPO_ID, sessionId: session.id, requestId: "nope", allow: true });
    expect(await a.next((m) => m.type === "error" && m.message.includes("No pending permission"))).toBeTruthy();
    // A client that did not subscribe to the repository receives none of its chat messages.
    outsider.send({ type: "ping" });
    await outsider.next((m) => m.type === "pong");
    expect(outsider.messages.filter((m) => m.type.startsWith("chat:"))).toEqual([]);
  });

  it("answers chat messages for an unknown repository with an error", async () => {
    const a = await connect();
    a.send({ type: "chat:interrupt", repoId: "nope-0123abcd", sessionId: "s" });
    expect(await a.next((m) => m.type === "error")).toMatchObject({ message: expect.stringContaining("nope-0123abcd") });
  });
});
