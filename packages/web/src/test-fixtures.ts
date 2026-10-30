import { GraphSchema, emptyUsage, type Graph, type GraphInput, type Lane, type NodeRun, type RunDetail } from "@promptgraph/shared";

/** Shared builders for the web unit tests. */

export function graphOf(input: Partial<GraphInput> = {}): Graph {
  return GraphSchema.parse({ version: 1, id: "g1", name: "Graph 1", ...input });
}

export function linearGraph(): Graph {
  return graphOf({
    nodes: [
      { id: "a", type: "prompt", label: "Implement", position: { x: 0, y: 0 }, config: { prompt: "do it" } },
      { id: "b", type: "shell", label: "Test", position: { x: 300, y: 0 }, config: { run: "pnpm test" } },
    ],
    edges: [{ id: "e1", source: "a", target: "b" }],
  });
}

export function nodeRunOf(patch: Partial<NodeRun> & Pick<NodeRun, "id" | "nodeId">): NodeRun {
  return {
    runId: "r1",
    iteration: 0,
    attempt: 0,
    laneId: "main",
    status: "pending",
    sessionId: null,
    transcriptPath: null,
    ptyId: null,
    activity: null,
    waitingReason: null,
    hold: false,
    laneSetup: null,
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: 1,
    ...patch,
  };
}

export function runDetailOf(graph: Graph, nodeRuns: NodeRun[], id = "r1"): RunDetail {
  return {
    run: {
      id,
      repoPath: "/repo",
      graphId: graph.id,
      graphName: graph.name,
      status: "running",
      startedAt: 1000,
      finishedAt: null,
      graphHash: "h",
      shortId: "ab12",
      error: null,
      pendingApprovals: 0,
      waitingInput: 0,
      usage: emptyUsage(),
      cleanedUp: false,
      graphSnapshot: graph,
    },
    lanes: [],
    nodeRuns,
  };
}

/** a → (b, c) → merge m: b keeps lane "main", c forks "l2", m continues "main" and merges "l2". */
export function forkMergeGraph(): Graph {
  return graphOf({
    nodes: [
      { id: "a", type: "prompt", label: "Plan", position: { x: 0, y: 0 }, config: { prompt: "plan" } },
      { id: "b", type: "prompt", label: "Backend", position: { x: 300, y: 0 }, config: { prompt: "api" } },
      { id: "c", type: "prompt", label: "Frontend", position: { x: 300, y: 200 }, config: { prompt: "ui" } },
      { id: "m", type: "merge", label: "Join", position: { x: 600, y: 100 } },
    ],
    edges: [
      { id: "ab", source: "a", target: "b" },
      { id: "ac", source: "a", target: "c" },
      { id: "cm", source: "c", target: "m" },
      { id: "bm", source: "b", target: "m" },
    ],
  });
}

export function laneOf(patch: Partial<Lane> & Pick<Lane, "id" | "index">): Lane {
  return { runId: "r1", branch: `pg/g1/ab12/${patch.id}`, worktreePath: `/w/${patch.id}`, baseRef: "base", status: "active", pushed: false, ...patch };
}

/** §15.5 test-fix loop: impl → test → cond(exitCode); cond.true → commit; cond.false → fix; fix ⟲ test (loop, max 3). */
export function testFixLoopGraph(): Graph {
  return graphOf({
    nodes: [
      { id: "impl", type: "prompt", label: "Implement", position: { x: 0, y: 0 }, config: { prompt: "do it" } },
      { id: "test", type: "shell", label: "Test", position: { x: 300, y: 0 }, config: { run: "pnpm test" } },
      { id: "cond", type: "condition", label: "Green?", position: { x: 600, y: 0 }, config: { evaluator: { kind: "exitCode", equals: 0 } } },
      { id: "commit", type: "commit", label: "Commit", position: { x: 900, y: 0 } },
      { id: "fix", type: "prompt", label: "Fix", position: { x: 900, y: 200 }, config: { prompt: "fix the tests" } },
    ],
    edges: [
      { id: "e1", source: "impl", target: "test" },
      { id: "e2", source: "test", target: "cond" },
      { id: "e3", source: "cond", sourcePort: "true", target: "commit" },
      { id: "e4", source: "cond", sourcePort: "false", target: "fix" },
      { id: "loop", source: "fix", target: "test", loop: { maxIterations: 3, onExhausted: "fail" } },
    ],
  });
}
