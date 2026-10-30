import type {
  ApprovalRequest,
  GraphNode,
  Lane,
  NodeRun,
  NodeRunOutput,
  NodeStatus,
  NodeType,
  Run,
} from "@promptgraph/shared";
import type { NodeRunPatch } from "../store/store.js";

/** Output of a direct predecessor in the current iteration (context blocks, resume, judge input). */
export interface PredecessorOutput {
  nodeId: string;
  label: string;
  type: NodeType;
  status: NodeStatus;
  output: NodeRunOutput | null;
  error: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
  laneId: string | null;
}

export interface RunnerContext {
  /** Includes graphSnapshot (settings, nodes). */
  run: Run;
  node: GraphNode;
  /** The node run as created by the engine (status "running"). */
  nodeRun: NodeRun;
  /** Lane (worktree) to run in. */
  lane: Lane;
  /** Direct predecessors, in canvas order. */
  predecessors: PredecessorOutput[];
  /**
   * §6.1: nodes since the last commit on the paths to this node, through merges (canvas order, merge
   * nodes left out) that ran; the input of generated commit/PR messages.
   */
  laneOutputs: PredecessorOutput[];
  /** Latest earlier attempt of this node (retry); for Claude nodes interrupted → resume its session. */
  previousAttempt: NodeRun | null;
  /**
   * Phase 2 loops (§15.4): this node's latest run of the previous iteration (null on the first pass and
   * outside loops). Claude nodes with context "resume" continue its session.
   */
  previousIteration?: NodeRun | null;
  /** Phase 2: the node is inside a loop body (its "resume" first pass may start a new session). */
  inLoopBody?: boolean;
  /**
   * merge nodes: the other input lanes to merge into `lane`, in canvas order of the inputs (§9.5, §18 Q4:
   * sequential pairwise). Already checkpointed by the engine, as is `lane`. Empty for other node types.
   */
  mergeSources: Lane[];
  /**
   * Commits of `lane` that other lanes of the run forked from and that are not merged yet (their
   * baseRef): squashCheckpoints never rewrites history below them, or merging those lanes back later
   * would duplicate it and conflict.
   */
  forkPoints: string[];
  /** Branch a pr targets (non-empty `config.base`, else `settings.baseBranch`); `settings.baseBranch` for other nodes. */
  baseBranch: string;
  /**
   * Waits for a slot under the run's `maxParallelClaude` cap (§8.4) before a non-Claude node spawns a
   * Claude session (merge conflict resolution); held until the node finishes. Rejects when `signal` aborts.
   */
  claudeSlot(): Promise<void>;
  /** Aborted when the run or node is cancelled. */
  signal: AbortSignal;
  /**
   * Persists a patch through the engine (which emits node:update/run:update and attention events).
   * Runners may set: status ∈ {running, idle, waiting_input, waiting_approval}, sessionId, transcriptPath,
   * ptyId, activity, waitingReason, laneSetup, output (partial, e.g. live usage). Final statuses are
   * set by the engine from the RunnerResult.
   */
  update(patch: NodeRunPatch): NodeRun;
  /** Appends to the run's event log. */
  event(type: string, payload?: unknown): void;
}

export type RunnerResult =
  | { status: "succeeded"; output: NodeRunOutput }
  | { status: "failed"; error: string; output?: NodeRunOutput }
  /** Phase 2 condition nodes report the chosen port inside output.port with status succeeded. */
  /** `output`: what was measured before the stop (e.g. Claude usage), kept on the node run. */
  | { status: "cancelled"; output?: NodeRunOutput };

/** Manual controls routed by the engine to the live execution (§12.1 node-run actions). */
export interface NodeControls {
  /** "Done": succeed now (Claude: idle/any turn; merge pause: conclude merge). */
  done(): void;
  fail(reason?: string): void;
  /** Hold: the current turn behaves as completion "manual" (Claude only; no-op elsewhere). */
  setHold(hold: boolean): void;
  /** approval / pr gate. */
  approve?(req: ApprovalRequest): void;
  /** The user typed into this node's PTY (cancels auto-grace, waiting_input → running). */
  userInput?(): void;
  /** Graceful stop: Claude "/exit", wait 3s, kill; others kill. Resolves when the process is gone. */
  cancel(): Promise<void>;
}

export interface NodeExecution {
  /** Settles exactly once. Rejections are treated as failed with the error message. */
  result: Promise<RunnerResult>;
  controls: NodeControls;
}

export interface Runner {
  start(ctx: RunnerContext): NodeExecution;
}

/**
 * One runner per node type. createRunnerRegistry fills every type; Partial is kept as an extension point
 * (tests and future node types): a type without a runner is reported unsupported by validation
 * (supportedNodeTypes) and fails at execution.
 */
export type RunnerRegistry = Partial<Record<NodeType, Runner>>;
