import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { NodeRun, RunSummary, ServerMessage } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WsHub } from "../src/ws/hub.js";
import { createTempRepo, tempDir, waitFor } from "./helpers.js";
import { createTestContext, TEST_TOKEN } from "./support/http-ctx.js";

interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  send(msg: unknown): void;
  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
}

let server: Server;
let hub: WsHub;
let port: number;
let setup: ReturnType<typeof createTestContext>;
let cleanups: Array<() => void>;
const clients: WebSocket[] = [];

beforeEach(async () => {
  const r = createTempRepo();
  const t = tempDir();
  cleanups = [r.cleanup, t.cleanup];
  setup = createTestContext(r.repo, t.dir);
  server = createServer((_req, res) => res.end());
  hub = new WsHub(setup.ctx);
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await setup.ctx.ptys.killAll();
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setup.ctx.store.db.close();
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
    await expect(connect("", { cookie: `pg_token=${TEST_TOKEN}`, origin: "http://127.0.0.1:3000" })).rejects.toThrow("HTTP 403");
    const sameOrigin = await connect("", { cookie: `pg_token=${TEST_TOKEN}`, origin: `http://127.0.0.1:${port}` });
    expect((await sameOrigin.next((m) => m.type === "hello")).type).toBe("hello");
    const viaCookie = await connect("", { cookie: `pg_token=${TEST_TOKEN}` });
    expect((await viaCookie.next((m) => m.type === "hello")).type).toBe("hello");
  });

  it("broadcasts run updates to all and node updates to subscribers only", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: "subscribe", runId: "r1" });
    a.send({ type: "ping" });
    await a.next((m) => m.type === "pong");

    setup.ctx.bus.emit("run:update", { run: summary("r1") });
    setup.ctx.bus.emit("node:update", { nodeRun: nodeRun("n1", "r1") });
    setup.ctx.bus.emit("node:update", { nodeRun: nodeRun("n2", "r2") });
    setup.ctx.bus.emit("graphs:changed", { graphId: "g" });

    await a.next((m) => m.type === "graphs:changed");
    await b.next((m) => m.type === "graphs:changed");
    expect(a.messages.filter((m) => m.type === "node:update")).toEqual([{ type: "node:update", nodeRun: nodeRun("n1", "r1") }]);
    expect(b.messages.some((m) => m.type === "node:update")).toBe(false);
    expect(b.messages.some((m) => m.type === "run:update")).toBe(true);

    a.send({ type: "unsubscribe", runId: "r1" });
    a.send({ type: "ping" });
    await waitFor(() => a.messages.filter((m) => m.type === "pong").length === 2);
    setup.ctx.bus.emit("node:update", { nodeRun: nodeRun("n3", "r1") });
    setup.ctx.bus.emit("graphs:changed", { graphId: "g2" });
    await a.next((m) => m.type === "graphs:changed" && m.graphId === "g2");
    expect(a.messages.filter((m) => m.type === "node:update")).toHaveLength(1);
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
