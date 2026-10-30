import type {
  ApprovalInfoResponse,
  ApprovalRequest,
  DiffResponse,
  NodeRun,
  ReopenResponse,
  RunDetail,
} from "@promptgraph/shared";
import type { PgPaths } from "../config/paths.js";
import type { EventBus } from "../events/bus.js";
import type { GraphStore } from "../graphs/graph-store.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { ClaudeRunner } from "../runners/claude/claude-runner.js";
import type { RunnerRegistry } from "../runners/types.js";
import type { Store } from "../store/store.js";
import type { LaneManager, RepoRef } from "../workspace/lane-manager.js";

export interface EngineDeps {
  store: Store;
  graphs: GraphStore;
  lanes: LaneManager;
  ptys: PtyManager;
  runners: RunnerRegistry;
  /** For reopenSession. */
  claude: ClaudeRunner;
  bus: EventBus;
  paths: PgPaths;
  repo: RepoRef;
  /** ValidateOptions.phase used when starting runs (SUPPORTED_PHASE). */
  phase: 1 | 2;
  now?: () => number;
}

/** Error with an HTTP-mappable code; routes translate it into ApiError. */
export class EngineError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "validation_failed"
      | "run_active"
      | "invalid_state"
      | "load_error",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Run orchestration (§8). The only writer of runs/node_runs/lanes status; every persisted change emits
 * run:update / node:update / lane:update, and transitions into idle/waiting_input/waiting_approval emit
 * `attention`. See CONTRACTS.md § Engine for the full lifecycle.
 */
export class Engine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Loads + validates (phase) the graph (422 validation_failed with ValidationResult details), records
   * the graph hash as known, snapshots it, computes the LanePlan, persists the run + a pending node run
   * per node, creates root lanes, and schedules roots. 409 run_active if this graph already has an
   * active (running/paused) run.
   */
  startRun(graphId: string): Promise<RunDetail> {
    throw new Error("not implemented");
  }

  getRun(runId: string): RunDetail {
    throw new Error("not implemented");
  }

  /** Cancels live executions (graceful), queued nodes → cancelled, run → cancelled, then cleanup per policy. */
  cancelRun(runId: string): Promise<void> {
    throw new Error("not implemented");
  }

  /** Manual "Clean up" (§9.6): force cleanup of worktrees/unpushed branches of a finished run. */
  cleanupRun(runId: string): Promise<void> {
    throw new Error("not implemented");
  }

  /** Active (running or paused) run of a graph, if any. Graphs are read-only while one exists. */
  activeRunForGraph(graphId: string): string | null {
    throw new Error("not implemented");
  }

  // Manual controls (§12.1). invalid_state when the node run is not in a state that accepts the action.
  done(nodeRunId: string): Promise<NodeRun> {
    throw new Error("not implemented");
  }
  fail(nodeRunId: string, reason?: string): Promise<NodeRun> {
    throw new Error("not implemented");
  }
  /** failed/interrupted/cancelled node → new attempt (paused run resumes running). Returns the new node run. */
  retry(nodeRunId: string): Promise<NodeRun> {
    throw new Error("not implemented");
  }
  /** failed/interrupted/pending node → skipped, treated as success downstream (§8.3). */
  skip(nodeRunId: string): Promise<NodeRun> {
    throw new Error("not implemented");
  }
  setHold(nodeRunId: string, hold: boolean): Promise<NodeRun> {
    throw new Error("not implemented");
  }
  submitApproval(nodeRunId: string, req: ApprovalRequest): Promise<NodeRun> {
    throw new Error("not implemented");
  }

  getApprovalInfo(nodeRunId: string): Promise<ApprovalInfoResponse> {
    throw new Error("not implemented");
  }
  getDiff(nodeRunId: string): Promise<DiffResponse> {
    throw new Error("not implemented");
  }
  reopenSession(nodeRunId: string): Promise<ReopenResponse> {
    throw new Error("not implemented");
  }

  /** Wired to PtyManager.onUserInput: forwards to the owning execution's controls.userInput(). */
  handleUserInput(ptyId: string): void {
    throw new Error("not implemented");
  }

  /** Startup: markInterrupted + LaneManager.prune. */
  recover(): Promise<void> {
    throw new Error("not implemented");
  }

  /** SIGINT (§4.5): cancel-gracefully every live execution (≤5s), node runs → interrupted, runs → paused. */
  shutdown(): Promise<void> {
    throw new Error("not implemented");
  }
}
