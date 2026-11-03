import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { NodeRun, RunSummary, ServerMessage } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WsHub } from "../src/ws/hub.js";
import { createTempRepo, tempDir, waitFor } from "./helpers.js";
import { createTestDaemon, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";
import { sessionCookieValue } from "../src/hooks/hook-token.js";

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

function connect(query = `?t=${TEST_TOKEN}`, headers: Record<string, string> = {}): Promise<TestClient> {
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

const summary = (id: string) => ({ id }) as RunSummary;
const nodeRun = (id: string, runId: string) => ({ id, runId }) as NodeRun;

describe("WsHub", () => {
  it("rejects unauthenticated and non-local upgrades", async () => {
    await expect(connect("")).rejects.toThrow("HTTP 401");
    await expect(connect("?t=wrong")).rejects.toThrow("HTTP 401");
    await expect(connect(`?t=${TEST_TOKEN}`, { origin: "http://evil.example" })).rejects.toThrow("HTTP 403");
    setup.ctx.port = port;
    // Another app on a different localhost port must not reach the PTYs with the user's cookie.
    await expect(connect("", { cookie: `pg_token=${sessionCookieValue(TEST_TOKEN)}`, origin: "http://127.0.0.1:3000" })).rejects.toThrow("HTTP 403");
    const sameOrigin = await connect("", { cookie: `pg_token=${sessionCookieValue(TEST_TOKEN)}`, origin: `http://127.0.0.1:${port}` });
    expect((await sameOrigin.next((m) => m.type === "hello")).type).toBe("hello");
    const viaCookie = await connect("", { cookie: `pg_token=${sessionCookieValue(TEST_TOKEN)}` });
    expect((await viaCookie.next((m) => m.type === "hello")).type).toBe("hello");
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
});
