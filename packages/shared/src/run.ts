import { z } from "zod";
import { GraphSchema } from "./graph.js";
import { LaneStatusSchema, NodeStatusSchema, RunStatusSchema } from "./status.js";

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  /** Estimated from the price table; 0 for unknown models. */
  costUsd: z.number(),
  model: z.string().nullable(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Stored as JSON in node_runs.output. Which fields are set depends on the node type. */
export const NodeRunOutputSchema = z.object({
  /** prompt/command: last assistant message. condition/judge: reason. */
  text: z.string().optional(),
  /** shell: exit code (null when killed by timeout/signal). */
  exitCode: z.number().nullable().optional(),
  /** shell: last 200 lines of combined output, ANSI stripped. */
  stdoutTail: z.string().optional(),
  timedOut: z.boolean().optional(),
  /** commit/merge: resulting commit. */
  sha: z.string().optional(),
  /** commit: commit message. */
  message: z.string().optional(),
  /** commit: nothing to commit; no commit created. */
  noop: z.boolean().optional(),
  /** pr */
  prUrl: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  /** merge: files that conflicted (resolved by Claude or the user). */
  conflictedFiles: z.array(z.string()).optional(),
  /** approval / pr gate */
  approved: z.boolean().optional(),
  comment: z.string().optional(),
  /** condition (Phase 2): chosen port. */
  port: z.enum(["true", "false"]).optional(),
  /** condition (Phase 2): evaluation result (port === "true"); the reason is in `text`. */
  result: z.boolean().optional(),
  /** skipped: the user skipped the node (treated as success downstream), not a dead path. */
  skippedByUser: z.boolean().optional(),
  /** failed (Phase 2): the failure was handled downstream (failure/always edge or loop back-edge); retry/skip do not apply. */
  failureHandled: z.boolean().optional(),
  /** failed (Phase 2): the node succeeded but its loop back-edge reached maxIterations (onExhausted "fail"); retry would fail again. */
  loopExhausted: z.boolean().optional(),
  /** Claude nodes (and headless helpers run on behalf of the node). */
  usage: TokenUsageSchema.optional(),
});
export type NodeRunOutput = z.infer<typeof NodeRunOutputSchema>;

/** Why a node is waiting_input. `notification_type` comes from the Notification hook. */
export const WaitingReasonSchema = z.object({
  kind: z.enum(["notification", "trust_dialog", "merge_conflict", "workspace_setup", "other"]),
  notificationType: z.string().optional(),
  message: z.string(),
});
export type WaitingReason = z.infer<typeof WaitingReasonSchema>;

export const LaneSetupStateSchema = z.enum(["running", "succeeded", "failed"]);
export type LaneSetupState = z.infer<typeof LaneSetupStateSchema>;

export const NodeRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  /** Phase 2 loop iteration, 0-based. */
  iteration: z.number().int(),
  /** Retry counter for the same (node, iteration); the highest attempt is current. */
  attempt: z.number().int(),
  laneId: z.string().nullable(),
  status: NodeStatusSchema,
  sessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  /** Live PTY (or replayable log) id for the terminal drawer; null for nodes without a terminal. */
  ptyId: z.string().nullable(),
  /** Last activity text from PreToolUse, e.g. "Bash: pnpm test". */
  activity: z.string().nullable(),
  waitingReason: WaitingReasonSchema.nullable(),
  /** Hold toggle: current turn behaves as completion "manual". */
  hold: z.boolean(),
  /** Workspace setup badge for the first node of a new lane. */
  laneSetup: LaneSetupStateSchema.nullable(),
  output: NodeRunOutputSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  /** Epoch ms of the last status change. */
  updatedAt: z.number(),
});
export type NodeRun = z.infer<typeof NodeRunSchema>;

export const LaneSchema = z.object({
  id: z.string(),
  runId: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  /** Ref (sha) the lane was branched from. */
  baseRef: z.string(),
  status: LaneStatusSchema,
  /** Lane index in creation order; used for the lane colour. */
  index: z.number().int(),
  /** Whether the branch was pushed (pushed branches survive cleanup). */
  pushed: z.boolean(),
});
export type Lane = z.infer<typeof LaneSchema>;

/** Run without its graph snapshot (lists, WS updates). */
export const RunSummarySchema = z.object({
  id: z.string(),
  repoPath: z.string(),
  graphId: z.string(),
  graphName: z.string(),
  status: RunStatusSchema,
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** Hash of the graph file at run start (§14 "modified outside the app"). */
  graphHash: z.string(),
  /** Short id used in branch names. */
  shortId: z.string(),
  error: z.string().nullable(),
  /** Counts of node runs needing attention, for the header counter. */
  pendingApprovals: z.number().int(),
  waitingInput: z.number().int(),
  usage: TokenUsageSchema,
  /** Worktrees were removed (cleanup done). */
  cleanedUp: z.boolean(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunSchema = RunSummarySchema.extend({ graphSnapshot: GraphSchema });
export type Run = z.infer<typeof RunSchema>;

/**
 * Phase 2 (§15.4): state of one loop back-edge in a run. `iteration` = times the edge has looped back in
 * the current pass of its enclosing loops (0 before the first loop-back; reset to 0 when an outer loop
 * repeats this loop's body). The edge may loop back while `iteration < maxIterations`, so the body runs
 * at most maxIterations + 1 times. The UI badge reads `iteration/maxIterations`.
 */
export const LoopStateSchema = z.object({
  edgeId: z.string(),
  iteration: z.number().int().min(0),
  maxIterations: z.number().int(),
  /** The edge would have looped back once more but the limit was reached (onExhausted applied). */
  exhausted: z.boolean(),
});
export type LoopState = z.infer<typeof LoopStateSchema>;

export const RunDetailSchema = z.object({
  run: RunSchema,
  lanes: z.array(LaneSchema),
  /** All node runs of the run, all iterations and attempts. */
  nodeRuns: z.array(NodeRunSchema),
  /** Phase 2: one entry per loop edge of the snapshot (canvas edge order). Absent for graphs without loops. */
  loops: z.array(LoopStateSchema).optional(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** Append-only event log row (§11.2). */
export const RunEventSchema = z.object({
  id: z.number().int(),
  runId: z.string(),
  nodeRunId: z.string().nullable(),
  type: z.string(),
  payload: z.unknown(),
  at: z.number(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;
