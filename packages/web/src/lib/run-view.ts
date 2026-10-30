import { edgeMatches, isActiveNodeStatus, type GraphEdge, type NodeOutcome, type NodeRun } from "@promptgraph/shared";

/** Latest (highest iteration, then attempt) node run per node id. */
export function currentNodeRuns(nodeRuns: readonly NodeRun[]): Record<string, NodeRun> {
  const out: Record<string, NodeRun> = {};
  for (const nr of nodeRuns) {
    const cur = out[nr.nodeId];
    if (!cur || nr.iteration > cur.iteration || (nr.iteration === cur.iteration && nr.attempt >= cur.attempt)) {
      out[nr.nodeId] = nr;
    }
  }
  return out;
}

/** Replaces the node run with the same id or appends it. */
export function upsertNodeRun(list: readonly NodeRun[], nodeRun: NodeRun): NodeRun[] {
  const i = list.findIndex((n) => n.id === nodeRun.id);
  if (i === -1) return [...list, nodeRun];
  const next = list.slice();
  next[i] = nodeRun;
  return next;
}

export type EdgeRunState = "idle" | "flowing" | "activated" | "dead";

/** Run-mode look of an edge: animated while its source runs, green once it delivered an activation (§8.2). */
export function edgeRunState(edge: GraphEdge, source: NodeRun | undefined): EdgeRunState {
  if (!source) return "idle";
  if (isActiveNodeStatus(source.status)) return "flowing";
  const outcome = outcomeOf(source);
  if (!outcome) return source.status === "skipped" ? "dead" : "idle";
  return edgeMatches(edge, outcome) ? "activated" : "dead";
}

function outcomeOf(nr: NodeRun): NodeOutcome | null {
  if (nr.status === "skipped" && nr.output?.skippedByUser) return { kind: "success" };
  if (nr.status === "succeeded") return nr.output?.port ? { kind: "success", port: nr.output.port } : { kind: "success" };
  if (nr.status === "failed") return { kind: "failure" };
  return null;
}
