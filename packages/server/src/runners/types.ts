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
  /** Latest earlier attempt of this node (retry); for Claude nodes interrupted → resume its session. */
  previousAttempt: NodeRun | null;
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
  | { status: "cancelled" };

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

/** One runner per node type; types not yet implemented are absent (engine fails the node). */
export type RunnerRegistry = Partial<Record<NodeType, Runner>>;
