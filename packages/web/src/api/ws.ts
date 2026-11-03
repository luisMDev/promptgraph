import { WS_CLOSE_SIGNED_OUT, ServerMessageSchema, decodeBase64, type ClientMessage, type ServerMessage } from "@promptgraph/shared";
import { BUILD_VERSION } from "../lib/version";
import { sessionValid } from "./rest";

export type ServerMessageListener = (msg: ServerMessage) => void;

/** DESIGN §13.5: `unreachable` after 15 s without a connection; the client keeps retrying either way. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "unreachable";

export interface WsStatus {
  connection: ConnectionState;
  /** Closed with 4401, or the daemon answered 401: no more reconnects. */
  signedOut: boolean;
  /** `hello.version` of the daemon, once connected. */
  serverVersion: string | null;
  /** The daemon runs another version than this web build. */
  versionMismatch: boolean;
}
export type StatusListener = (status: WsStatus) => void;

export interface WsClientOptions {
  /** Socket URL; the default is `/ws` on the page's origin (it carries no credential). */
  url?: () => string;
  /**
   * REST probe after a connect that never opened (browsers hide the status of a refused upgrade): false =
   * signed out (401), true or null (unreachable) = keep retrying.
   */
  checkSession?: (() => Promise<boolean | null>) | null;
  /** Version of this build; null disables the version check. */
  buildVersion?: string | null;
  unreachableAfterMs?: number;
}

interface PtyAttachment {
  listeners: Set<(bytes: Uint8Array) => void>;
  size?: { cols: number; rows: number };
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;
export const UNREACHABLE_AFTER_MS = 15_000;

/**
 * One WebSocket per page to /ws (DESIGN §12.2). Run and repository subscriptions are reference-counted
 * (two views on one run share one `subscribe`) and re-sent after a reconnect, as are PTY attachments.
 * Close code 4401 (token rotated, session revoked) means signed out: it stops. Any other failure reconnects
 * forever with backoff ≤ 5 s, `reconnecting` and then `unreachable` after 15 s. Messages are validated with
 * ServerMessageSchema; invalid ones are dropped.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<ServerMessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly runs = new Map<string, number>();
  private readonly repos = new Map<string, number>();
  private readonly ptys = new Map<string, PtyAttachment>();
  private backoff = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unreachableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private opened = false;
  private state: WsStatus = { connection: "connecting", signedOut: false, serverVersion: null, versionMismatch: false };
  private readonly url: () => string;
  private readonly checkSession: (() => Promise<boolean | null>) | null;
  private readonly buildVersion: string | null;
  private readonly unreachableAfterMs: number;

  constructor(opts: WsClientOptions = {}) {
    this.url = opts.url ?? defaultUrl;
    this.checkSession = opts.checkSession ?? null;
    this.buildVersion = opts.buildVersion ?? null;
    this.unreachableAfterMs = opts.unreachableAfterMs ?? UNREACHABLE_AFTER_MS;
  }

  status(): WsStatus {
    return this.state;
  }

  /** Status changes; returns unsubscribe. */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Returns unsubscribe. */
  onMessage(listener: ServerMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    this.closed = false;
    if (this.socket || this.state.signedOut) return;
    this.armUnreachable();
    const socket = new WebSocket(this.url());
    this.socket = socket;
    this.opened = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.backoff = MIN_BACKOFF_MS;
      this.clearUnreachable();
      this.setStatus({ connection: "open" });
      for (const repoId of this.repos.keys()) this.rawSend({ type: "repo:subscribe", repoId });
      for (const runId of this.runs.keys()) this.rawSend({ type: "subscribe", runId });
      for (const [ptyId, a] of this.ptys) this.rawSend({ type: "pty:attach", ptyId, ...a.size });
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.handleFrame(ev.data);
    };
    socket.onclose = (ev?: { code?: number }) => {
      if (this.socket !== socket) return;
      this.socket = null;
      const neverOpened = !this.opened;
      if (this.closed) return;
      if (ev?.code === WS_CLOSE_SIGNED_OUT) {
        this.signOut();
        return;
      }
      if (this.state.connection === "open") this.setStatus({ connection: "reconnecting" });
      this.armUnreachable();
      if (neverOpened && this.checkSession) void this.checkThenReconnect(this.checkSession);
      else this.scheduleReconnect();
    };
  }

  /** The session is gone (close 4401, or a REST 401): stop and never reconnect. */
  signOut(): void {
    if (this.state.signedOut) return;
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setStatus({ signedOut: true, connection: this.state.connection === "open" ? "reconnecting" : this.state.connection });
  }

  send(msg: ClientMessage): void {
    this.rawSend(msg);
  }

  /** Reference-counted `repo:subscribe`; returns the (idempotent) unsubscribe. */
  subscribeRepo(repoId: string): () => void {
    return this.refCounted(this.repos, repoId, { type: "repo:subscribe", repoId }, { type: "repo:unsubscribe", repoId });
  }

  /** Reference-counted `subscribe` to a run; returns the (idempotent) unsubscribe. */
  subscribeRun(runId: string): () => void {
    return this.refCounted(this.runs, runId, { type: "subscribe", runId }, { type: "unsubscribe", runId });
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
    this.stopTimers();
    this.socket?.close();
    this.socket = null;
  }

  private refCounted(counts: Map<string, number>, id: string, on: ClientMessage, off: ClientMessage): () => void {
    const n = counts.get(id) ?? 0;
    counts.set(id, n + 1);
    if (n === 0) this.rawSend(on);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (counts.get(id) ?? 1) - 1;
      if (left > 0) {
        counts.set(id, left);
        return;
      }
      counts.delete(id);
      this.rawSend(off);
    };
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
    if (msg.type === "hello") {
      this.setStatus({ serverVersion: msg.version, versionMismatch: this.buildVersion !== null && msg.version !== this.buildVersion });
    } else if (msg.type === "pty:data") {
      const a = this.ptys.get(msg.ptyId);
      if (a) {
        const bytes = decodeBase64(msg.data);
        for (const l of a.listeners) l(bytes);
      }
    }
    for (const l of this.listeners) l(msg);
  }

  private async checkThenReconnect(check: () => Promise<boolean | null>): Promise<void> {
    if ((await check()) === false) {
      this.signOut();
      return;
    }
    if (!this.closed && !this.state.signedOut) this.scheduleReconnect();
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

  /** Starts the 15 s countdown to `unreachable` unless one is already running. */
  private armUnreachable(): void {
    if (this.unreachableTimer || this.state.connection === "unreachable") return;
    this.unreachableTimer = setTimeout(() => {
      this.unreachableTimer = null;
      if (!this.state.signedOut && this.state.connection !== "open") this.setStatus({ connection: "unreachable" });
    }, this.unreachableAfterMs);
  }

  private clearUnreachable(): void {
    if (this.unreachableTimer) clearTimeout(this.unreachableTimer);
    this.unreachableTimer = null;
  }

  private stopTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearUnreachable();
  }

  private setStatus(patch: Partial<WsStatus>): void {
    const next = { ...this.state, ...patch };
    if (
      next.connection === this.state.connection &&
      next.signedOut === this.state.signedOut &&
      next.serverVersion === this.state.serverVersion &&
      next.versionMismatch === this.state.versionMismatch
    )
      return;
    this.state = next;
    for (const l of this.statusListeners) l(next);
  }
}

function defaultUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** The page's socket. */
export const wsClient = new WsClient({ checkSession: sessionValid, buildVersion: BUILD_VERSION });
