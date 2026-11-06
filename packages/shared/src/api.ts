import { z } from "zod";
import { GraphSchema, NodeTypeSchema } from "./graph.js";
import { LaneSchema, NodeRunSchema, RunDetailSchema, RunSummarySchema } from "./run.js";
import { ValidationResultSchema } from "./validation/types.js";
import { VoiceSettingsSchema } from "./voice.js";

/**
 * REST API (§12.1). Every route requires the session token (`Authorization: Bearer <t>` or the `pg_token`
 * cookie set from `/?t=`). Errors are `ApiError` with a 4xx/5xx status.
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

/** GET /api/repo */
export const RepoInfoResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
  currentBranch: z.string().nullable(),
  branches: z.array(z.string()),
  version: z.string(),
  /** Design phase the engine supports; the web validates with the same ValidateOptions.phase. */
  phase: z.union([z.literal(1), z.literal(2)]),
  /** Prerequisite warnings from the CLI checks, e.g. "gh not found: PR nodes will fail". */
  warnings: z.array(z.string()),
  /** Node types the engine can run; the web validates with ValidateOptions.supportedNodeTypes. */
  supportedNodeTypes: z.array(NodeTypeSchema),
  /** A desktop notifier (notify-send / WSL PowerShell) was found (§18 Q2). */
  notificationsAvailable: z.boolean(),
});
export type RepoInfoResponse = z.infer<typeof RepoInfoResponseSchema>;

