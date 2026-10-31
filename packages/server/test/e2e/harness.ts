import fs from "node:fs";
import path from "node:path";
import {
  ServerMessageSchema,
  decodeBase64,
  type ClientMessage,
  type GraphInput,
  type NodeRun,
  type RunDetail,
  type ServerMessage,
} from "@promptgraph/shared";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "../../src/cli/server.js";
import { createTempRepo, fakeClaudeEnv, tempDir, waitFor } from "../helpers.js";

/** One temp repo + PG_HOME + fake claude, shared by the servers a test starts (restart tests). */
export interface E2eWorld {
  repo: string;
  root: string;
  env: NodeJS.ProcessEnv;
  /** FAKE_CLAUDE_LOG file: one JSON line per fake-claude invocation. */
  claudeLog: string;
  cleanup(): void;
}

export function createWorld(extraEnv: Record<string, string> = {}): E2eWorld {
  const { repo, cleanup: cleanRepo } = createTempRepo("pg-e2e-repo-");
  const { dir: root, cleanup: cleanRoot } = tempDir("pg-e2e-");
  const claudeLog = path.join(root, "fake-claude.log");
  const env = { ...process.env, ...fakeClaudeEnv(root, { FAKE_CLAUDE_LOG: claudeLog, ...extraEnv }) };
  return {
    repo,
    root,
    env,
    claudeLog,
    cleanup: () => {
      cleanRepo();
      cleanRoot();
    },
  };
}

export interface FakeClaudeInvocation {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export function readClaudeLog(world: E2eWorld): FakeClaudeInvocation[] {
  if (!fs.existsSync(world.claudeLog)) return [];
  return fs
    .readFileSync(world.claudeLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeClaudeInvocation);
}

/** REST + WS client against an in-process server. */
export class E2eServer {
  private constructor(readonly server: RunningServer) {}

  static async start(world: E2eWorld): Promise<E2eServer> {
    const s = new E2eServer(await startServer({ repoPath: world.repo, port: 0, env: world.env }));
    // Keep tests quiet on machines that have notify-send.
    await s.api("PUT", "/api/settings", { notifications: false });
    return s;
  }

  get base(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  async api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.request(method, url, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  request(method: string, url: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${url}`, {
      method,
      headers: { authorization: `Bearer ${this.server.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async saveGraph(graph: GraphInput): Promise<void> {
    await this.api("PUT", `/api/graphs/${graph.id}`, graph);
  }

  async startRun(graphId: string): Promise<RunDetail> {
    return this.api<RunDetail>("POST", `/api/graphs/${graphId}/runs`, {});
  }

  getRun(runId: string): Promise<RunDetail> {
    return this.api<RunDetail>("GET", `/api/runs/${runId}`);
  }

  async waitForRun(runId: string, statuses: string[], timeoutMs = 15_000): Promise<RunDetail> {
    let last: RunDetail | undefined;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      last = await this.getRun(runId);
      if (statuses.includes(last.run.status)) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run ${runId} never reached ${statuses.join("|")}; last: ${JSON.stringify(summarise(last))}`);
  }

  /** Current (latest attempt) node run of a node. */
  async nodeRun(runId: string, nodeId: string): Promise<NodeRun> {
    const detail = await this.getRun(runId);
    const runs = detail.nodeRuns.filter((n) => n.nodeId === nodeId).sort((a, b) => a.attempt - b.attempt);
    const nr = runs.at(-1);
    if (!nr) throw new Error(`no node run for ${nodeId}`);
    return nr;
  }

  async waitForNode(runId: string, nodeId: string, statuses: string[], timeoutMs = 15_000): Promise<NodeRun> {
    const end = Date.now() + timeoutMs;
    let last: NodeRun | undefined;
    while (Date.now() < end) {
      last = await this.nodeRun(runId, nodeId);
      if (statuses.includes(last.status)) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`node ${nodeId} never reached ${statuses.join("|")}; last: ${last?.status} ${last?.error ?? ""}`);
  }

  async connectWs(): Promise<WsTestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.server.port}/ws?t=${this.server.token}`);
    const client = new WsTestClient(ws);
    await client.waitFor((m) => m.type === "hello");
    return client;
  }

  close(): Promise<void> {
    return this.server.close();
  }
}

function summarise(detail: RunDetail | undefined) {
  return detail && { status: detail.run.status, nodes: detail.nodeRuns.map((n) => `${n.nodeId}#${n.attempt}:${n.status}:${n.error ?? ""}`) };
}

export class WsTestClient {
  readonly messages: ServerMessage[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => this.messages.push(ServerMessageSchema.parse(JSON.parse(String(raw)))));
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  subscribe(runId: string): void {
    this.send({ type: "subscribe", runId });
  }

  attach(ptyId: string): void {
    this.send({ type: "pty:attach", ptyId, cols: 120, rows: 40 });
  }

  input(ptyId: string, text: string): void {
    this.send({ type: "pty:input", ptyId, data: text });
  }

  /** Decoded output received for a PTY so far. */
  ptyText(ptyId: string): string {
    return this.messages
      .filter((m): m is Extract<ServerMessage, { type: "pty:data" }> => m.type === "pty:data" && m.ptyId === ptyId)
      .map((m) => Buffer.from(decodeBase64(m.data)).toString("utf8"))
      .join("");
  }

  nodeUpdates(nodeRunId?: string): NodeRun[] {
    return this.messages
      .filter((m): m is Extract<ServerMessage, { type: "node:update" }> => m.type === "node:update")
      .map((m) => m.nodeRun)
      .filter((nr) => nodeRunId === undefined || nr.id === nodeRunId);
  }

  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 15_000): Promise<ServerMessage> {
    return waitFor(() => this.messages.find(pred), timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

type NodeSpec = { id: string; type: string; label?: string; config?: Record<string, unknown>; onError?: "pause" | "fail-run" };

/** Linear chain graph (nodes left to right), auto completion without grace unless overridden. */
export function chainGraph(id: string, nodes: NodeSpec[], settings: Record<string, unknown> = {}): GraphInput {
  return {
    version: 1,
    id,
    name: id,
    settings: { defaults: { completion: { mode: "auto", graceSec: 0 } }, ...settings },
    nodes: nodes.map((n, i) => ({ label: n.id, ...n, position: { x: i * 250, y: 0 } })) as GraphInput["nodes"],
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i]!.id, target: n.id })),
  };
}

/** Async variant of helpers.waitFor. */
export async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`until timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
