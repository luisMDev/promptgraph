import { EventEmitter } from "node:events";
import type { Lane, NodeRun, RunSummary, ServerMessageOf } from "@promptgraph/shared";

/** Chat panel messages (§20.6), broadcast as-is by the WsHub. */
export type ChatServerMessage = ServerMessageOf<"chat:item" | "chat:delta" | "chat:status" | "chat:session" | "chat:deleted">;

/** Status that makes a node need the user (desktop notification, header counter). */
export type AttentionKind = "waiting_input" | "waiting_approval" | "idle";

/**
 * In-process events. Producers: engine (run/node/lane/attention), PtyManager (pty:*), GraphStore
 * (graphs:changed), ChatManager (chat). Consumers: WsHub (all but attention), Notifier (attention).
 */
export interface BusEvents {
  /** After every persisted change to a run or to the counters/usage derived from its node runs. */
  "run:update": { run: RunSummary };
  /** After every persisted change to a node run. */
  "node:update": { nodeRun: NodeRun };
  "lane:update": { lane: Lane };
  /** Raw PTY output chunk (already appended to the ring buffer). */
  "pty:data": { ptyId: string; data: Buffer };
  "pty:exit": { ptyId: string; code: number | null };
  "graphs:changed": { graphId: string };
  /** Chat panel (§20): every chat:* server message. */
  chat: { message: ChatServerMessage };
  /** A node entered an attention status (emitted once per transition). */
  attention: { kind: AttentionKind; nodeRun: NodeRun; nodeLabel: string; graphName: string; message: string | null };
}

export type BusEventName = keyof BusEvents;
export type BusListener<K extends BusEventName> = (payload: BusEvents[K]) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit<K extends BusEventName>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /** Returns an unsubscribe function. */
  on<K extends BusEventName>(event: K, listener: BusListener<K>): () => void {
    this.emitter.on(event, listener as (p: unknown) => void);
    return () => this.emitter.off(event, listener as (p: unknown) => void);
  }
}
