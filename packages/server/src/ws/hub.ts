import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ClientMessageSchema, type ClientMessage, type ServerMessage } from "@promptgraph/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AppContext } from "../app/context.js";
import { VERSION } from "../config/version.js";
import { isAuthorized, isLocalRequest } from "../http/auth.js";
import { errorMessage } from "../util/text.js";

/** Replay is sent in chunks of at most this many bytes (before base64). */
export const REPLAY_CHUNK_BYTES = 64 * 1024;
/**
 * A client whose send buffer grows beyond this is too slow to keep up with PTY output; it is
 * disconnected (it reconnects and re-attaches, getting a fresh replay) instead of buffering unboundedly.
 */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

interface Client {
  ws: WebSocket;
  runs: Set<string>;
  ptys: Set<string>;
  alive: boolean;
}

/**
 * WebSocket hub on /ws (§12.2, protocol in shared/ws.ts). Upgrade requires localhost Host/Origin and
 * isAuthorized(). On connect sends `hello`. Bus → clients: run:update and graphs:changed to all;
 * node:update/lane:update to subscribers of the run; pty:data (base64) / pty:exit to attached clients.
 * Client messages are validated with ClientMessageSchema; pty:attach replies pty:attached + replay;
 * pty:input → PtyManager.userInput (live only, else pty:error).
 */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Set<Client>();
  private readonly unsubscribe: Array<() => void> = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private server: Server | null = null;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head);

  constructor(private readonly ctx: AppContext) {}

  attach(server: Server): void {
    this.server = server;
    server.on("upgrade", this.onUpgrade);
    const { bus } = this.ctx;
    this.unsubscribe.push(
      bus.on("run:update", ({ run }) => this.broadcast({ type: "run:update", run }, () => true)),
      bus.on("graphs:changed", ({ graphId }) => this.broadcast({ type: "graphs:changed", graphId }, () => true)),
      bus.on("node:update", ({ nodeRun }) => this.broadcast({ type: "node:update", nodeRun }, (c) => c.runs.has(nodeRun.runId))),
      bus.on("lane:update", ({ lane }) => this.broadcast({ type: "lane:update", lane }, (c) => c.runs.has(lane.runId))),
      bus.on("pty:data", ({ ptyId, data }) =>
        this.broadcast({ type: "pty:data", ptyId, data: data.toString("base64") }, (c) => c.ptys.has(ptyId)),
      ),
      bus.on("pty:exit", ({ ptyId, code }) => this.broadcast({ type: "pty:exit", ptyId, code }, (c) => c.ptys.has(ptyId))),
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
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") return void rejectUpgrade(socket, 404, "Not Found");
    if (!isLocalRequest(req.headers.host, req.headers.origin, this.ctx.port)) return void rejectUpgrade(socket, 403, "Forbidden");
    if (!isAuthorized(this.ctx.token, req)) return void rejectUpgrade(socket, 401, "Unauthorized");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
  }

  private connect(ws: WebSocket): void {
    const client: Client = { ws, runs: new Set(), ptys: new Set(), alive: true };
    this.clients.add(client);
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (raw, isBinary) => this.receive(client, raw, isBinary));
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => ws.terminate());
    this.send(client, { type: "hello", version: VERSION });
  }

  private receive(client: Client, raw: RawData, isBinary: boolean): void {
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