/** App-wide settings stored in ~/.promptgraph/settings.json. */
export const AppSettingsSchema = z.object({
  /** Desktop notifications when a node needs attention (§18 Q2). */
  notifications: z.boolean().default(true),
  /** Voice dictation (§21). Absent in files written before it existed; absent fields = defaults. */
  voice: VoiceSettingsSchema.optional(),
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

/** GET /api/graphs */
export const ListGraphsResponseSchema = z.object({ graphs: z.array(GraphListItemSchema) });
export type ListGraphsResponse = z.infer<typeof ListGraphsResponseSchema>;

/** GET /api/graphs/:id (422 ApiError{code:"invalid_graph"} when the file does not parse) */
export const GetGraphResponseSchema = z.object({
  graph: GraphSchema,
  hash: z.string(),
  /** File changed outside the app since the last run of this graph (§14). */
  modifiedOutside: z.boolean(),
  /** A run of this graph is active; the graph is read-only. */
  activeRunId: z.string().nullable(),
});
export type GetGraphResponse = z.infer<typeof GetGraphResponseSchema>;

/**
 * PUT /api/graphs/:id[?baseHash=<hash>] (upsert; body.id must equal :id; 409 while a run is active).
 * With `baseHash` (optimistic concurrency, §20.7), the save is refused with 409
 * ApiError{code: GRAPH_CONFLICT_CODE} when the file's current hash differs (or the graph does not exist).
 * The web editor saves without it.
 */
export const SaveGraphRequestSchema = GraphSchema;
export type SaveGraphRequest = z.input<typeof SaveGraphRequestSchema>;
export const SaveGraphQuerySchema = z.object({ baseHash: z.string().min(1).optional() });
export type SaveGraphQuery = z.infer<typeof SaveGraphQuerySchema>;
/** ApiError code of a PUT /api/graphs/:id whose baseHash is stale. */
export const GRAPH_CONFLICT_CODE = "graph_conflict";
export const SaveGraphResponseSchema = z.object({ graph: GraphSchema, hash: z.string() });
export type SaveGraphResponse = z.infer<typeof SaveGraphResponseSchema>;

/** DELETE /api/graphs/:id → OkResponse */

/** POST /api/graphs/:id/validate — body optional: validates the given (unsaved) graph instead of the file. */
export const ValidateGraphRequestSchema = z.object({ graph: GraphSchema.optional() });
export type ValidateGraphRequest = z.input<typeof ValidateGraphRequestSchema>;
export const ValidateGraphResponseSchema = ValidationResultSchema;
export type ValidateGraphResponse = z.infer<typeof ValidateGraphResponseSchema>;

/** POST /api/graphs/:id/runs — 422 ApiError{code:"validation_failed", details: ValidationResult} on errors. */
export const StartRunRequestSchema = z.object({});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
export const StartRunResponseSchema = RunDetailSchema;
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

// --- Runs ------------------------------------------------------------------

/** GET /api/runs?graph=<id>&limit=<n> (newest first) */
export const ListRunsQuerySchema = z.object({
  graph: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
export const ListRunsResponseSchema = z.object({ runs: z.array(RunSummarySchema) });
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;

/** GET /api/runs/:id */
export const GetRunResponseSchema = RunDetailSchema;
export type GetRunResponse = z.infer<typeof GetRunResponseSchema>;

/** POST /api/runs/:id/cancel → OkResponse */
/** POST /api/runs/:id/cleanup → OkResponse (remove worktrees + unpushed branches, §9.6) */

/** GET /api/pending — node runs waiting for approval across all runs (header counter). */
export const PendingResponseSchema = z.object({ nodeRuns: z.array(NodeRunSchema) });
export type PendingResponse = z.infer<typeof PendingResponseSchema>;

// --- Node runs -------------------------------------------------------------

/** POST /api/node-runs/:id/done → NodeRunResponse */
/** POST /api/node-runs/:id/skip → NodeRunResponse */
/** POST /api/node-runs/:id/fail */
export const FailNodeRequestSchema = z.object({ reason: z.string().optional() });
export type FailNodeRequest = z.infer<typeof FailNodeRequestSchema>;
/** POST /api/node-runs/:id/retry → NodeRunResponse (the new attempt) */
/** POST /api/node-runs/:id/hold */
export const HoldNodeRequestSchema = z.object({ hold: z.boolean() });
export type HoldNodeRequest = z.infer<typeof HoldNodeRequestSchema>;

export const NodeRunResponseSchema = z.object({ nodeRun: NodeRunSchema });
export type NodeRunResponse = z.infer<typeof NodeRunResponseSchema>;

/** POST /api/node-runs/:id/approval → NodeRunResponse */
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

/** GET /api/node-runs/:id/approval — what the approval dialog shows. */
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
 * GET /api/node-runs/:id/diff?scope=lane|node
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

/** GET /api/runs/:id/report */
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

/** GET /api/runs/:id/lanes/:laneId/diff → DiffResponse (lane vs its base; works after cleanup via snapshots). */

/**
 * POST /api/node-runs/:id/reopen — spawns `claude --resume <session>` (not part of the run), or returns
 * the node run's reopened PTY while it is still live. DELETE /api/ptys/:ptyId ends it.
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

/** GET /api/commands */
export const ListCommandsResponseSchema = z.object({ commands: z.array(SlashCommandSchema) });
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>;

// --- Hook receiver ---------------------------------------------------------

/** POST /hooks/:nodeRunId/:event — body is the raw Claude Code hook payload (see hooks.ts). Response: 204. */

/** Paths, for clients. */
export const API = {
  repo: "/api/repo",
  settings: "/api/settings",
  graphs: "/api/graphs",
  graph: (id: string) => `/api/graphs/${encodeURIComponent(id)}`,
  /** PUT with optimistic concurrency (SaveGraphQuery). */
  saveGraph: (id: string, baseHash?: string) =>
    `/api/graphs/${encodeURIComponent(id)}${baseHash ? `?baseHash=${encodeURIComponent(baseHash)}` : ""}`,
  validate: (id: string) => `/api/graphs/${encodeURIComponent(id)}/validate`,
  startRun: (id: string) => `/api/graphs/${encodeURIComponent(id)}/runs`,
  runs: "/api/runs",
  run: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
  cancelRun: (id: string) => `/api/runs/${encodeURIComponent(id)}/cancel`,
  cleanupRun: (id: string) => `/api/runs/${encodeURIComponent(id)}/cleanup`,
  resumeRun: (id: string) => `/api/runs/${encodeURIComponent(id)}/resume`,
  runReport: (id: string) => `/api/runs/${encodeURIComponent(id)}/report`,
  laneDiff: (runId: string, laneId: string) => `/api/runs/${encodeURIComponent(runId)}/lanes/${encodeURIComponent(laneId)}/diff`,
  pending: "/api/pending",
  nodeRunAction: (id: string, action: "done" | "fail" | "retry" | "skip" | "hold") =>
    `/api/node-runs/${encodeURIComponent(id)}/${action}`,
  approval: (id: string) => `/api/node-runs/${encodeURIComponent(id)}/approval`,
  diff: (id: string, scope: DiffScope = "lane") => `/api/node-runs/${encodeURIComponent(id)}/diff${scope === "lane" ? "" : `?scope=${scope}`}`,
  reopen: (id: string) => `/api/node-runs/${encodeURIComponent(id)}/reopen`,
  /** DELETE: ends a "Reopen session" PTY (the only PTYs not owned by a run). */
  pty: (id: string) => `/api/ptys/${encodeURIComponent(id)}`,
  commands: "/api/commands",
  claudeSetup: "/api/claude-setup",
  claudeCheck: "/api/claude-setup/check",
  /** GET list · POST create (§20). */
  chatSessions: "/api/chat/sessions",
  /** GET detail · DELETE. */
  chatSession: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}`,
  hook: (nodeRunId: string, event: string) => `/hooks/${encodeURIComponent(nodeRunId)}/${event}`,
  ws: "/ws",
} as const;

/** Cookie set by the server when the page is opened with ?t=<token>. */
export const TOKEN_COOKIE = "pg_token";
