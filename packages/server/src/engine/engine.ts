import {
  ATTENTION_NODE_STATUSES,
  buildTopology,
  computeLanePlan,
  edgeMatches,
  isFinalNodeStatus,
  isFinalRunStatus,
  NODE_TYPES,
  validateGraph,
  type ApprovalInfoResponse,
  type ApprovalRequest,
  type DiffResponse,
  type Graph,
  type GraphNode,
  type Lane,
  type LanePlan,
  type NodeOutcome,
  type NodeRun,
  type NodeRunOutput,
  type NodeStatus,
  type NodeType,
  type PlannedLane,
  type ReopenResponse,
  type Run,
  type RunDetail,
  type RunStatus,
  type Topology,
} from "@promptgraph/shared";
import { childEnv } from "../config/child-env.js";
import { ptyLogPath, type PgPaths } from "../config/paths.js";
import type { EventBus } from "../events/bus.js";
import { GraphLoadError, GraphNotFoundError, type GraphStore } from "../graphs/graph-store.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { ClaudeRunner } from "../runners/claude/claude-runner.js";
import type { NodeControls, PredecessorOutput, RunnerContext, RunnerRegistry, RunnerResult } from "../runners/types.js";
import type { NodeRunPatch, Store } from "../store/store.js";
import { newId, newShortId } from "../util/ids.js";
import type { LaneManager, RepoRef } from "../workspace/lane-manager.js";
import { runWorkspaceSetup } from "../workspace/setup.js";
import { ActivationTracker } from "./activation.js";
import { markInterrupted } from "./recovery.js";
import { Scheduler, type SchedulerItem } from "./scheduler.js";
import { assertTransition, RUN_TRANSITIONS } from "./state.js";

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
  /** Base env for child processes started by the engine itself (workspace setup). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Max wait for graceful stops on cancel/shutdown before PTYs are killed. Default 5000 ms (§4.5). */
  stopTimeoutMs?: number;
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

/** Statuses a runner may set through ctx.update (final ones come from its RunnerResult). */
const RUNNER_STATUSES: ReadonlySet<NodeStatus> = new Set(["running", "idle", "waiting_input", "waiting_approval"]);
const RETRYABLE: ReadonlySet<NodeStatus> = new Set(["failed", "interrupted", "cancelled"]);
const SKIPPABLE: ReadonlySet<NodeStatus> = new Set(["failed", "interrupted", "pending", "ready"]);
/** Event type marking a user skip; restore() treats such skipped node runs as success, others as dead paths. */
const USER_SKIP_EVENT = "node.user_skip";
const DEFAULT_STOP_TIMEOUT_MS = 5000;

/** A started node: `controls` is set once its runner has started (lane/setup steps come first). */
interface LiveExecution {
  nodeRunId: string;
  abort: AbortController;
  controls: NodeControls | null;
}

/** In-memory state of a run that is running or paused. */
interface LiveRun {
  runId: string;
  graph: Graph;
  nodes: ReadonlyMap<string, GraphNode>;
  topo: Topology;
  plan: LanePlan;
  tracker: ActivationTracker;
  scheduler: Scheduler;
  executions: Map<string, LiveExecution>;
  /** Lanes being created (or created) in this process; rejected creations are removed so a retry recreates. */
  laneCreation: Map<string, Promise<Lane>>;
  /** New lanes whose workspace setup has not run yet. */
  needsSetup: Set<string>;
  /** Async transitions in progress (finishing nodes, forks, skips): the run is not idle meanwhile. */
  inflight: number;
  /** Cancel / fail-run in progress: results are persisted but the flow no longer advances. */
  terminating: boolean;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const labelOf = (node: GraphNode): string => node.label || node.id;

/** `p`, rejected as soon as `signal` aborts. */
function unlessAborted(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    p.then(done, done);
  });
}

/** Latest (iteration, attempt) node run per node. `nodeRuns` is ordered by node id, iteration, attempt. */
function currentByNode(nodeRuns: readonly NodeRun[]): Map<string, NodeRun> {
  const map = new Map<string, NodeRun>();
  for (const nr of nodeRuns) map.set(nr.nodeId, nr);
  return map;
}

/**
 * Run orchestration (§8). The only writer of runs/node_runs/lanes status; every persisted change emits
 * run:update / node:update / lane:update, and transitions into idle/waiting_input/waiting_approval emit
 * `attention`. See CONTRACTS.md § Engine for the full lifecycle.
 */
