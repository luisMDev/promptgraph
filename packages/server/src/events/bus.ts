import { EventEmitter } from "node:events";
import type { Lane, NodeRun, RunSummary } from "@promptgraph/shared";

/** Status that makes a node need the user (desktop notification, header counter). */
export type AttentionKind = "waiting_input" | "waiting_approval" | "idle";

/**
 * In-process events. Producers: engine (run/node/lane/attention/repo:changed), PtyManager (pty:*),
 * GraphStore (graphs:changed), the repository registry and sessions (repo:*, session:revoked).
 * Consumers: WsHub (all but attention), Notifier (attention).
 */
export interface BusEvents {
  /** After every persisted change to a run or to the counters/usage derived from its node runs. */
  "run:update": { repoId: string; run: RunSummary };
  /** After every persisted change to a node run. */
  "node:update": { nodeRun: NodeRun };
  "lane:update": { lane: Lane };
  /** Raw PTY output chunk (already appended to the ring buffer). */
  "pty:data": { ptyId: string; data: Buffer };
  "pty:exit": { ptyId: string; code: number | null };
  "graphs:changed": { repoId: string; graphId: string };
  /** A node entered an attention status (emitted once per transition). */
  attention: {
    kind: AttentionKind;
    nodeRun: NodeRun;
    nodeLabel: string;
    graphName: string;
    message: string | null;
    repo: { id: string; name: string };
  };
  /**
   * A repository's Home counters or state may have changed: a run was created, a run or node run
   * changed status, or it was added/activated/failed to activate. The hub debounces it into repo:status.
   */
  "repo:changed": { repoId: string };
  /** A repository was removed from the registry. */
  "repo:removed": { repoId: string };
  /** Browser sessions were revoked (or every session, on token rotation): their sockets are closed. */
  "session:revoked": { idHashes: string[] };
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
