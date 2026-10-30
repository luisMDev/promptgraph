import {
  emptyUsage,
  GraphSchema,
  type GraphInput,
  type GraphNode,
  type Lane,
  type NodeRun,
  type Run,
} from "@promptgraph/shared";
import type { RunnerContext, PredecessorOutput } from "../../src/runners/types.js";
import type { NodeRunPatch } from "../../src/store/store.js";

export function makeRun(graph: Partial<GraphInput> & { nodes: GraphInput["nodes"] }, repoPath = "/repo"): Run {
  const snapshot = GraphSchema.parse({ version: 1, id: "g1", name: "Graph 1", ...graph });
  return {
    id: "run1",
    repoPath,
    graphId: snapshot.id,
    graphName: snapshot.name,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    graphHash: "hash",
    shortId: "abcd",
    error: null,
    pendingApprovals: 0,
    waitingInput: 0,
    usage: emptyUsage(),
    cleanedUp: false,
    graphSnapshot: snapshot,
  };
}

export function makeNodeRun(id: string, nodeId: string, patch: Partial<NodeRun> = {}): NodeRun {
  return {
    id,
    runId: "run1",
    nodeId,
    iteration: 0,
    attempt: 0,
    laneId: "main",
    status: "running",
    sessionId: null,
    transcriptPath: null,
    ptyId: null,
    activity: null,
    waitingReason: null,
    hold: false,
    laneSetup: null,
    output: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    updatedAt: Date.now(),
    ...patch,
  };
}

export function makeLane(worktreePath: string, baseRef = "HEAD"): Lane {
  return { id: "main", runId: "run1", branch: "pg/g1/abcd/main", worktreePath, baseRef, status: "active", index: 0, pushed: false };
}

export interface TestContext extends RunnerContext {
  /** Every patch applied, in order. */
  patches: NodeRunPatch[];
  events: Array<{ type: string; payload: unknown }>;
  /** Live node run state after patches. */
  current: NodeRun;
  abort: AbortController;
}

/** RunnerContext whose update() merges patches into `current` like the engine would. */
export function makeCtx(opts: {
  run: Run;
  node: GraphNode;
  lane: Lane;
  nodeRunId?: string;
  predecessors?: PredecessorOutput[];
  laneOutputs?: PredecessorOutput[];
  previousAttempt?: NodeRun | null;
  mergeSources?: Lane[];
  baseBranch?: string;
}): TestContext {
  const abort = new AbortController();
  const ctx: TestContext = {
    run: opts.run,
    node: opts.node,
    nodeRun: makeNodeRun(opts.nodeRunId ?? `nr-${opts.node.id}`, opts.node.id),
    lane: opts.lane,
    predecessors: opts.predecessors ?? [],
    laneOutputs: opts.laneOutputs ?? opts.predecessors ?? [],
    previousAttempt: opts.previousAttempt ?? null,
    mergeSources: opts.mergeSources ?? [],
    baseBranch: opts.baseBranch ?? opts.run.graphSnapshot.settings.baseBranch,
    claudeSlot: async () => {},
    signal: abort.signal,
    abort,
    patches: [],
    events: [],
    current: undefined as unknown as NodeRun,
    update(patch) {
      ctx.patches.push(patch);
      ctx.current = { ...ctx.current, ...patch, updatedAt: Date.now() };
      return ctx.current;
    },
    event(type, payload) {
      ctx.events.push({ type, payload });
    },
  };
  ctx.current = ctx.nodeRun;
  return ctx;
}