export class Engine {
  private readonly live = new Map<string, LiveRun>();
  private readonly now: () => number;
  private shuttingDown = false;
  /** Background node chains (execute → finish → advance/finalize); shutdown waits for them before the DB closes. */
  private readonly chains = new Set<Promise<void>>();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    deps.graphs.setWriteGuard((graphId) => {
      if (this.activeRunForGraph(graphId)) {
        throw new EngineError("run_active", `Graph "${graphId}" has an active run; it is read-only until the run ends`);
      }
    });
  }

  /**
   * Loads + validates (phase) the graph (422 validation_failed with ValidationResult details), records
   * the graph hash as known, snapshots it, computes the LanePlan, persists the run + a pending node run
   * per node, creates root lanes, and schedules roots. 409 run_active if this graph already has an
   * active (running/paused) run.
   */
  async startRun(graphId: string): Promise<RunDetail> {
    const { store, repo } = this.deps;
    let loaded;
    try {
      loaded = this.deps.graphs.get(graphId);
    } catch (err) {
      if (err instanceof GraphNotFoundError) throw new EngineError("not_found", err.message);
      if (err instanceof GraphLoadError) throw new EngineError("load_error", err.message, err.details);
      throw err;
    }
    const graph = loaded.graph;
    const validation = validateGraph(graph, { phase: this.deps.phase, supportedNodeTypes: this.supportedNodeTypes() });
    if (validation.errors.length > 0) {
      throw new EngineError("validation_failed", `Graph "${graphId}" has validation errors`, validation);
    }
    if (this.activeRunForGraph(graphId)) throw new EngineError("run_active", `Graph "${graphId}" already has an active run`);

    const plan = computeLanePlan(graph);
    const runId = newId();
    const run = store.transaction(() => {
      store.setKnownGraphHash(repo.path, graphId, loaded.hash);
      const r = store.insertRun({ id: runId, repoPath: repo.path, graph, graphHash: loaded.hash, shortId: newShortId(), startedAt: this.now() });
      for (const node of graph.nodes) {
        store.insertNodeRun({ id: newId(), runId, nodeId: node.id, iteration: 0, attempt: 0, laneId: plan.laneOf.get(node.id) ?? null, status: "pending" });
      }
      store.appendEvent(runId, null, "run.started", { graphId, graphHash: loaded.hash });
      return r;
    });
    const live = this.createLive(run, plan, new ActivationTracker(graph));
    this.emitRun(runId);
    for (const nr of store.listNodeRuns(runId)) this.deps.bus.emit("node:update", { nodeRun: nr });

    try {
      for (const planned of plan.lanes.filter((l) => l.parentLaneId === null)) {
        await this.createLane(live, run, planned, graph.settings.baseBranch);
      }
    } catch (err) {
      await this.terminate(live, "failed", `Could not create the workspace: ${errorMessage(err)}`);
      return this.getRun(runId);
    }
    for (const nodeId of live.tracker.initialReady()) this.makeReady(live, nodeId);
    return this.getRun(runId);
  }

  /** Node types with a registered runner (the others fail validation until their milestone lands). */
  supportedNodeTypes(): NodeType[] {
    return NODE_TYPES.filter((t) => this.deps.runners[t] !== undefined);
  }

  getRun(runId: string): RunDetail {
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (!run) throw new EngineError("not_found", `Run ${runId} not found`);
    return { run, lanes: store.listLanes(runId), nodeRuns: store.listNodeRuns(runId) };
  }

  /** Cancels live executions (graceful), queued nodes → cancelled, run → cancelled, then cleanup per policy. */
  async cancelRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (isFinalRunStatus(run.status)) throw new EngineError("invalid_state", `Run ${runId} is already ${run.status}`);
    this.deps.store.appendEvent(runId, null, "run.action", { action: "cancel" });
    await this.terminate(this.ensureLive(run), "cancelled", null);
  }

  /**
   * Resumes a paused run that has no failed/interrupted/cancelled node to retry or skip, e.g. one
   * stopped while successors were being made ready (fork-lane creation). Otherwise invalid_state.
   */
  async resumeRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status !== "paused") throw new EngineError("invalid_state", `Run ${runId} is ${run.status}, not paused`);
    const live = this.ensureLive(run);
    const blocking = this.blockingNodeRuns(live);
    if (blocking.length > 0) {
      const label = labelOf(live.nodes.get(blocking[0]!.nodeId)!);
      throw new EngineError("invalid_state", `Node "${label}" is ${blocking[0]!.status}: retry or skip it to continue`);
    }
    this.deps.store.appendEvent(runId, null, "run.action", { action: "resume" });
    this.resumeIfPaused(run);
    this.resumeReady(live);
    await this.checkProgress(live);
  }

  /** Manual "Clean up" (§9.6): force cleanup of worktrees/unpushed branches of a finished run. */
  async cleanupRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (!isFinalRunStatus(run.status)) throw new EngineError("invalid_state", `Run ${runId} is still ${run.status}`);
    await this.deps.lanes.cleanup(runId, { keep: run.graphSnapshot.settings.keepWorktrees, failed: run.status !== "succeeded", force: true });
    this.deps.store.appendEvent(runId, null, "run.cleanup", { manual: true });
    this.emitRun(runId);
  }

  /** Active (running or paused) run of a graph, if any. Graphs are read-only while one exists. */
  activeRunForGraph(graphId: string): string | null {
    const { store, repo } = this.deps;
    const run = store.listRunsByStatus(["running", "paused"]).find((r) => r.repoPath === repo.path && r.graphId === graphId);
    return run?.id ?? null;
  }

  // Manual controls (§12.1). invalid_state when the node run is not in a state that accepts the action.
  async done(nodeRunId: string): Promise<NodeRun> {
    const controls = this.requireControls(nodeRunId, "done");
    controls.done();
    return this.requireNodeRun(nodeRunId);
  }

  async fail(nodeRunId: string, reason?: string): Promise<NodeRun> {
    const controls = this.requireControls(nodeRunId, "fail", { reason: reason ?? null });
    controls.fail(reason);
    return this.requireNodeRun(nodeRunId);
  }

  /** failed/interrupted/cancelled node → new attempt (paused run resumes running). Returns the new node run. */
  async retry(nodeRunId: string): Promise<NodeRun> {
    const { store } = this.deps;
    const nr = this.requireNodeRun(nodeRunId);
    const run = this.requireActiveRun(nr.runId);
    if (!RETRYABLE.has(nr.status)) throw new EngineError("invalid_state", `Cannot retry a ${nr.status} node`);
    this.requireCurrent(nr);
    const live = this.ensureLive(run);
    if (live.tracker.isResolved(nr.nodeId)) throw new EngineError("invalid_state", "The failure was already routed downstream");

    const next = store.insertNodeRun({
      id: newId(),
      runId: nr.runId,
      nodeId: nr.nodeId,
      iteration: nr.iteration,
      attempt: nr.attempt + 1,
      laneId: nr.laneId,
      status: "pending",
    });
    store.appendEvent(nr.runId, nr.id, "node.action", { action: "retry", newNodeRunId: next.id });
    this.deps.bus.emit("node:update", { nodeRun: next });
    this.resumeIfPaused(run);
    this.makeReady(live, nr.nodeId);
    this.resumeReady(live);
    return this.requireNodeRun(next.id);
  }

  /** failed/interrupted/pending node → skipped, treated as success downstream (§8.3). */
  async skip(nodeRunId: string): Promise<NodeRun> {
    const nr = this.requireNodeRun(nodeRunId);
    const run = this.requireActiveRun(nr.runId);
    if (!SKIPPABLE.has(nr.status)) throw new EngineError("invalid_state", `Cannot skip a ${nr.status} node`);
    this.requireCurrent(nr);
    const live = this.ensureLive(run);
    if (nr.status === "ready") live.scheduler.remove(nr.id);
    this.deps.store.appendEvent(nr.runId, nr.id, USER_SKIP_EVENT, null);
    this.patchNodeRun(nr.id, { status: "skipped", output: { ...nr.output, skippedByUser: true }, finishedAt: this.now() });
    this.resumeIfPaused(run);
    live.inflight++;
    try {
      await this.advance(live, nr.nodeId, "user-skip");
      this.resumeReady(live);
    } finally {
      live.inflight--;
    }
    await this.checkProgress(live);
    return this.requireNodeRun(nr.id);
  }

  async setHold(nodeRunId: string, hold: boolean): Promise<NodeRun> {
    const nr = this.requireNodeRun(nodeRunId);
    if (isFinalNodeStatus(nr.status)) throw new EngineError("invalid_state", `Cannot hold a ${nr.status} node`);
    const updated = this.patchNodeRun(nr.id, { hold });
    this.deps.store.appendEvent(nr.runId, nr.id, "node.action", { action: "hold", hold });
    this.findExecution(nr.id)?.controls?.setHold(hold);
    return updated;
  }

  async submitApproval(nodeRunId: string, req: ApprovalRequest): Promise<NodeRun> {
    const nr = this.requireNodeRun(nodeRunId);
    const controls = this.findExecution(nodeRunId)?.controls;
    if (nr.status !== "waiting_approval" || !controls?.approve) {
      throw new EngineError("invalid_state", `Node run ${nodeRunId} is not waiting for approval`);
    }
    this.deps.store.appendEvent(nr.runId, nr.id, "node.action", { action: "approval", approved: req.approved, comment: req.comment ?? null });
    controls.approve(req);
    return this.requireNodeRun(nodeRunId);
  }

  async getApprovalInfo(nodeRunId: string): Promise<ApprovalInfoResponse> {
    const nr = this.requireNodeRun(nodeRunId);
    const run = this.requireRun(nr.runId);
    const graph = run.graphSnapshot;
    const node = graph.nodes.find((n) => n.id === nr.nodeId);
    if (!node || (node.type !== "approval" && node.type !== "pr")) {
      throw new EngineError("invalid_state", `Node run ${nodeRunId} is not an approval gate`);
    }
    const preds = this.predecessorsOf(buildTopology(graph), nr.runId, nr.nodeId);
    return {
      nodeRun: nr,
      message: node.type === "approval" ? (node.config.message ?? null) : null,
      showDiff: node.type === "approval" ? node.config.showDiff : true,
      pr:
        node.type === "pr"
          ? {
              title: nr.output?.title ?? node.config.title ?? "",
              body: nr.output?.body ?? node.config.body ?? "",
              base: node.config.base ?? graph.settings.baseBranch,
              draft: node.config.draft,
            }
          : null,
      predecessorOutputs: preds.map((p) => ({
        nodeId: p.nodeId,
        label: p.label,
        text: p.output?.text ?? p.output?.stdoutTail ?? p.error ?? gitStepSummary(p.output),
      })),
    };
  }

  async getDiff(nodeRunId: string): Promise<DiffResponse> {
    const nr = this.requireNodeRun(nodeRunId);
    const run = this.requireRun(nr.runId);
    const lane = nr.laneId ? this.deps.store.getLane(nr.runId, nr.laneId) : undefined;
    if (!lane) throw new EngineError("invalid_state", "This node has no workspace yet");
    return this.deps.lanes.diff(lane, run.graphSnapshot.settings.baseBranch);
  }

  async reopenSession(nodeRunId: string): Promise<ReopenResponse> {
    const nr = this.requireNodeRun(nodeRunId);
    if (!nr.sessionId) throw new EngineError("invalid_state", "This node has no Claude session");
    const run = this.requireRun(nr.runId);
    const lane = nr.laneId ? (this.deps.store.getLane(nr.runId, nr.laneId) ?? null) : null;
    const ptyId = this.deps.claude.reopen(run, nr, lane, this.deps.repo.path);
    this.deps.store.appendEvent(nr.runId, nr.id, "node.action", { action: "reopen", ptyId });
    return { ptyId };
  }

  /** Ends a "Reopen session" PTY (its terminal tab was closed). not_found unless one is live. */
  closeReopenedSession(ptyId: string): void {
    if (!this.deps.claude.closeReopened(ptyId)) throw new EngineError("not_found", `No reopened session ${ptyId} is running`);
  }

  /** Wired to PtyManager.onUserInput: forwards to the owning execution's controls.userInput(). */
  handleUserInput(ptyId: string): void {
    const exec = this.findExecution(ptyId) ?? this.findExecution(this.deps.store.findNodeRunByPtyId(ptyId)?.id ?? "");
    exec?.controls?.userInput?.();
  }

  /** Startup: markInterrupted + LaneManager.prune. */
  async recover(): Promise<void> {
    markInterrupted(this.deps.store, this.now());
    await this.deps.lanes.prune();
  }

  /** SIGINT (§4.5): cancel-gracefully every live execution (≤5s), node runs → interrupted, runs → paused. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const execs = [...this.live.values()].flatMap((live) => {
      live.scheduler.clear();
      return [...live.executions.values()];
    });
    for (const e of execs) e.abort.abort();
    await withTimeout(Promise.allSettled(execs.map((e) => e.controls?.cancel())), this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    await this.deps.ptys.killAll();
    await withTimeout(Promise.allSettled([...this.chains]), this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    for (const runId of markInterrupted(this.deps.store, this.now())) this.emitRun(runId);
    this.live.clear();
  }

  // ---------------------------------------------------------------------------
  // Live run state
  // ---------------------------------------------------------------------------

  private createLive(run: Run, plan: LanePlan, tracker: ActivationTracker): LiveRun {
    const graph = run.graphSnapshot;
    const live: LiveRun = {
      runId: run.id,
      graph,
      nodes: new Map(graph.nodes.map((n) => [n.id, n] as const)),
      topo: buildTopology(graph),
      plan,
      tracker,
      scheduler: new Scheduler(graph.settings.maxParallelClaude, (item) => this.startNode(live, item)),
      executions: new Map(),
      laneCreation: new Map(),
      needsSetup: new Set(),
      inflight: 0,
      terminating: false,
    };
    this.live.set(run.id, live);
    return live;
  }

  /**
   * Live state of an active run; rebuilt from the store when the process has none (paused after a
   * restart): the tracker replays finished node runs. Nothing is scheduled here (see resumeReady).
   */
  private ensureLive(run: Run): LiveRun {
    const existing = this.live.get(run.id);
    if (existing) return existing;
    const { store } = this.deps;
    const graph = run.graphSnapshot;
    const topo = buildTopology(graph);
    const userSkipped = new Set(store.listEvents(run.id).filter((e) => e.type === USER_SKIP_EVENT).map((e) => e.nodeRunId));
    const finished: Array<{ nodeId: string; outcome: NodeOutcome | "skipped" }> = [];
    for (const nr of currentByNode(store.listNodeRuns(run.id)).values()) {
      if (nr.status === "succeeded") finished.push({ nodeId: nr.nodeId, outcome: { kind: "success", port: nr.output?.port } });
      else if (nr.status === "skipped") finished.push({ nodeId: nr.nodeId, outcome: userSkipped.has(nr.id) ? { kind: "success" } : "skipped" });
      else if (nr.status === "failed" && this.hasFailureRoute(topo, nr.nodeId)) finished.push({ nodeId: nr.nodeId, outcome: { kind: "failure" } });
    }
    const live = this.createLive(run, computeLanePlan(graph), ActivationTracker.restore(graph, finished));
    if (graph.settings.workspaceSetup) {
      // A lane is set up once one of its node runs completed the setup; otherwise the next node retries it.
      const setUp = new Set(store.listNodeRuns(run.id).filter((nr) => nr.laneSetup === "succeeded").map((nr) => nr.laneId));
      for (const lane of store.listLanes(run.id)) if (!setUp.has(lane.id)) live.needsSetup.add(lane.id);
    }
    return live;
  }

  /** Re-enqueues pending nodes whose inputs are resolved (after restore, or when a paused run resumes). */
  private resumeReady(live: LiveRun): void {
    const current = this.currentNodeRuns(live.runId);
    for (const nodeId of live.tracker.readyUnresolved()) {
      if (current.get(nodeId)?.status === "pending") this.makeReady(live, nodeId);
    }
  }

  private makeReady(live: LiveRun, nodeId: string): void {
    const nr = this.currentNodeRuns(live.runId).get(nodeId);
    const node = live.nodes.get(nodeId);
    if (!nr || !node || (nr.status !== "pending" && nr.status !== "ready")) return;
    if (nr.status === "pending") this.patchNodeRun(nr.id, { status: "ready" });
    live.scheduler.enqueue({ nodeRunId: nr.id, nodeType: node.type, laneId: nr.laneId ?? "" });
  }

  // ---------------------------------------------------------------------------
  // Node execution
  // ---------------------------------------------------------------------------

  /** Scheduler.onStart (synchronous): marks the node running and runs it in the background. */
  private startNode(live: LiveRun, item: SchedulerItem): void {
    if (this.shuttingDown || live.terminating) {
      live.scheduler.release(item.nodeRunId);
      return;
    }
    const exec: LiveExecution = { nodeRunId: item.nodeRunId, abort: new AbortController(), controls: null };
    live.executions.set(item.nodeRunId, exec);
    this.patchNodeRun(item.nodeRunId, { status: "running", startedAt: this.now(), error: null });
    const chain = this.executeNode(live, exec)
      .catch((err: unknown): RunnerResult => ({ status: "failed", error: errorMessage(err) }))
      .then((result) => this.finishNode(live, exec, result))
      .catch((err: unknown) => {
        if (!this.shuttingDown) this.deps.store.appendEvent(live.runId, exec.nodeRunId, "engine.error", { error: errorMessage(err) });
      })
      .finally(() => this.chains.delete(chain));
    this.chains.add(chain);
  }

  private async executeNode(live: LiveRun, exec: LiveExecution): Promise<RunnerResult> {
    const { store } = this.deps;
    const signal = exec.abort.signal;
    const nodeRun = this.requireNodeRun(exec.nodeRunId);
    const node = live.nodes.get(nodeRun.nodeId)!;
    const runner = this.deps.runners[node.type];
    if (!runner) return { status: "failed", error: `Node type "${node.type}" is not supported yet` };
    if (!nodeRun.laneId) return { status: "failed", error: "Node has no lane" };

    const lane = await this.ensureLane(live, nodeRun.laneId);
    if (signal.aborted) return { status: "cancelled" };

    const setup = live.graph.settings.workspaceSetup;
    if (setup && live.needsSetup.delete(lane.id)) {
      this.patchNodeRun(nodeRun.id, { laneSetup: "running" });
      const res = await runWorkspaceSetup({
        ptys: this.deps.ptys,
        lane,
        command: setup,
        nodeRunId: nodeRun.id,
        logPath: ptyLogPath(this.deps.paths, live.runId, `setup-${nodeRun.id}`),
        env: childEnv({}, this.deps.env),
        signal,
      });
      this.patchNodeRun(nodeRun.id, { laneSetup: res.ok ? "succeeded" : "failed" });
      if (!res.ok || signal.aborted) live.needsSetup.add(lane.id);
      if (signal.aborted) return { status: "cancelled" };
      if (!res.ok) return { status: "failed", error: `Workspace setup failed (exit code ${res.exitCode ?? "none"})` };
    }

    const predecessors = this.predecessorsOf(live.topo, live.runId, node.id);
    if (node.type === "pr") {
      // §18 Q1: changes left by earlier nodes must be part of what gets pushed.
      await this.deps.lanes.checkpoint(lane, predecessors[0]?.label ?? labelOf(node));
      if (signal.aborted) return { status: "cancelled" };
    }
    const mergeSources = node.type === "merge" ? await this.prepareMerge(live, node, lane) : [];
    if (signal.aborted) return { status: "cancelled" };
    const settings = live.graph.settings;

    const previousAttempt =
      store
        .listNodeRuns(live.runId)
        .filter((r) => r.nodeId === nodeRun.nodeId && r.iteration === nodeRun.iteration && r.attempt < nodeRun.attempt)
        .at(-1) ?? null;
    const ctx: RunnerContext = {
      run: this.requireRun(live.runId),
      node,
      nodeRun: this.requireNodeRun(nodeRun.id),
      lane,
      predecessors,
      laneOutputs: this.laneOutputsOf(live, node.id),
      previousAttempt,
      mergeSources,
      baseBranch: (node.type === "pr" && node.config.base?.trim()) || settings.baseBranch,
      claudeSlot: () => unlessAborted(live.scheduler.acquireClaudeSlot(nodeRun.id), signal),
      signal,
      update: (patch) => this.runnerUpdate(live, nodeRun.id, patch),
      event: (type, payload) => {
        store.appendEvent(live.runId, nodeRun.id, type, payload ?? null);
      },
    };
    const execution = runner.start(ctx);
    exec.controls = execution.controls;
    // A cancel that arrived while the lane/setup steps ran has nobody to stop otherwise.
    if (signal.aborted) void execution.controls.cancel();
    return execution.result;
  }

  private async finishNode(live: LiveRun, exec: LiveExecution, result: RunnerResult): Promise<void> {
    if (this.shuttingDown) return; // shutdown marks everything interrupted
    live.inflight++;
    // Stamped before the release starts the next queued node, so finishedAt <= its startedAt.
    const finishedAt = this.now();
    live.executions.delete(exec.nodeRunId);
    live.scheduler.release(exec.nodeRunId);
    try {
      const nr = this.requireNodeRun(exec.nodeRunId);
      if (isFinalNodeStatus(nr.status)) return; // already settled by cancel/terminate
      const node = live.nodes.get(nr.nodeId)!;
      if (result.status === "succeeded") {
        this.patchNodeRun(nr.id, { status: "succeeded", output: { ...nr.output, ...result.output }, finishedAt });
        if (!live.terminating) await this.advance(live, node.id, { kind: "success", port: result.output.port });
      } else if (result.status === "failed") {
        const output = result.output ? { ...nr.output, ...result.output } : undefined;
        this.patchNodeRun(nr.id, { status: "failed", error: result.error, output, finishedAt });
        if (live.terminating) return;
        if (this.hasFailureRoute(live.topo, node.id)) {
          await this.advance(live, node.id, { kind: "failure" });
        } else if ((node.onError ?? "pause") === "fail-run") {
          await this.terminate(live, "failed", `Node "${labelOf(node)}" failed: ${result.error}`);
        }
      } else {
        this.patchNodeRun(nr.id, { status: "cancelled", finishedAt });
      }
    } finally {
      live.inflight--;
    }
    await this.checkProgress(live);
  }

  /**
   * Delivers the outcome of a resolved node (§8.1): creates the fork lanes its newly ready successors
   * need (checkpointing the parent first, §9.3), marks dead paths skipped, and enqueues ready nodes.
   */
  private async advance(live: LiveRun, nodeId: string, outcome: NodeOutcome | "user-skip"): Promise<void> {
    const delta = outcome === "user-skip" ? live.tracker.skipAsSuccess(nodeId) : live.tracker.complete(nodeId, outcome);
    // Lanes granted by activated edges (dead branches get none), also when the target is a merge that is
    // not ready yet: the fork must capture the parent as it is now, not when the merge starts.
    const granted = new Set(
      (live.topo.outgoing.get(nodeId) ?? []).filter((e) => live.tracker.isActivated(e.id)).map((e) => live.plan.edgeLane.get(e.id)),
    );
    const forks = live.plan.lanes.filter((l) => l.forkAfterNodeId === nodeId && granted.has(l.id));
    // Errors surface again when the lane's first node starts (ensureLane) and fail that node.
    await Promise.allSettled(forks.map((l) => this.ensureLane(live, l.id)));
    if (live.terminating || this.shuttingDown) return;
    const current = this.currentNodeRuns(live.runId);
    for (const id of delta.skipped) {
      const nr = current.get(id);
      if (nr && !isFinalNodeStatus(nr.status)) this.patchNodeRun(nr.id, { status: "skipped", finishedAt: this.now() });
    }
    for (const id of delta.ready) this.makeReady(live, id);
  }

  /** Run end / pause detection once nothing is running, queued or in transition. */
  private async checkProgress(live: LiveRun): Promise<void> {
    if (live.terminating || this.shuttingDown) return;
    if (live.executions.size > 0 || live.inflight > 0 || live.scheduler.queuedCount > 0 || live.scheduler.runningCount > 0) return;
    const run = this.requireRun(live.runId);
    if (isFinalRunStatus(run.status)) return;
    const current = [...this.currentNodeRuns(live.runId).values()];
    const blocking = this.blockingNodeRuns(live);
    if (blocking.length > 0) {
      if (run.status === "running") {
        const first = blocking[0]!;
        const label = labelOf(live.nodes.get(first.nodeId)!);
        this.setRunStatus(live.runId, "paused", { error: `Node "${label}" is ${first.status}${first.error ? `: ${first.error}` : ""}` });
      }
      return;
    }
    const allDone = current.every((nr) => nr.status === "succeeded" || nr.status === "skipped" || nr.status === "failed");
    if (allDone) await this.finalize(live, "succeeded", null);
    else await this.terminate(live, "failed", "No node can make progress");
  }

  /** Current node runs that keep the run paused until the user retries or skips them. */
  private blockingNodeRuns(live: LiveRun): NodeRun[] {
    return [...this.currentNodeRuns(live.runId).values()].filter(
      (nr) =>
        nr.status === "interrupted" ||
        nr.status === "cancelled" ||
        (nr.status === "failed" && !this.hasFailureRoute(live.topo, nr.nodeId)),
    );
  }

  /** Stops everything still live, cancels unfinished node runs and ends the run (cancel, fail-run). */
  private async terminate(live: LiveRun, status: "failed" | "cancelled", error: string | null): Promise<void> {
    if (live.terminating) return;
    live.terminating = true;
    live.scheduler.clear();
    const execs = [...live.executions.values()];
    for (const e of execs) e.abort.abort();
    await withTimeout(Promise.allSettled(execs.map((e) => e.controls?.cancel())), this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    const finishedAt = this.now();
    for (const nr of this.currentNodeRuns(live.runId).values()) {
      if (!isFinalNodeStatus(nr.status)) this.patchNodeRun(nr.id, { status: "cancelled", finishedAt });
    }
    await this.finalize(live, status, error);
  }

  private async finalize(live: LiveRun, status: "succeeded" | "failed" | "cancelled", error: string | null): Promise<void> {
    this.live.delete(live.runId);
    this.setRunStatus(live.runId, status, { finishedAt: this.now(), error });
    // A lane still being created would otherwise be inserted after cleanup and leak its worktree/branch.
    await withTimeout(Promise.allSettled(live.laneCreation.values()), this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    try {
      await this.deps.lanes.cleanup(live.runId, { keep: live.graph.settings.keepWorktrees, failed: status !== "succeeded" });
    } catch (err) {
      this.deps.store.appendEvent(live.runId, null, "run.cleanup_failed", { error: errorMessage(err) });
    }
    this.emitRun(live.runId);
  }

  // ---------------------------------------------------------------------------
  // Lanes
  // ---------------------------------------------------------------------------

  /** The lane, creating it if needed (root lane from baseBranch, or fork from its parent after a checkpoint). */
  private ensureLane(live: LiveRun, laneId: string): Promise<Lane> {
    const pending = live.laneCreation.get(laneId);
    if (pending) return pending;
    const existing = this.deps.store.getLane(live.runId, laneId);
    if (existing) return Promise.resolve(existing);
    const planned = live.plan.lanes.find((l) => l.id === laneId);
    if (!planned) return Promise.reject(new Error(`Unknown lane "${laneId}"`));
    const run = this.requireRun(live.runId);
    if (!planned.parentLaneId) return this.createLane(live, run, planned, live.graph.settings.baseBranch);
    const parentId = planned.parentLaneId;
    const forkAfter = planned.forkAfterNodeId ? live.nodes.get(planned.forkAfterNodeId) : undefined;
    return this.trackLane(
      live,
      laneId,
      (async () => {
        const parent = await this.ensureLane(live, parentId);
        await this.deps.lanes.checkpoint(parent, forkAfter ? labelOf(forkAfter) : parentId);
        const head = await this.deps.lanes.headSha(parent);
        return this.deps.lanes.createLane(run, planned, head);
      })(),
    );
  }

  /**
   * §9.3/§9.5: checkpoints the merge's own lane and returns the other lanes it merges, in canvas order of
   * its inputs, each checkpointed (labelled after its input node). Lanes reached only through skipped
   * edges (Phase 2 dead paths) are left out.
   */
  private async prepareMerge(live: LiveRun, node: GraphNode, lane: Lane): Promise<Lane[]> {
    const inputs = live.topo.incoming.get(node.id) ?? [];
    const inputLabel = (laneId: string): string => {
      const edge = inputs.find((e) => live.plan.edgeLane.get(e.id) === laneId);
      return labelOf(live.nodes.get(edge?.source ?? node.id)!);
    };
    await this.deps.lanes.checkpoint(lane, inputLabel(lane.id));
    const sourceIds = (live.plan.mergeSources.get(node.id) ?? []).filter((id) =>
      inputs.some((e) => live.plan.edgeLane.get(e.id) === id && live.tracker.isActivated(e.id)),
    );
    const sources: Lane[] = [];
    for (const id of sourceIds) {
      const source = await this.ensureLane(live, id);
      await this.deps.lanes.checkpoint(source, inputLabel(id));
      sources.push(source);
    }
    return sources;
  }

  private createLane(live: LiveRun, run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    return this.trackLane(live, planned.id, this.deps.lanes.createLane(run, planned, fromRef));
  }

  private trackLane(live: LiveRun, laneId: string, creation: Promise<Lane>): Promise<Lane> {
    const tracked = creation.then(
      (lane) => {
        if (live.graph.settings.workspaceSetup) live.needsSetup.add(lane.id);
        this.deps.store.appendEvent(live.runId, null, "lane.created", { laneId: lane.id, branch: lane.branch });
        return lane;
      },
      (err: unknown) => {
        live.laneCreation.delete(laneId);
        throw err;
      },
    );
    live.laneCreation.set(laneId, tracked);
    return tracked;
  }

  // ---------------------------------------------------------------------------
  // Persistence + events
  // ---------------------------------------------------------------------------

  /** ctx.update: runners may only set non-final statuses; status changes after the node settled are dropped. */
  private runnerUpdate(live: LiveRun, nodeRunId: string, patch: NodeRunPatch): NodeRun {
    if (patch.status === undefined) return this.patchNodeRun(nodeRunId, patch);
    if (!RUNNER_STATUSES.has(patch.status)) throw new Error(`Runners cannot set status "${patch.status}"`);
    const current = this.requireNodeRun(nodeRunId);
    if (isFinalNodeStatus(current.status) || live.terminating || this.shuttingDown) {
      const { status: _dropped, ...rest } = patch;
      return this.patchNodeRun(nodeRunId, rest);
    }
    return this.patchNodeRun(nodeRunId, patch);
  }

  /** The single write path for node runs: asserts transitions, persists, logs and emits. */
  private patchNodeRun(nodeRunId: string, patch: NodeRunPatch): NodeRun {
    const { store, bus } = this.deps;
    const before = this.requireNodeRun(nodeRunId);
    const statusChanged = patch.status !== undefined && patch.status !== before.status;
    if (statusChanged) assertTransition(before.status, patch.status!);
    // A waiting reason only describes waiting_input; leaving that status clears it.
    const leavesWaiting = statusChanged && patch.status !== "waiting_input" && patch.waitingReason === undefined && before.waitingReason;
    const after = store.updateNodeRun(nodeRunId, leavesWaiting ? { ...patch, waitingReason: null } : patch);
    if (statusChanged) {
      store.appendEvent(after.runId, after.id, "node.status", { status: after.status, from: before.status, error: after.error });
    }
    bus.emit("node:update", { nodeRun: after });
    if (statusChanged || patch.output !== undefined) this.emitRun(after.runId);
    if (statusChanged && (ATTENTION_NODE_STATUSES as readonly NodeStatus[]).includes(after.status)) this.emitAttention(after);
    return after;
  }

  private emitAttention(nodeRun: NodeRun): void {
    const run = this.requireRun(nodeRun.runId);
    const node = run.graphSnapshot.nodes.find((n) => n.id === nodeRun.nodeId);
    const kind = nodeRun.status as "idle" | "waiting_input" | "waiting_approval";
    const fallback = { idle: "Claude finished a turn", waiting_input: "Needs your input", waiting_approval: "Waiting for approval" }[kind];
    this.deps.bus.emit("attention", {
      kind,
      nodeRun,
      nodeLabel: node ? labelOf(node) : nodeRun.nodeId,
      graphName: run.graphName,
      message: nodeRun.waitingReason?.message ?? fallback,
    });
  }

  private setRunStatus(runId: string, status: RunStatus, extra: { error?: string | null; finishedAt?: number } = {}): void {
    const run = this.requireRun(runId);
    if (run.status !== status && !RUN_TRANSITIONS[run.status].includes(status)) {
      throw new Error(`Invalid run status transition ${run.status} → ${status}`);
    }
    this.deps.store.updateRun(runId, { status, ...extra });
    this.deps.store.appendEvent(runId, null, "run.status", { status, from: run.status, error: extra.error ?? null });
    this.emitRun(runId);
  }

  private resumeIfPaused(run: Run): void {
    if (this.requireRun(run.id).status === "paused") this.setRunStatus(run.id, "running", { error: null });
  }

  private emitRun(runId: string): void {
    const run = this.deps.store.getRunSummary(runId);
    if (run) this.deps.bus.emit("run:update", { run });
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  private currentNodeRuns(runId: string): Map<string, NodeRun> {
    return currentByNode(this.deps.store.listNodeRuns(runId));
  }

  /** Direct predecessors (forward edges), canvas order, with their current node runs. */
  private predecessorsOf(topo: Topology, runId: string, nodeId: string): PredecessorOutput[] {
    return this.outputsOf(topo, runId, [...new Set((topo.incoming.get(nodeId) ?? []).map((e) => e.source))]);
  }

  /**
   * §6.1: ancestors back to (excluding) the previous commit/merge node, in canvas order, that ran in
   * this iteration (succeeded or failed): the work a generated commit message describes.
   */
  private laneOutputsOf(live: LiveRun, nodeId: string): PredecessorOutput[] {
    const seen = new Set<string>();
    const stack = (live.topo.incoming.get(nodeId) ?? []).map((e) => e.source);
    while (stack.length > 0) {
      const id = stack.pop()!;
      const type = live.nodes.get(id)!.type;
      if (seen.has(id) || type === "commit" || type === "merge") continue;
      seen.add(id);
      for (const e of live.topo.incoming.get(id) ?? []) stack.push(e.source);
    }
    const ids = live.graph.nodes.map((n) => n.id).filter((id) => seen.has(id));
    return this.outputsOf(live.topo, live.runId, ids).filter((p) => p.status === "succeeded" || p.status === "failed");
  }

  private outputsOf(topo: Topology, runId: string, nodeIds: readonly string[]): PredecessorOutput[] {
    const current = this.currentNodeRuns(runId);
    return nodeIds.map((id) => {
      const node = topo.nodes.get(id)!;
      const nr = current.get(id);
      return {
        nodeId: id,
        label: labelOf(node),
        type: node.type,
        status: nr?.status ?? "pending",
        output: nr?.output ?? null,
        error: nr?.error ?? null,
        sessionId: nr?.sessionId ?? null,
        transcriptPath: nr?.transcriptPath ?? null,
        laneId: nr?.laneId ?? null,
      };
    });
  }

  /** Phase 2: a failure is "handled" when an outgoing edge matches it (§15.1); onError does not apply. */
  private hasFailureRoute(topo: Topology, nodeId: string): boolean {
    return (topo.outgoing.get(nodeId) ?? []).some((e) => edgeMatches(e, { kind: "failure" }));
  }

  private findExecution(nodeRunId: string): LiveExecution | undefined {
    for (const live of this.live.values()) {
      const exec = live.executions.get(nodeRunId);
      if (exec) return exec;
    }
    return undefined;
  }

  private requireControls(nodeRunId: string, action: string, payload: Record<string, unknown> = {}): NodeControls {
    const nr = this.requireNodeRun(nodeRunId);
    const controls = this.findExecution(nodeRunId)?.controls;
    if (!controls) throw new EngineError("invalid_state", `Node run ${nodeRunId} is not running (${nr.status})`);
    this.deps.store.appendEvent(nr.runId, nr.id, "node.action", { action, ...payload });
    return controls;
  }

  private requireCurrent(nr: NodeRun): void {
    if (this.currentNodeRuns(nr.runId).get(nr.nodeId)?.id !== nr.id) {
      throw new EngineError("invalid_state", "Only the latest attempt of a node can be changed");
    }
  }

  private requireNodeRun(id: string): NodeRun {
    const nr = this.deps.store.getNodeRun(id);
    if (!nr) throw new EngineError("not_found", `Node run ${id} not found`);
    return nr;
  }

  private requireRun(id: string): Run {
    const run = this.deps.store.getRun(id);
    if (!run) throw new EngineError("not_found", `Run ${id} not found`);
    return run;
  }

  private requireActiveRun(id: string): Run {
    const run = this.requireRun(id);
    if (isFinalRunStatus(run.status)) throw new EngineError("invalid_state", `Run ${id} is already ${run.status}`);
    return run;
  }
}

/** Approval-dialog text for commit/merge predecessors, which have no text output. */
function gitStepSummary(output: NodeRunOutput | null): string {
  if (output?.noop) return "Nothing to commit.";
  if (!output?.sha) return "";
  const sha = output.sha.slice(0, 8);
  if (output.message !== undefined) return `Commit ${sha}: ${output.message}`;
  const resolved = output.conflictedFiles?.length ? `, resolved conflicts in ${output.conflictedFiles.join(", ")}` : "";
  return `Merged at ${sha}${resolved}`;
}
