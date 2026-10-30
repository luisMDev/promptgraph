import type Database from "better-sqlite3";
import type {
  Graph,
  Lane,
  LaneStatus,
  NodeRun,
  NodeStatus,
  Run,
  RunEvent,
  RunStatus,
  RunSummary,
} from "@promptgraph/shared";

/** Opens (creating dirs) and migrates the database. WAL mode, foreign keys on. `":memory:"` for tests. */
export function openDatabase(file: string): Database.Database {
  throw new Error("not implemented");
}

export interface NewRun {
  id: string;
  repoPath: string;
  graph: Graph;
  graphHash: string;
  shortId: string;
  startedAt: number;
}

export type RunPatch = Partial<Pick<Run, "status" | "error" | "finishedAt" | "cleanedUp">>;

export type NewLane = Omit<Lane, "pushed" | "status"> & { status?: LaneStatus };
export type LanePatch = Partial<Pick<Lane, "status" | "pushed" | "worktreePath">>;

export type NewNodeRun = Pick<NodeRun, "id" | "runId" | "nodeId" | "iteration" | "attempt" | "laneId" | "status">;
/** Any mutable field; `updatedAt` is set by the store. */
export type NodeRunPatch = Partial<Omit<NodeRun, "id" | "runId" | "nodeId" | "iteration" | "attempt" | "updatedAt">>;

/**
 * Synchronous DAO over better-sqlite3. Pure persistence: no events, no business rules.
 * JSON columns are (de)serialised here; rows are returned as shared DTOs.
 */
export class Store {
  constructor(readonly db: Database.Database) {}

  // runs ---------------------------------------------------------------------
  insertRun(run: NewRun): Run {
    throw new Error("not implemented");
  }
  updateRun(id: string, patch: RunPatch): Run {
    throw new Error("not implemented");
  }
  getRun(id: string): Run | undefined {
    throw new Error("not implemented");
  }
  /** Summary incl. counters (pendingApprovals, waitingInput) and usage summed over node run outputs. */
  getRunSummary(id: string): RunSummary | undefined {
    throw new Error("not implemented");
  }
  /** Newest first. */
  listRuns(filter: { repoPath: string; graphId?: string; limit: number }): RunSummary[] {
    throw new Error("not implemented");
  }
  listRunsByStatus(statuses: readonly RunStatus[]): Run[] {
    throw new Error("not implemented");
  }

  // lanes --------------------------------------------------------------------
  insertLane(lane: NewLane): Lane {
    throw new Error("not implemented");
  }
  updateLane(runId: string, laneId: string, patch: LanePatch): Lane {
    throw new Error("not implemented");
  }
  listLanes(runId: string): Lane[] {
    throw new Error("not implemented");
  }

  // node runs ----------------------------------------------------------------
  insertNodeRun(nr: NewNodeRun): NodeRun {
    throw new Error("not implemented");
  }
  updateNodeRun(id: string, patch: NodeRunPatch): NodeRun {
    throw new Error("not implemented");
  }
  getNodeRun(id: string): NodeRun | undefined {
    throw new Error("not implemented");
  }
  /** Ordered by node id, iteration, attempt. */
  listNodeRuns(runId: string): NodeRun[] {
    throw new Error("not implemented");
  }
  /** Across all runs (crash recovery, pending approvals). */
  listNodeRunsByStatus(statuses: readonly NodeStatus[]): NodeRun[] {
    throw new Error("not implemented");
  }
  findNodeRunByPtyId(ptyId: string): NodeRun | undefined {
    throw new Error("not implemented");
  }

  // events -------------------------------------------------------------------
  appendEvent(runId: string, nodeRunId: string | null, type: string, payload: unknown): RunEvent {
    throw new Error("not implemented");
  }
  listEvents(runId: string, opts?: { afterId?: number; limit?: number }): RunEvent[] {
    throw new Error("not implemented");
  }

  // graph meta (§14) ---------------------------------------------------------
  getKnownGraphHash(repoPath: string, graphId: string): string | undefined {
    throw new Error("not implemented");
  }
  setKnownGraphHash(repoPath: string, graphId: string, hash: string): void {
    throw new Error("not implemented");
  }

  /** Runs `fn` in a transaction. */
  transaction<T>(fn: () => T): T {
    throw new Error("not implemented");
  }
}
