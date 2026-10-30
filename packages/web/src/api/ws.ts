import type { ClientMessage, ServerMessage } from "@promptgraph/shared";

export type ServerMessageListener = (msg: ServerMessage) => void;

/**
 * Single shared WebSocket to /ws with automatic reconnect (backoff ≤5s). On reconnect it re-sends
 * `subscribe` for subscribed runs and `pty:attach` for attached ptys. Messages are validated with
 * ServerMessageSchema; invalid ones are dropped.
 */
export class WsClient {
  connect(): void {
    throw new Error("not implemented");
  }
  send(msg: ClientMessage): void {
    throw new Error("not implemented");
  }
  /** Returns unsubscribe. */
  onMessage(listener: ServerMessageListener): () => void {
    throw new Error("not implemented");
  }
  subscribeRun(runId: string): void {
    throw new Error("not implemented");
  }
  unsubscribeRun(runId: string): void {
    throw new Error("not implemented");
  }
  /** Data listener receives decoded bytes; returns detach. */
  attachPty(ptyId: string, onData: (bytes: Uint8Array) => void, size?: { cols: number; rows: number }): () => void {
    throw new Error("not implemented");
  }
  close(): void {
    throw new Error("not implemented");
  }
}

export const wsClient = new WsClient();
