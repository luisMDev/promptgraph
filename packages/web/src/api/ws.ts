import { ServerMessageSchema, decodeBase64, type ClientMessage, type ServerMessage } from "@promptgraph/shared";
import { devToken } from "./token";

export type ServerMessageListener = (msg: ServerMessage) => void;
export type ConnectionListener = (connected: boolean) => void;

interface PtyAttachment {
  listeners: Set<(bytes: Uint8Array) => void>;
  size?: { cols: number; rows: number };
}

const MAX_BACKOFF_MS = 5000;

/**
 * Single shared WebSocket to /ws with automatic reconnect (backoff ≤5s). On reconnect it re-sends
 * `subscribe` for subscribed runs and `pty:attach` for attached ptys. Messages are validated with
 * ServerMessageSchema; invalid ones are dropped.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<ServerMessageListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly runs = new Set<string>();
  private readonly ptys = new Map<string, PtyAttachment>();
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private connected = false;

  constructor(private readonly url: () => string = defaultUrl) {}

  connect(): void {
    this.closed = false;
    if (this.socket) return;
    const socket = new WebSocket(this.url());
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.backoff = 500;
      this.setConnected(true);
      for (const runId of this.runs) this.rawSend({ type: "subscribe", runId });
      for (const [ptyId, a] of this.ptys) this.rawSend({ type: "pty:attach", ptyId, ...a.size });
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.handleFrame(ev.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      if (!this.closed) this.scheduleReconnect();
    };
  }

  send(msg: ClientMessage): void {
    this.rawSend(msg);
  }

  /** Returns unsubscribe. */
  onMessage(listener: ServerMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connection state changes; returns unsubscribe. */
  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  subscribeRun(runId: string): void {
    if (this.runs.has(runId)) return;
    this.runs.add(runId);
    this.rawSend({ type: "subscribe", runId });
  }

  unsubscribeRun(runId: string): void {
    if (!this.runs.delete(runId)) return;
    this.rawSend({ type: "unsubscribe", runId });
  }

  /** Data listener receives decoded bytes; returns detach. */
  attachPty(ptyId: string, onData: (bytes: Uint8Array) => void, size?: { cols: number; rows: number }): () => void {
    let a = this.ptys.get(ptyId);
    if (!a) {
      a = { listeners: new Set(), size };
      this.ptys.set(ptyId, a);
      this.rawSend({ type: "pty:attach", ptyId, ...size });
    }
    a.listeners.add(onData);
    const attachment = a;
    return () => {
      attachment.listeners.delete(onData);
      if (attachment.listeners.size === 0 && this.ptys.get(ptyId) === attachment) {
        this.ptys.delete(ptyId);
        this.rawSend({ type: "pty:detach", ptyId });
      }
    };
  }

  /** Sends a resize and remembers the size for re-attach after reconnect. */
  resizePty(ptyId: string, cols: number, rows: number): void {
    const a = this.ptys.get(ptyId);
    if (a) a.size = { cols, rows };
    this.rawSend({ type: "pty:resize", ptyId, cols, rows });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    if (this.connected) this.setConnected(false);
  }

  private rawSend(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === "pty:data") {
      const a = this.ptys.get(msg.ptyId);
      if (a) {
        const bytes = decodeBase64(msg.data);
        for (const l of a.listeners) l(bytes);
      }
    }
    for (const l of this.listeners) l(msg);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setConnected(v: boolean): void {
    this.connected = v;
    for (const l of this.connectionListeners) l(v);
  }
}

function defaultUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = devToken();
  const qs = token ? `?t=${encodeURIComponent(token)}` : "";
  return `${proto}//${window.location.host}/ws${qs}`;
}

export const wsClient = new WsClient();
