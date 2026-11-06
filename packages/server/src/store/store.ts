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

/** A chat panel session row (§21.8). The live status is not persisted: it belongs to the ChatManager. */
export interface ChatSessionRecord {
  id: string;
  repoPath: string;
  /** null until the first user message. */
  title: string | null;
  model: string | null;
  totalCostUsd: number;
  /** Claude Code created the session: the next process uses --resume instead of --session-id. */
  started: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ChatSessionPatch = Partial<Pick<ChatSessionRecord, "title" | "model" | "totalCostUsd" | "started">>;

interface ChatSessionRow {
  id: string;
  repo_path: string;
  title: string | null;
  model: string | null;
  total_cost_usd: number;
  started: number;
  created_at: number;
  updated_at: number;
}

function chatSessionFromRow(r: ChatSessionRow): ChatSessionRecord {
  return {
    id: r.id,
    repoPath: r.repo_path,
    title: r.title,
    model: r.model,
    totalCostUsd: r.total_cost_usd,
    started: r.started === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type NewLane = Omit<Lane, "pushed" | "status"> & { status?: LaneStatus };
export type LanePatch = Partial<Pick<Lane, "status" | "pushed" | "worktreePath">>;

export type NewNodeRun = Pick<NodeRun, "id" | "runId" | "nodeId" | "iteration" | "attempt" | "laneId" | "status">;
/** Any mutable field; `updatedAt` is set by the store. */
export type NodeRunPatch = Partial<Omit<NodeRun, "id" | "runId" | "nodeId" | "iteration" | "attempt" | "updatedAt">>;

/** A registered repository (table `repos`, DESIGN §11.2). */
export interface RepoRow {
  /** repoId, `<slug>-<hash8>`. */
  id: string;
  /** Realpath of the git top level (= runs.repo_path). */
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number | null;
}

export type NewRepo = Omit<RepoRow, "lastOpenedAt"> & { lastOpenedAt?: number | null };

/** A browser or desktop session (table `sessions`, DESIGN §14). */
export interface SessionRow {
  /** SHA-256 hex of the cookie value. */
  idHash: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/** Home counters of one repository path (RepoSummary.runs / waiting / lastRunAt). */
export interface RepoStatusCounts {
  running: number;
  paused: number;
  /** Node runs waiting for approval. */
  approval: number;
  /** Node runs waiting for input, `idle` included. */
  input: number;
  /** Start of the newest run. */
  lastRunAt: number | null;
}

interface RepoDbRow {
  id: string;
  path: string;
  name: string;
  added_at: number;
  last_opened_at: number | null;
}

interface SessionDbRow {
  id_hash: string;
  label: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

const repoFromRow = (r: RepoDbRow): RepoRow => ({ id: r.id, path: r.path, name: r.name, addedAt: r.added_at, lastOpenedAt: r.last_opened_at });
const sessionFromRow = (r: SessionDbRow): SessionRow => ({
  idHash: r.id_hash,
  label: r.label,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
});

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
  grace_until: number | null;
  snapshot_start: string | null;
  snapshot_end: string | null;
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
    graceUntil: r.grace_until,
    snapshotStart: r.snapshot_start,
    snapshotEnd: r.snapshot_end,
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
  graceUntil: ["grace_until", (v) => v],
  snapshotStart: ["snapshot_start", (v) => v],
  snapshotEnd: ["snapshot_end", (v) => v],
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

  /** Whether a run of the repository already uses this short id (branch names, §9.1). */
  shortIdInUse(repoPath: string, shortId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM runs WHERE repo_path = ? AND short_id = ? LIMIT 1`).get(repoPath, shortId) !== undefined;
  }

  /** repo_path of a run (cheap: no snapshot parsing). */
  getRunRepoPath(id: string): string | undefined {
    const row = this.db.prepare(`SELECT repo_path FROM runs WHERE id = ?`).get(id) as { repo_path: string } | undefined;
    return row?.repo_path;
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

  /** `repoPath` restricts to one repository's runs (the DB is shared by every server instance). */
  listRunsByStatus(statuses: readonly RunStatus[], filter: { repoPath?: string } = {}): Run[] {
    if (statuses.length === 0) return [];
    const repo = filter.repoPath === undefined ? "" : " AND repo_path = ?";
    const params: string[] = [...statuses];
    if (filter.repoPath !== undefined) params.push(filter.repoPath);
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${statuses.map(() => "?").join(", ")})${repo} ORDER BY started_at, rowid`)
      .all(...params) as RunRow[];
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

  /** Across all runs (crash recovery, pending approvals); `repoPath` restricts to one repository's runs. */
  listNodeRunsByStatus(statuses: readonly NodeStatus[], filter: { repoPath?: string } = {}): NodeRun[] {
    if (statuses.length === 0) return [];
    const repo = filter.repoPath === undefined ? "" : " AND run_id IN (SELECT id FROM runs WHERE repo_path = ?)";
    const params: string[] = [...statuses];
    if (filter.repoPath !== undefined) params.push(filter.repoPath);
    const rows = this.db
      .prepare(
        `SELECT * FROM node_runs WHERE status IN (${statuses.map(() => "?").join(", ")})${repo} ORDER BY run_id, node_id, iteration, attempt`,
      )
      .all(...params) as NodeRunRow[];
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

  // chat sessions (§21.8) ------------------------------------------------------
  insertChatSession(session: { id: string; repoPath: string; model?: string | null }): ChatSessionRecord {
    const now = this.now();
    this.db
      .prepare(`INSERT INTO chat_sessions (id, repo_path, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(session.id, session.repoPath, session.model ?? null, now, now);
    return this.getChatSession(session.id)!;
  }

  /** Applies `patch` and bumps updated_at. */
  updateChatSession(id: string, patch: ChatSessionPatch): ChatSessionRecord {
    const { sql, values } = assignments([
      ["title", patch.title],
      ["model", patch.model],
      ["total_cost_usd", patch.totalCostUsd],
      ["started", patch.started === undefined ? undefined : patch.started ? 1 : 0],
      ["updated_at", this.now()],
    ]);
    this.db.prepare(`UPDATE chat_sessions SET ${sql} WHERE id = ?`).run(...values, id);
    const session = this.getChatSession(id);
    if (!session) throw new Error(`Chat session ${id} not found`);
    return session;
  }

  getChatSession(id: string): ChatSessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id) as ChatSessionRow | undefined;
    return row ? chatSessionFromRow(row) : undefined;
  }

  /** One repository's sessions, most recently updated first. */
  listChatSessions(repoPath: string): ChatSessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM chat_sessions WHERE repo_path = ? ORDER BY updated_at DESC, rowid DESC`)
      .all(repoPath) as ChatSessionRow[];
    return rows.map(chatSessionFromRow);
  }

  deleteChatSession(id: string): boolean {
    return this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id).changes > 0;
  }


  // repositories (DESIGN §4.2) -------------------------------------------------
  /** Oldest registration first. */
  listRepos(): RepoRow[] {
    return (this.db.prepare(`SELECT * FROM repos ORDER BY added_at, rowid`).all() as RepoDbRow[]).map(repoFromRow);
  }

  getRepo(id: string): RepoRow | undefined {
    const row = this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoDbRow | undefined;
    return row && repoFromRow(row);
  }

  getRepoByPath(repoPath: string): RepoRow | undefined {
    const row = this.db.prepare(`SELECT * FROM repos WHERE path = ?`).get(repoPath) as RepoDbRow | undefined;
    return row && repoFromRow(row);
  }

  insertRepo(repo: NewRepo): RepoRow {
    this.db
      .prepare(`INSERT INTO repos (id, path, name, added_at, last_opened_at) VALUES (?, ?, ?, ?, ?)`)
      .run(repo.id, repo.path, repo.name, repo.addedAt, repo.lastOpenedAt ?? null);
    return this.getRepo(repo.id)!;
  }

  /** Sets last_opened_at (registration of an already registered repository, `promptgraph open`). */
  touchRepo(id: string, at: number = this.now()): RepoRow | undefined {
    this.db.prepare(`UPDATE repos SET last_opened_at = ? WHERE id = ?`).run(at, id);
    return this.getRepo(id);
  }

  /** Forgets a repository; its runs, graph meta and files stay (re-adding it finds them again). */
  deleteRepo(id: string): boolean {
    return this.db.prepare(`DELETE FROM repos WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Home counters for every repository path that has runs, in one grouped query: running and paused
   * runs, node runs waiting for approval or for input (`idle` included) and the newest run start.
   */
  repoStatusCounts(): Map<string, RepoStatusCounts> {
    const rows = this.db
      .prepare(
        `SELECT r.repo_path AS repo_path,
                SUM(r.status = 'running') AS running,
                SUM(r.status = 'paused') AS paused,
                COALESCE(SUM(n.approval), 0) AS approval,
                COALESCE(SUM(n.input), 0) AS input,
                MAX(r.started_at) AS last_run_at
           FROM runs r
           LEFT JOIN (
             SELECT run_id,
                    SUM(status = 'waiting_approval') AS approval,
                    SUM(status IN ('waiting_input', 'idle')) AS input
               FROM node_runs
              WHERE status IN ('waiting_approval', 'waiting_input', 'idle')
              GROUP BY run_id
           ) n ON n.run_id = r.id
          GROUP BY r.repo_path`,
      )
      .all() as Array<{ repo_path: string; running: number; paused: number; approval: number; input: number; last_run_at: number | null }>;
    return new Map(
      rows.map((r) => [r.repo_path, { running: r.running, paused: r.paused, approval: r.approval, input: r.input, lastRunAt: r.last_run_at }]),
    );
  }

  /** Every repo_path that has runs (backfill, DESIGN §4.4). */
  distinctRunRepoPaths(): string[] {
    return (this.db.prepare(`SELECT DISTINCT repo_path FROM runs ORDER BY repo_path`).all() as Array<{ repo_path: string }>).map((r) => r.repo_path);
  }

  /** Every repo_path of graph meta rows (backfill normalises them, DESIGN §4.4). */
  distinctGraphMetaRepoPaths(): string[] {
    return (this.db.prepare(`SELECT DISTINCT repo_path FROM graph_meta ORDER BY repo_path`).all() as Array<{ repo_path: string }>).map((r) => r.repo_path);
  }

  /**
   * Moves runs, graph meta and chat sessions from `from` to `to` (backfill normalises paths to their realpath). A graph
   * meta row already present under `to` keeps the more recent hash. Returns the number of runs moved.
   */
  rewriteRepoPath(from: string, to: string): number {
    if (from === to) return 0;
    return this.transaction(() => {
      const moved = this.db.prepare(`UPDATE runs SET repo_path = ? WHERE repo_path = ?`).run(to, from).changes;
      this.db
        .prepare(
          `INSERT INTO graph_meta (repo_path, graph_id, known_hash, updated_at)
             SELECT ?, graph_id, known_hash, updated_at FROM graph_meta WHERE repo_path = ?
           ON CONFLICT (repo_path, graph_id) DO UPDATE SET known_hash = excluded.known_hash, updated_at = excluded.updated_at
             WHERE excluded.updated_at > graph_meta.updated_at`,
        )
        .run(to, from);
      this.db.prepare(`DELETE FROM graph_meta WHERE repo_path = ?`).run(from);
      this.db.prepare(`UPDATE chat_sessions SET repo_path = ? WHERE repo_path = ?`).run(to, from);
      return moved;
    });
  }

  // meta ---------------------------------------------------------------------
  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  // sessions (DESIGN §14) ----------------------------------------------------
  insertSession(session: SessionRow): SessionRow {
    this.db
      .prepare(`INSERT INTO sessions (id_hash, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(session.idHash, session.label, session.createdAt, session.lastSeenAt, session.expiresAt);
    return this.getSession(session.idHash)!;
  }

  getSession(idHash: string): SessionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id_hash = ?`).get(idHash) as SessionDbRow | undefined;
    return row && sessionFromRow(row);
  }

  /** Sliding expiry: records the last use and the new expiry. */
  touchSession(idHash: string, lastSeenAt: number, expiresAt: number): void {
    this.db.prepare(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?`).run(lastSeenAt, expiresAt, idHash);
  }

  /** Newest first. */
  listSessions(): SessionRow[] {
    return (this.db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC`).all() as SessionDbRow[]).map(sessionFromRow);
  }

  /**
   * Deletes the sessions whose hash starts with `prefix` (lowercase hex, at least one digit), or every
   * session with "all". Returns the deleted hashes.
   */
  deleteSessions(prefix: string | "all"): string[] {
    if (prefix !== "all" && !/^[0-9a-f]+$/.test(prefix)) throw new Error(`Invalid session id "${prefix}"`);
    return this.transaction(() => {
      const rows = (
        prefix === "all"
          ? this.db.prepare(`SELECT id_hash FROM sessions`).all()
          : this.db.prepare(`SELECT id_hash FROM sessions WHERE substr(id_hash, 1, ?) = ?`).all(prefix.length, prefix)
      ) as Array<{ id_hash: string }>;
      const del = this.db.prepare(`DELETE FROM sessions WHERE id_hash = ?`);
      for (const r of rows) del.run(r.id_hash);
      return rows.map((r) => r.id_hash);
    });
  }

  /** Drops sessions that expired before `now`; returns their id hashes. */
  deleteExpiredSessions(now: number = this.now()): string[] {
    const rows = this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ? RETURNING id_hash`).all(now) as Array<{ id_hash: string }>;
    return rows.map((r) => r.id_hash);
  }

  /** Runs `fn` in a transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
