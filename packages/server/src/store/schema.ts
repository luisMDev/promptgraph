/**
 * SQLite schema (§11.2 + promptgraph extras). Applied by openDatabase() via `PRAGMA user_version`
 * migrations: MIGRATIONS[i] upgrades from version i to i+1. Never edit a shipped migration; append.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    graph_id TEXT NOT NULL,
    graph_name TEXT NOT NULL,
    graph_snapshot TEXT NOT NULL,        -- JSON Graph
    graph_hash TEXT NOT NULL,            -- hash of the graph file at start (§14)
    short_id TEXT NOT NULL,              -- used in branch names
    status TEXT NOT NULL,                -- RunStatus
    error TEXT,
    cleaned_up INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX runs_graph ON runs (repo_path, graph_id, started_at DESC);

  CREATE TABLE lanes (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    status TEXT NOT NULL,                -- LaneStatus
    pushed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, id)
  );

  CREATE TABLE node_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    lane_id TEXT,
    status TEXT NOT NULL,                -- NodeStatus
    session_id TEXT,
    transcript_path TEXT,
    pty_id TEXT,
    activity TEXT,
    waiting_reason TEXT,                 -- JSON WaitingReason
    hold INTEGER NOT NULL DEFAULT 0,
    lane_setup TEXT,                     -- LaneSetupState
    output TEXT,                         -- JSON NodeRunOutput (incl. usage)
    error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX node_runs_run ON node_runs (run_id, node_id, iteration, attempt);
  CREATE INDEX node_runs_status ON node_runs (status);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_run_id TEXT,
    type TEXT NOT NULL,
    payload TEXT,                        -- JSON
    at INTEGER NOT NULL
  );
  CREATE INDEX events_run ON events (run_id, id);

  -- Last graph-file hash known to the app (saved by it or used by a run), per repo+graph (§14).
  CREATE TABLE graph_meta (
    repo_path TEXT NOT NULL,
    graph_id TEXT NOT NULL,
    known_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo_path, graph_id)
  );
  `,
];
