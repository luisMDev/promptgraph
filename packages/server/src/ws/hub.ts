import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ClientMessageSchema, SESSION_COOKIE, WS_CLOSE_SIGNED_OUT, type ClientMessage, type ServerMessage } from "@promptgraph/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DaemonContext } from "../daemon/context.js";
import { VERSION } from "../config/version.js";
import { isLocalRequest } from "../http/auth.js";
import { authenticate, cookieValue, type Credential } from "../http/credentials.js";
import { isCrossSiteCookieRequest } from "../http/fetch-metadata.js";
import { errorMessage } from "../util/text.js";

/** Replay is sent in chunks of at most this many bytes (before base64). */
export const REPLAY_CHUNK_BYTES = 64 * 1024;
/**
 * A client whose send buffer grows beyond this is too slow to keep up with PTY output; it is
 * disconnected (it reconnects and re-attaches, getting a fresh replay) instead of buffering unboundedly.
 */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** repo:changed bursts (one per node transition) are coalesced into one repo:status per repository. */
export const REPO_STATUS_DEBOUNCE_MS = 250;
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** A signed-out peer that does not finish the closing handshake within this is terminated. */
export const SIGN_OUT_TERMINATE_MS = 1000;

interface Client {
  ws: WebSocket;
  /** Repositories subscribed with repo:subscribe (the daemon scopes run:update / graphs:changed by them). */
  repos: Set<string>;
  runs: Set<string>;
  ptys: Set<string>;
  alive: boolean;
  /** SHA-256 of the session cookie it connected with; null for a Bearer client. */
  sessionHash: string | null;
}

