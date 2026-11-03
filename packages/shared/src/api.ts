import { z } from "zod";
import { GraphSchema, NodeTypeSchema } from "./graph.js";
import { RepoIdSchema } from "./repos.js";
import { LaneSchema, NodeRunSchema, RunDetailSchema, RunSummarySchema } from "./run.js";
import { ValidationResultSchema } from "./validation/types.js";

/**
 * REST API (DESIGN §12.1). Daemon routes live under `/api/daemon`, `/api/repos` and `/api/settings`;
 * every repository route lives under `/api/repos/:repoId` (the paths in the comments below are relative
 * to that prefix, see `API.repo(repoId)`). Every route except `GET /api/daemon/hello`, `GET /login` and the
 * hook receiver requires the token (`Authorization: Bearer <t>`) or a session cookie (`pg_session`, DESIGN
 * §14); the login-code, token-rotation and session routes accept the Bearer token only.
 * Errors are `ApiError` with a 4xx/5xx status.
 * Naming: `<Name>Request` = JSON body, `<Name>Response` = JSON response.
 */

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

// --- App / repo ------------------------------------------------------------

/** GET /api/repos/:repoId — one registered repository (daemon-wide data is in DaemonInfoResponse). */
export const RepoInfoResponseSchema = z.object({
  id: RepoIdSchema,
  /** Realpath of the git top level. */
  path: z.string(),
  name: z.string(),
  currentBranch: z.string().nullable(),
  branches: z.array(z.string()),
});
export type RepoInfoResponse = z.infer<typeof RepoInfoResponseSchema>;

/** GET /api/daemon — daemon-wide information shown on Home (DESIGN §12.1). */
export const DaemonInfoResponseSchema = z.object({
  version: z.string(),
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  startedAt: z.number(),
  /** Design phase the engine supports; the web validates with the same ValidateOptions.phase. */
  phase: z.union([z.literal(1), z.literal(2)]),
  /** Node types the engine can run; the web validates with ValidateOptions.supportedNodeTypes. */
  supportedNodeTypes: z.array(NodeTypeSchema),
  /** Prerequisite warnings checked against the daemon's environment. */
  warnings: z.array(z.string()),
  /** A desktop notifier (notify-send / WSL PowerShell) was found (§18 Q2). */
  notificationsAvailable: z.boolean(),
});
export type DaemonInfoResponse = z.infer<typeof DaemonInfoResponseSchema>;

/** POST /api/daemon/login-codes (Bearer only) — a one-time code: 32 bytes base64url, single use, 30 s. */
export const LoginCodeResponseSchema = z.object({
  code: z.string().min(43),
  expiresAt: z.number(),
});
export type LoginCodeResponse = z.infer<typeof LoginCodeResponseSchema>;

/**
 * POST /api/daemon/login-codes body (optional): `desktop` labels the session the code creates as
 * "promptgraph desktop" (the desktop window's user agent does not say so).
 */
export const LoginCodeRequestSchema = z.object({ desktop: z.boolean().optional() });
export type LoginCodeRequest = z.infer<typeof LoginCodeRequestSchema>;

