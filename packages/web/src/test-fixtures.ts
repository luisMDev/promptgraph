import { GraphSchema, emptyUsage, type Graph, type GraphInput, type NodeRun, type RunDetail } from "@promptgraph/shared";

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
