import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  emptyUsage,
  sumUsage,
  type Graph,
  type Lane,
  type LaneStatus,
  type LoopState,
  type NodeRun,
  type NodeRunOutput,
  type NodeStatus,
  type Run,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  type TokenUsage,
} from "@promptgraph/shared";
import { MIGRATIONS } from "./schema.js";

/** Opens (creating dirs) and migrates the database. WAL mode, foreign keys on. `":memory:"` for tests. */
export function openDatabase(file: string): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export interface NewRun {
  id: string;
  repoPath: string;
  graph: Graph;
  graphHash: string;
  shortId: string;
  startedAt: number;
}

export type RunPatch = Partial<Pick<Run, "status" | "error" | "finishedAt" | "cleanedUp">> & {
  /** Phase 2 loop counters (§15.4), exposed as RunDetail.loops. */
  loops?: LoopState[];
};

export type NewLane = Omit<Lane, "pushed" | "status"> & { status?: LaneStatus };
export type LanePatch = Partial<Pick<Lane, "status" | "pushed" | "worktreePath">>;

export type NewNodeRun = Pick<NodeRun, "id" | "runId" | "nodeId" | "iteration" | "attempt" | "laneId" | "status">;
/** Any mutable field; `updatedAt` is set by the store. */
export type NodeRunPatch = Partial<Omit<NodeRun, "id" | "runId" | "nodeId" | "iteration" | "attempt" | "updatedAt">>;

interface RunRow {
  id: string;
  repo_path: string;
  graph_id: string;
  graph_name: string;
  graph_snapshot: string;
  graph_hash: string;
  short_id: string;
  status: RunStatus;
  error: string | null;
  cleaned_up: number;
  loops: string | null;
  started_at: number;
  finished_at: number | null;
}

interface LaneRow {
  id: string;
  run_id: string;
  idx: number;
  branch: string;
  worktree_path: string;
  base_ref: string;
  status: LaneStatus;
  pushed: number;
}

interface NodeRunRow {
  id: string;
  run_id: string;
  node_id: string;
  iteration: number;
  attempt: number;
  lane_id: string | null;
  status: NodeStatus;
  session_id: string | null;
  transcript_path: string | null;
  pty_id: string | null;
  activity: string | null;
  waiting_reason: string | null;
  hold: number;
  lane_setup: NodeRun["laneSetup"];
  output: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

interface EventRow {
  id: number;
  run_id: string;
  node_run_id: string | null;
  type: string;
  payload: string | null;
  at: number;
}

/** `col = ?` list for the defined values (undefined = leave unchanged, null = set NULL). */
function assignments(pairs: ReadonlyArray<readonly [string, unknown]>): { sql: string; values: unknown[] } {
  const set = pairs.filter(([, v]) => v !== undefined);
  return { sql: set.map(([c]) => `${c} = ?`).join(", "), values: set.map(([, v]) => v) };
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const parseJson = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));

function laneFromRow(r: LaneRow): Lane {
  return {
    id: r.id,
    runId: r.run_id,
    branch: r.branch,
    worktreePath: r.worktree_path,
    baseRef: r.base_ref,
    status: r.status,
    index: r.idx,
    pushed: r.pushed === 1,
  };
}