/** App-wide settings stored in ~/.promptgraph/settings.json. */
export const AppSettingsSchema = z.object({
  /** Desktop notifications when a node needs attention (§18 Q2). */
  notifications: z.boolean().default(true),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** GET /api/settings → AppSettings; PUT /api/settings body Partial<AppSettings> → AppSettings */
export const UpdateAppSettingsRequestSchema = AppSettingsSchema.partial();
export type UpdateAppSettingsRequest = z.infer<typeof UpdateAppSettingsRequestSchema>;

// --- Graphs ----------------------------------------------------------------

export const GraphListItemSchema = z.object({
  id: z.string(),
  /** null when the file failed to parse. */
  name: z.string().nullable(),
  /** Parse/zod error; invalid graphs are listed but not runnable. */
  loadError: z.string().nullable(),
  updatedAt: z.number(),
  hash: z.string(),
});
export type GraphListItem = z.infer<typeof GraphListItemSchema>;

/** GET …/graphs */
export const ListGraphsResponseSchema = z.object({ graphs: z.array(GraphListItemSchema) });
export type ListGraphsResponse = z.infer<typeof ListGraphsResponseSchema>;

/** GET …/graphs/:id (422 ApiError{code:"invalid_graph"} when the file does not parse) */
export const GetGraphResponseSchema = z.object({
  graph: GraphSchema,
  hash: z.string(),
  /** File changed outside the app since the last run of this graph (§14). */
  modifiedOutside: z.boolean(),
  /** A run of this graph is active; the graph is read-only. */
  activeRunId: z.string().nullable(),
});
export type GetGraphResponse = z.infer<typeof GetGraphResponseSchema>;

/** PUT …/graphs/:id (upsert; body.id must equal :id; 409 while a run is active) */
export const SaveGraphRequestSchema = GraphSchema;
export type SaveGraphRequest = z.input<typeof SaveGraphRequestSchema>;
export const SaveGraphResponseSchema = z.object({ graph: GraphSchema, hash: z.string() });
export type SaveGraphResponse = z.infer<typeof SaveGraphResponseSchema>;

/** DELETE …/graphs/:id → OkResponse */

/** POST …/graphs/:id/validate — body optional: validates the given (unsaved) graph instead of the file. */
export const ValidateGraphRequestSchema = z.object({ graph: GraphSchema.optional() });
export type ValidateGraphRequest = z.input<typeof ValidateGraphRequestSchema>;
export const ValidateGraphResponseSchema = ValidationResultSchema;
export type ValidateGraphResponse = z.infer<typeof ValidateGraphResponseSchema>;

/** POST …/graphs/:id/runs — 422 ApiError{code:"validation_failed", details: ValidationResult} on errors. */
export const StartRunRequestSchema = z.object({});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
export const StartRunResponseSchema = RunDetailSchema;
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

// --- Runs ------------------------------------------------------------------

/** GET …/runs?graph=<id>&limit=<n> (newest first) */
export const ListRunsQuerySchema = z.object({
  graph: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
export const ListRunsResponseSchema = z.object({ runs: z.array(RunSummarySchema) });
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;

/** GET …/runs/:id */
export const GetRunResponseSchema = RunDetailSchema;
export type GetRunResponse = z.infer<typeof GetRunResponseSchema>;

/** POST …/runs/:id/cancel → OkResponse */
/** POST …/runs/:id/cleanup → OkResponse (remove worktrees + unpushed branches, §9.6) */

/** GET …/pending — node runs waiting for approval across all runs (header counter). */
export const PendingResponseSchema = z.object({ nodeRuns: z.array(NodeRunSchema) });
export type PendingResponse = z.infer<typeof PendingResponseSchema>;

// --- Node runs -------------------------------------------------------------

/** POST …/node-runs/:id/done → NodeRunResponse */
/** POST …/node-runs/:id/skip → NodeRunResponse */
/** POST …/node-runs/:id/fail */
export const FailNodeRequestSchema = z.object({ reason: z.string().optional() });
export type FailNodeRequest = z.infer<typeof FailNodeRequestSchema>;
/** POST …/node-runs/:id/retry → NodeRunResponse (the new attempt) */
/** POST …/node-runs/:id/hold */
export const HoldNodeRequestSchema = z.object({ hold: z.boolean() });
export type HoldNodeRequest = z.infer<typeof HoldNodeRequestSchema>;

export const NodeRunResponseSchema = z.object({ nodeRun: NodeRunSchema });
export type NodeRunResponse = z.infer<typeof NodeRunResponseSchema>;

/** POST …/node-runs/:id/approval → NodeRunResponse */
export const ApprovalRequestSchema = z.object({
  approved: z.boolean(),
  comment: z.string().optional(),
  /** pr nodes: edited title/body to use. */
  title: z.string().optional(),
  body: z.string().optional(),
  /**
   * pr nodes: the reviewed commit (`DiffResponse.head`), required to approve. The server refuses the
   * approval when the lane moved since, and pushes exactly this commit.
   */
  headSha: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** GET …/node-runs/:id/approval — what the approval dialog shows. */
export const ApprovalInfoResponseSchema = z.object({
  nodeRun: NodeRunSchema,
  message: z.string().nullable(),
  showDiff: z.boolean(),
  /** pr nodes: proposed (generated or configured) title/body. */
  pr: z.object({ title: z.string(), body: z.string(), base: z.string(), draft: z.boolean() }).nullable(),
  /** Outputs of direct predecessors, by node id. */
  predecessorOutputs: z.array(z.object({ nodeId: z.string(), label: z.string(), text: z.string() })),
});
export type ApprovalInfoResponse = z.infer<typeof ApprovalInfoResponseSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "other"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

/**
 * GET …/node-runs/:id/diff?scope=lane|node
 * - lane (default): lane diff vs base branch (merge-base), including uncommitted changes; pr nodes: vs
 *   the PR's base, committed changes only (what gets pushed: `head`).
 * - node (§9.7): what this node changed, between its start and end snapshots (or the live worktree while
 *   it runs). 409 invalid_state when the node has no snapshot.
 */
export const DiffScopeSchema = z.enum(["lane", "node"]);
export type DiffScope = z.infer<typeof DiffScopeSchema>;
export const DiffQuerySchema = z.object({ scope: DiffScopeSchema.default("lane") });
export type DiffQuery = z.infer<typeof DiffQuerySchema>;

export const DiffResponseSchema = z.object({
  base: z.string(),
  head: z.string(),
  files: z.array(DiffFileSchema),
  /** Unified diff (git diff output), fed to diff2html. */
  patch: z.string(),
  truncated: z.boolean(),
});
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

// --- Run report (§13.1) ----------------------------------------------------

export const ChangeStatsSchema = z.object({
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type ChangeStats = z.infer<typeof ChangeStatsSchema>;

/** One (node, iteration) of the run: its latest attempt. */
export const ReportNodeSchema = z.object({
  nodeRun: NodeRunSchema,
  label: z.string(),
  type: NodeTypeSchema,
  /** Attempts of this (node, iteration), retries included. */
  attempts: z.number().int(),
  durationMs: z.number().nullable(),
  /** Time spent waiting for the user (idle, waiting_input, waiting_approval), all attempts. */
  waitingMs: z.number(),
  /** What the node changed (§9.7); null without snapshots. */
  changes: ChangeStatsSchema.nullable(),
});
export type ReportNode = z.infer<typeof ReportNodeSchema>;

export const ReportCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  /** A promptgraph checkpoint (§9.3) rather than a commit node's commit. */
  checkpoint: z.boolean(),
});
export type ReportCommit = z.infer<typeof ReportCommitSchema>;

export const ReportLaneSchema = z.object({
  lane: LaneSchema,
  /** Commit the lane diff starts from (merge base with the base branch, or the lane's baseRef). */
  base: z.string(),
  /** End of the lane diff: the live worktree's HEAD, or the last snapshot after cleanup. Null: nothing ran. */
  head: z.string().nullable(),
  changes: ChangeStatsSchema,
  /** Commits on the lane after `base`, newest first (first parent). */
  commits: z.array(ReportCommitSchema),
});
export type ReportLane = z.infer<typeof ReportLaneSchema>;

/** Where the run stopped or lost time: unhandled failures, nodes waiting for the user, long waits. */
export const ReportStallSchema = z.object({
  nodeRunId: z.string(),
  label: z.string(),
  kind: z.enum(["failed", "interrupted", "cancelled", "waiting", "slow_wait"]),
  message: z.string(),
  waitingMs: z.number(),
});
export type ReportStall = z.infer<typeof ReportStallSchema>;

/** GET …/runs/:id/report */
export const RunReportResponseSchema = z.object({
  run: RunSummarySchema,
  durationMs: z.number(),
  /** Execution order (startedAt; never-started nodes last, in canvas order). */
  nodes: z.array(ReportNodeSchema),
  lanes: z.array(ReportLaneSchema),
  prs: z.array(z.object({ url: z.string(), nodeRunId: z.string(), label: z.string() })),
  stalls: z.array(ReportStallSchema),
});
export type RunReportResponse = z.infer<typeof RunReportResponseSchema>;

/** GET …/runs/:id/lanes/:laneId/diff → DiffResponse (lane vs its base; works after cleanup via snapshots). */

/**
 * POST …/node-runs/:id/reopen — spawns `claude --resume <session>` (not part of the run), or returns
 * the node run's reopened PTY while it is still live. DELETE …/ptys/:ptyId ends it.
 */
export const ReopenResponseSchema = z.object({
  ptyId: z.string(),
  /** Set when the session does not run where the node ran (e.g. the worktree is gone: main checkout). */
  notice: z.string().nullable().optional(),
});
export type ReopenResponse = z.infer<typeof ReopenResponseSchema>;

// --- Commands --------------------------------------------------------------

export const SlashCommandSchema = z.object({
  /** Including leading slash, e.g. "/code-review". */
  name: z.string(),
  description: z.string().nullable(),
  argumentHint: z.string().nullable(),
  kind: z.enum(["command", "skill"]),
  source: z.enum(["project", "user", "plugin", "builtin"]),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/** GET …/commands */
export const ListCommandsResponseSchema = z.object({ commands: z.array(SlashCommandSchema) });
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>;

// --- Hook receiver ---------------------------------------------------------

/** POST /hooks/:nodeRunId/:event — body is the raw Claude Code hook payload (see hooks.ts). Response: 204. */

const enc = encodeURIComponent;

/** Paths under `/api/repos/:repoId` (DESIGN §12.1); every id is encodeURIComponent'd. */
function repoApi(repoId: string) {
  const base = `/api/repos/${enc(repoId)}`;
  return {
    /** GET → RepoInfoResponse. */
    info: base,
    graphs: `${base}/graphs`,
    graph: (id: string) => `${base}/graphs/${enc(id)}`,
    validate: (id: string) => `${base}/graphs/${enc(id)}/validate`,
    startRun: (id: string) => `${base}/graphs/${enc(id)}/runs`,
    runs: `${base}/runs`,
    run: (id: string) => `${base}/runs/${enc(id)}`,
    cancelRun: (id: string) => `${base}/runs/${enc(id)}/cancel`,
    cleanupRun: (id: string) => `${base}/runs/${enc(id)}/cleanup`,
    resumeRun: (id: string) => `${base}/runs/${enc(id)}/resume`,
    runReport: (id: string) => `${base}/runs/${enc(id)}/report`,
    laneDiff: (runId: string, laneId: string) => `${base}/runs/${enc(runId)}/lanes/${enc(laneId)}/diff`,
    pending: `${base}/pending`,
    nodeRunAction: (id: string, action: "done" | "fail" | "retry" | "skip" | "hold") => `${base}/node-runs/${enc(id)}/${action}`,
    approval: (id: string) => `${base}/node-runs/${enc(id)}/approval`,
    diff: (id: string, scope: DiffScope = "lane") => `${base}/node-runs/${enc(id)}/diff${scope === "lane" ? "" : `?scope=${scope}`}`,
    reopen: (id: string) => `${base}/node-runs/${enc(id)}/reopen`,
    /** DELETE: ends a "Reopen session" PTY (the only PTYs not owned by a run). */
    pty: (id: string) => `${base}/ptys/${enc(id)}`,
    commands: `${base}/commands`,
    claudeSetup: `${base}/claude-setup`,
    claudeCheck: `${base}/claude-setup/check`,
  } as const;
}
export type RepoApiPaths = ReturnType<typeof repoApi>;

/** Paths, for clients. */
export const API = {
  /** Public: the client checks the proof before it sends the token (DESIGN §4.1 item 3). */
  hello: (nonce: string) => `/api/daemon/hello?nonce=${enc(nonce)}`,
  daemon: "/api/daemon",
  /** GET → ListReposResponse; POST {path} → RepoSummary. */
  repos: "/api/repos",
  /** DELETE → OkResponse (409 repo_active unless `force`). */
  removeRepo: (repoId: string, force = false) => `/api/repos/${enc(repoId)}${force ? "?force=1" : ""}`,
  settings: "/api/settings",
  loginCodes: "/api/daemon/login-codes",
  rotateToken: "/api/daemon/token/rotate",
  sessions: "/api/daemon/sessions",
  session: (idOrAll: string) => `/api/daemon/sessions/${enc(idOrAll)}`,
  login: "/login",
  ws: "/ws",
  hook: (nodeRunId: string, event: string) => `/hooks/${enc(nodeRunId)}/${event}`,
  repo: repoApi,
} as const;