/**
 * WebSocket hub on /ws (DESIGN §12.2, protocol in shared/ws.ts), one per daemon. Upgrade requires
 * localhost Host/Origin and the Bearer token or a live session cookie (with the Fetch Metadata rule of
 * HTTP; the URL carries no credential). On connect sends `hello`. `session:revoked` closes the sockets
 * of those sessions and `token:rotated` every socket, with 4401 (WS_CLOSE_SIGNED_OUT).
 * Bus → clients: run:update and graphs:changed to clients subscribed to their repository
 * (`repo:subscribe`, which also activates it); repo:changed debounced per repository into repo:status
 * (RepoSummary) to every client; repo:removed to every client; node:update/lane:update to subscribers
 * of the run; pty:data (base64) / pty:exit to attached clients. Client messages are validated with
 * ClientMessageSchema; pty:attach replies pty:attached + replay; pty:input → PtyManager.userInput (live
 * only, else pty:error).
 */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Set<Client>();
  private readonly unsubscribe: Array<() => void> = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly statusTimers = new Map<string, NodeJS.Timeout>();
  private server: Server | null = null;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head);

  constructor(private readonly ctx: DaemonContext) {}

  attach(server: Server): void {
    this.server = server;
    server.on("upgrade", this.onUpgrade);
    const { bus } = this.ctx;
    this.unsubscribe.push(
      bus.on("run:update", ({ repoId, run }) => this.broadcast({ type: "run:update", repoId, run }, (c) => c.repos.has(repoId))),
      bus.on("graphs:changed", ({ repoId, graphId }) => this.broadcast({ type: "graphs:changed", repoId, graphId }, (c) => c.repos.has(repoId))),
      bus.on("repo:changed", ({ repoId }) => this.scheduleStatus(repoId)),
      bus.on("repo:removed", ({ repoId }) => {
        clearTimeout(this.statusTimers.get(repoId));
        this.statusTimers.delete(repoId);
        for (const c of this.clients) c.repos.delete(repoId);
        this.broadcast({ type: "repo:removed", repoId }, () => true);
      }),
      bus.on("node:update", ({ nodeRun }) => this.broadcast({ type: "node:update", nodeRun }, (c) => c.runs.has(nodeRun.runId))),
      bus.on("lane:update", ({ lane }) => this.broadcast({ type: "lane:update", lane }, (c) => c.runs.has(lane.runId))),
      bus.on("pty:data", ({ ptyId, data }) =>
        this.broadcast({ type: "pty:data", ptyId, data: data.toString("base64") }, (c) => c.ptys.has(ptyId)),
      ),
      bus.on("pty:exit", ({ ptyId, code }) => this.broadcast({ type: "pty:exit", ptyId, code }, (c) => c.ptys.has(ptyId))),
      bus.on("session:revoked", ({ idHashes }) => {
        const revoked = new Set(idHashes);
        this.signOut((c) => c.sessionHash !== null && revoked.has(c.sessionHash));
      }),
      bus.on("token:rotated", () => this.signOut(() => true)),
    );
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async close(): Promise<void> {
    this.server?.off("upgrade", this.onUpgrade);
    this.server = null;
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const t of this.statusTimers.values()) clearTimeout(t);
    this.statusTimers.clear();
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") return void rejectUpgrade(socket, 404, "Not Found");
    if (!isLocalRequest(req.headers.host, req.headers.origin, this.ctx.port)) return void rejectUpgrade(socket, 403, "Forbidden");
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const authorization = header("authorization");
    const cookie = header("cookie");
    if (!authorization && cookieValue(cookie, SESSION_COOKIE) !== null && isCrossSiteCookieRequest(pathname, header)) {
      return void rejectUpgrade(socket, 403, "Forbidden");
    }
    const credential = authenticate({ getToken: () => this.ctx.getToken(), sessions: this.ctx.sessions }, { authorization, cookie });
    if (!credential) return void rejectUpgrade(socket, 401, "Unauthorized");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, credential));
  }

  /**
   * Closes the matching sockets with 4401: their client stops reconnecting and shows "Signed out".
   * The client is unregistered first, so `receive` ignores anything it sends while the closing
   * handshake runs; a peer that never answers the close frame is terminated after a short grace
   * period instead of holding the socket for the full `ws` close timeout.
   */
  private signOut(match: (c: Client) => boolean): void {
    for (const c of [...this.clients]) {
      if (!match(c)) continue;
      this.clients.delete(c);
      c.ws.close(WS_CLOSE_SIGNED_OUT, "signed out");
      const kill = setTimeout(() => c.ws.terminate(), SIGN_OUT_TERMINATE_MS);
      kill.unref();
      c.ws.once("close", () => clearTimeout(kill));
    }
  }

  private connect(ws: WebSocket, credential: Credential): void {
    const sessionHash = credential.kind === "session" ? credential.session.idHash : null;
    const client: Client = { ws, repos: new Set(), runs: new Set(), ptys: new Set(), alive: true, sessionHash };
    this.clients.add(client);
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (raw, isBinary) => this.receive(client, raw, isBinary));
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => ws.terminate());
    this.send(client, { type: "hello", version: VERSION });
  }

  private receive(client: Client, raw: RawData, isBinary: boolean): void {
    // A signed-out (revoked, rotated) or closing socket must not act on the daemon: `ws` still emits
    // 'message' while CLOSING.
    if (!this.clients.has(client) || client.ws.readyState !== WebSocket.OPEN) return;
    let data: unknown;
    try {
      data = isBinary ? undefined : JSON.parse(rawToString(raw));
    } catch {
      // handled below
    }
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) return this.send(client, { type: "error", message: "Invalid message" });
    this.handle(client, parsed.data);
  }

  private handle(client: Client, msg: ClientMessage): void {
    const { ptys } = this.ctx;
    switch (msg.type) {
      case "repo:subscribe":
        client.repos.add(msg.repoId);
        // Activation failures are reported in the repository's status (repo:status), not here.
        this.ctx.registry.activate(msg.repoId).catch((err: unknown) => {
          if (client.repos.has(msg.repoId)) this.send(client, { type: "error", message: errorMessage(err) });
        });
        return;
      case "repo:unsubscribe":
        client.repos.delete(msg.repoId);
        return;
      case "subscribe":
        client.runs.add(msg.runId);
        return;
      case "unsubscribe":
        client.runs.delete(msg.runId);
        return;
      case "pty:attach":
        return this.attachPty(client, msg.ptyId, msg.cols && msg.rows ? { cols: msg.cols, rows: msg.rows } : undefined);
      case "pty:detach":
        client.ptys.delete(msg.ptyId);
        return;
      case "pty:input":
        try {
          ptys.userInput(msg.ptyId, msg.data);
        } catch (err) {
          this.send(client, { type: "pty:error", ptyId: msg.ptyId, message: errorMessage(err) });
        }
        return;
      case "pty:resize":
        ptys.resize(msg.ptyId, msg.cols, msg.rows);
        return;
      case "ping":
        return this.send(client, { type: "pong" });
    }
  }

  /**
   * Synchronous on purpose: PtyManager.attach snapshots the ring buffer and the client joins the pty's
   * audience in the same tick, so no live chunk is lost or duplicated between replay and live data.
   */
  private attachPty(client: Client, ptyId: string, size?: { cols: number; rows: number }): void {
    let result;
    try {
      result = this.ctx.ptys.attach(ptyId, size);
    } catch (err) {
      return this.send(client, { type: "pty:error", ptyId, message: errorMessage(err) });
    }
    client.ptys.add(ptyId);
    this.send(client, { type: "pty:attached", ptyId, live: result.live, cols: result.cols, rows: result.rows });
    for (let off = 0; off < result.replay.length; off += REPLAY_CHUNK_BYTES) {
      const chunk = result.replay.subarray(off, off + REPLAY_CHUNK_BYTES);
      this.send(client, { type: "pty:data", ptyId, data: chunk.toString("base64") });
    }
  }

  private scheduleStatus(repoId: string): void {
    if (this.statusTimers.has(repoId)) return;
    const timer = setTimeout(() => {
      this.statusTimers.delete(repoId);
      const repo = this.ctx.registry.summary(repoId);
      if (repo) this.broadcast({ type: "repo:status", repo }, () => true);
    }, REPO_STATUS_DEBOUNCE_MS);
    timer.unref();
    this.statusTimers.set(repoId, timer);
  }

  private broadcast(msg: ServerMessage, to: (c: Client) => boolean): void {
    let frame: string | null = null;
    for (const c of this.clients) {
      if (!to(c)) continue;
      frame ??= JSON.stringify(msg);
      this.sendFrame(c, frame);
    }
  }

  private send(client: Client, msg: ServerMessage): void {
    this.sendFrame(client, JSON.stringify(msg));
  }

  private sendFrame(client: Client, frame: string): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.clients.delete(client);
      client.ws.terminate();
      return;
    }
    client.ws.send(frame);
  }

  private checkAlive(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        this.clients.delete(c);
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw).toString("utf8");
}