function nodeRunFromRow(r: NodeRunRow): NodeRun {
  return {
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    iteration: r.iteration,
    attempt: r.attempt,
    laneId: r.lane_id,
    status: r.status,
    sessionId: r.session_id,
    transcriptPath: r.transcript_path,
    ptyId: r.pty_id,
    activity: r.activity,
    waitingReason: parseJson(r.waiting_reason),
    hold: r.hold === 1,
    laneSetup: r.lane_setup,
    output: parseJson<NodeRunOutput>(r.output),
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

/** NodeRun field → [column, encoder]. */
const NODE_RUN_COLUMNS: { [K in keyof NodeRunPatch]-?: [string, (v: NodeRunPatch[K]) => unknown] } = {
  laneId: ["lane_id", (v) => v],
  status: ["status", (v) => v],
  sessionId: ["session_id", (v) => v],
  transcriptPath: ["transcript_path", (v) => v],
  ptyId: ["pty_id", (v) => v],
  activity: ["activity", (v) => v],
  waitingReason: ["waiting_reason", json],
  hold: ["hold", (v) => (v ? 1 : 0)],
  laneSetup: ["lane_setup", (v) => v],
  output: ["output", json],
  error: ["error", (v) => v],
  startedAt: ["started_at", (v) => v],
  finishedAt: ["finished_at", (v) => v],
};

/**
 * Synchronous DAO over better-sqlite3. Pure persistence: no events, no business rules.
 * JSON columns are (de)serialised here; rows are returned as shared DTOs.
 */
export class Store {
  constructor(
    readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  // runs ---------------------------------------------------------------------
  insertRun(run: NewRun): Run {
    this.db
      .prepare(
        `INSERT INTO runs (id, repo_path, graph_id, graph_name, graph_snapshot, graph_hash, short_id, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(run.id, run.repoPath, run.graph.id, run.graph.name, JSON.stringify(run.graph), run.graphHash, run.shortId, run.startedAt);
    return this.getRun(run.id)!;
  }

  updateRun(id: string, patch: RunPatch): Run {
    const { sql, values } = assignments([
      ["status", patch.status],
      ["error", patch.error],
      ["finished_at", patch.finishedAt],
      ["cleaned_up", patch.cleanedUp === undefined ? undefined : patch.cleanedUp ? 1 : 0],
      ["loops", patch.loops === undefined ? undefined : JSON.stringify(patch.loops)],
    ]);
    if (sql) this.db.prepare(`UPDATE runs SET ${sql} WHERE id = ?`).run(...values, id);
    const run = this.getRun(id);
    if (!run) throw new Error(`Run ${id} not found`);
    return run;
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row && this.runFromRow(row);
  }

  /** Summary incl. counters (pendingApprovals, waitingInput) and usage summed over node run outputs. */
  getRunSummary(id: string): RunSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row && this.summaryFromRow(row);
  }

  /** Newest first. */
  listRuns(filter: { repoPath: string; graphId?: string; limit: number }): RunSummary[] {
    const rows = (
      filter.graphId === undefined
        ? this.db
            .prepare(`SELECT * FROM runs WHERE repo_path = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`)
            .all(filter.repoPath, filter.limit)
        : this.db
            .prepare(`SELECT * FROM runs WHERE repo_path = ? AND graph_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`)
            .all(filter.repoPath, filter.graphId, filter.limit)
    ) as RunRow[];
    return rows.map((r) => this.summaryFromRow(r));
  }

  listRunsByStatus(statuses: readonly RunStatus[]): Run[] {
    if (statuses.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY started_at, rowid`)
      .all(...statuses) as RunRow[];
    return rows.map((r) => this.runFromRow(r));
  }

  /** Persisted loop counters of a run ([] for graphs without loops). */
  getLoopStates(runId: string): LoopState[] {
    const row = this.db.prepare(`SELECT loops FROM runs WHERE id = ?`).get(runId) as Pick<RunRow, "loops"> | undefined;
    return parseJson<LoopState[]>(row?.loops ?? null) ?? [];
  }

  private summaryFromRow(r: RunRow): RunSummary {
    const stats = this.db.prepare(`SELECT status, output FROM node_runs WHERE run_id = ?`).all(r.id) as Array<
      Pick<NodeRunRow, "status" | "output">
    >;
    const usages: TokenUsage[] = [];
    let pendingApprovals = 0;
    let waitingInput = 0;
    for (const s of stats) {
      if (s.status === "waiting_approval") pendingApprovals++;
      if (s.status === "waiting_input" || s.status === "idle") waitingInput++;
      const usage = parseJson<NodeRunOutput>(s.output)?.usage;
      if (usage) usages.push(usage);
    }
    return {
      id: r.id,
      repoPath: r.repo_path,
      graphId: r.graph_id,
      graphName: r.graph_name,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      graphHash: r.graph_hash,
      shortId: r.short_id,
      error: r.error,
      pendingApprovals,
      waitingInput,
      usage: usages.length > 0 ? sumUsage(usages) : emptyUsage(),
      cleanedUp: r.cleaned_up === 1,
    };
  }

  private runFromRow(r: RunRow): Run {
    return { ...this.summaryFromRow(r), graphSnapshot: JSON.parse(r.graph_snapshot) as Graph };
  }

  // lanes --------------------------------------------------------------------
  insertLane(lane: NewLane): Lane {
    this.db
      .prepare(
        `INSERT INTO lanes (id, run_id, idx, branch, worktree_path, base_ref, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(lane.id, lane.runId, lane.index, lane.branch, lane.worktreePath, lane.baseRef, lane.status ?? "active");
    return this.getLane(lane.runId, lane.id)!;
  }

  updateLane(runId: string, laneId: string, patch: LanePatch): Lane {
    const { sql, values } = assignments([
      ["status", patch.status],
      ["pushed", patch.pushed === undefined ? undefined : patch.pushed ? 1 : 0],
      ["worktree_path", patch.worktreePath],
    ]);
    if (sql) this.db.prepare(`UPDATE lanes SET ${sql} WHERE run_id = ? AND id = ?`).run(...values, runId, laneId);
    const lane = this.getLane(runId, laneId);
    if (!lane) throw new Error(`Lane ${runId}/${laneId} not found`);
    return lane;
  }

  getLane(runId: string, laneId: string): Lane | undefined {
    const row = this.db.prepare(`SELECT * FROM lanes WHERE run_id = ? AND id = ?`).get(runId, laneId) as LaneRow | undefined;
    return row && laneFromRow(row);
  }

  listLanes(runId: string): Lane[] {
    const rows = this.db.prepare(`SELECT * FROM lanes WHERE run_id = ? ORDER BY idx`).all(runId) as LaneRow[];
    return rows.map(laneFromRow);
  }

  // node runs ----------------------------------------------------------------
  insertNodeRun(nr: NewNodeRun): NodeRun {
    this.db
      .prepare(
        `INSERT INTO node_runs (id, run_id, node_id, iteration, attempt, lane_id, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nr.id, nr.runId, nr.nodeId, nr.iteration, nr.attempt, nr.laneId, nr.status, this.now());
    return this.getNodeRun(nr.id)!;
  }

  updateNodeRun(id: string, patch: NodeRunPatch): NodeRun {
    const pairs: Array<[string, unknown]> = [["updated_at", this.now()]];
    for (const key of Object.keys(patch) as Array<keyof NodeRunPatch>) {
      const col = NODE_RUN_COLUMNS[key];
      const value = patch[key];
      if (col && value !== undefined) pairs.push([col[0], (col[1] as (v: unknown) => unknown)(value)]);
    }
    const { sql, values } = assignments(pairs);
    this.db.prepare(`UPDATE node_runs SET ${sql} WHERE id = ?`).run(...values, id);
    const nr = this.getNodeRun(id);
    if (!nr) throw new Error(`Node run ${id} not found`);
    return nr;
  }

  getNodeRun(id: string): NodeRun | undefined {
    const row = this.db.prepare(`SELECT * FROM node_runs WHERE id = ?`).get(id) as NodeRunRow | undefined;
    return row && nodeRunFromRow(row);
  }

  /** Ordered by node id, iteration, attempt. */
  listNodeRuns(runId: string): NodeRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM node_runs WHERE run_id = ? ORDER BY node_id, iteration, attempt`)
      .all(runId) as NodeRunRow[];
    return rows.map(nodeRunFromRow);
  }

  /** Across all runs (crash recovery, pending approvals). */
  listNodeRunsByStatus(statuses: readonly NodeStatus[]): NodeRun[] {
    if (statuses.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM node_runs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY run_id, node_id, iteration, attempt`)
      .all(...statuses) as NodeRunRow[];
    return rows.map(nodeRunFromRow);
  }

  findNodeRunByPtyId(ptyId: string): NodeRun | undefined {
    const row = this.db
      .prepare(`SELECT * FROM node_runs WHERE pty_id = ? OR id = ? ORDER BY (pty_id = ?) DESC LIMIT 1`)
      .get(ptyId, ptyId, ptyId) as NodeRunRow | undefined;
    return row && nodeRunFromRow(row);
  }

  // events -------------------------------------------------------------------
  appendEvent(runId: string, nodeRunId: string | null, type: string, payload: unknown): RunEvent {
    const at = this.now();
    const info = this.db
      .prepare(`INSERT INTO events (run_id, node_run_id, type, payload, at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, nodeRunId, type, json(payload), at);
    return { id: Number(info.lastInsertRowid), runId, nodeRunId, type, payload: payload ?? null, at };
  }

  listEvents(runId: string, opts: { afterId?: number; limit?: number } = {}): RunEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .all(runId, opts.afterId ?? 0, opts.limit ?? -1) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      nodeRunId: r.node_run_id,
      type: r.type,
      payload: parseJson(r.payload),
      at: r.at,
    }));
  }

  // graph meta (§14) ---------------------------------------------------------
  getKnownGraphHash(repoPath: string, graphId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT known_hash FROM graph_meta WHERE repo_path = ? AND graph_id = ?`)
      .get(repoPath, graphId) as { known_hash: string } | undefined;
    return row?.known_hash;
  }

  setKnownGraphHash(repoPath: string, graphId: string, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO graph_meta (repo_path, graph_id, known_hash, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo_path, graph_id) DO UPDATE SET known_hash = excluded.known_hash, updated_at = excluded.updated_at`,
      )
      .run(repoPath, graphId, hash, this.now());
  }

  /** Runs `fn` in a transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
