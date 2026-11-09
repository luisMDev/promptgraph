import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { getPaths } from "../../src/config/paths.js";
import { tokenPath } from "../../src/config/token.js";
import { startDaemon, type RunningDaemon } from "../../src/daemon/start.js";
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

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A `promptgraph <repo> --foreground` child process (crash tests SIGKILL it). */
export interface ForegroundCli {
  child: ChildProcess;
  origin: string;
  repoId: string;
  token: string;
  /** fetch on the daemon with the Bearer token; repository routes are given relative to `/api/repos/<repoId>`. */
  fetch(method: string, repoRoute: string): Promise<Response>;
}

/**
 * Spawns `src/cli/index.ts <repo> --foreground --no-open --port 0` (tsx as an in-process loader, not its
 * CLI wrapper, so SIGKILL hits the daemon itself), parses `Open: http://127.0.0.1:<port>/r/<repoId>` and
 * reads the token from `<PG_HOME>/token`.
 */
export async function spawnForegroundCli(world: E2eWorld, onCleanup: (fn: () => void) => void): Promise<ForegroundCli> {
  const child = spawn(process.execPath, ["--import", "tsx", "--conditions=source", "src/cli/index.ts", world.repo, "--foreground", "--no-open", "--port", "0"], {
    cwd: SERVER_ROOT,
    env: world.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onCleanup(() => void child.kill("SIGKILL"));
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
  const match = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`promptgraph exited (${child.exitCode}):\n${output}`);
    return /Open: (http:\/\/127\.0\.0\.1:\d+)\/r\/(\S+)/.exec(output);
  }, 20_000);
  if (!/^Listening: http:\/\/127\.0\.0\.1:\d+ \(pid \d+, promptgraph \S+\)$/m.test(output)) throw new Error(`no Listening line:\n${output}`);
  const origin = match[1]!;
  const repoId = match[2]!;
  const token = fs.readFileSync(tokenPath(getPaths(world.env)), "utf8").trim();
  return {
    child,
    origin,
    repoId,
    token,
    fetch: (method, repoRoute) =>
      fetch(`${origin}/api/repos/${repoId}${repoRoute}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }),
  };
}

/** Token of the in-process test daemons (in memory: `<PG_HOME>/token` is only read by the CLI-spawned ones). */
export const E2E_TOKEN = "e2e-token-0123456789";

/** Repository routes a test may write without the `/api/repos/<id>` prefix (`/api/graphs/x` → `/api/repos/<id>/graphs/x`). */
const REPO_ROUTE = /^\/api\/(graphs|runs|node-runs|ptys|pending|commands|claude-setup)(\/|\?|$)/;

/** REST + WS client against an in-process daemon with one registered repository (the world's repo). */
export class E2eServer {
  private constructor(
    readonly server: RunningDaemon,
    readonly token: string,
    readonly repoId: string,
  ) {}

  static async start(world: E2eWorld, repoPath: string = world.repo): Promise<E2eServer> {
    const daemon = await startDaemon({ port: 0, env: world.env, token: E2E_TOKEN, warnings: [] });
    const repoId = (await daemon.ctx.registry.add(repoPath)).id;
    const s = new E2eServer(daemon, E2E_TOKEN, repoId);
    // Keep tests quiet on machines that have notify-send.
    await s.api("PUT", "/api/settings", { notifications: false });
    return s;
  }

  /** Registers another repository in the same daemon; a client scoped to it. */
  async addRepo(repoPath: string): Promise<E2eServer> {
    const repo = await this.api<{ id: string }>("POST", "/api/repos", { path: repoPath });
    return new E2eServer(this.server, this.token, repo.id);
  }

  /** `/api/repos/<repoId>/…` for a repository route given without the prefix; anything else unchanged. */
  scoped(url: string): string {
    return REPO_ROUTE.test(url) ? `/api/repos/${encodeURIComponent(this.repoId)}${url.slice("/api".length)}` : url;
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
    return fetch(`${this.base}${this.scoped(url)}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
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

  /** A WebSocket (Bearer header) subscribed to this repository (`repo:subscribe`) unless `subscribe` is false. */
  async connectWs(opts: { subscribe?: boolean } = {}): Promise<WsTestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.server.port}/ws`, { headers: { authorization: `Bearer ${this.token}` } });
    const client = new WsTestClient(ws);
    await client.waitFor((m) => m.type === "hello");
    if (opts.subscribe ?? true) {
      client.send({ type: "repo:subscribe", repoId: this.repoId });
      client.send({ type: "ping" });
      await client.waitFor((m) => m.type === "pong");
    }
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

/** Linear chain graph (nodes left to right), auto completion without grace and no run brief unless overridden. */
export function chainGraph(id: string, nodes: NodeSpec[], settings: Record<string, unknown> = {}): GraphInput {
  return {
    version: 1,
    id,
    name: id,
    // The run brief (on by default, §13.6) would add claude -p calls to the fake claude log and to the usage totals.
    settings: { defaults: { completion: { mode: "auto", graceSec: 0 } }, brief: { enabled: false }, ...settings },
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
