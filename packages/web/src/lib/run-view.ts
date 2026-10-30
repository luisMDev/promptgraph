import { edgeMatches, isActiveNodeStatus, type GraphEdge, type GraphNode, type Lane, type NodeOutcome, type NodeRun, type RunDetail } from "@promptgraph/shared";

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

export type NoteTone = "amber" | "violet" | "green" | "red" | "blue";

/** Type-specific state line on a run-mode node card (merge conflicts, approval gates). */
export function cardNote(node: Pick<GraphNode, "type">, nodeRun: NodeRun | null): { text: string; tone: NoteTone } | null {
  if (!nodeRun) return null;
  const o = nodeRun.output;
  const conflicts = o?.conflictedFiles?.length ?? 0;
  const files = (n: number) => `${n} conflicted file${n === 1 ? "" : "s"}`;
  if (node.type === "merge") {
    if (nodeRun.status === "waiting_input" && nodeRun.waitingReason?.kind === "merge_conflict") {
      return { text: "Conflicts: resolve them in the merge shell, then Done", tone: "amber" };
    }
    if (conflicts && isActiveNodeStatus(nodeRun.status)) return { text: `Resolving ${files(conflicts)}`, tone: "blue" };
    if (conflicts && nodeRun.status === "succeeded") return { text: `Resolved ${files(conflicts)}`, tone: "green" };
    return null;
  }
  if (node.type !== "approval" && node.type !== "pr") return null;
  if (nodeRun.status === "waiting_approval") return { text: "Click to review and approve", tone: "violet" };
  if (o?.approved === false) return { text: o.comment ? `Rejected: ${o.comment}` : "Rejected", tone: "red" };
  if (o?.approved && node.type === "approval") return { text: o.comment ? `Approved: ${o.comment}` : "Approved", tone: "green" };
  return null;
}

/** The node run just paused on a merge conflict with a shell to resolve it in (the drawer opens it). */
export function enteredMergeConflict(prev: NodeRun | undefined, next: NodeRun): boolean {
  const isPaused = (nr: NodeRun | undefined) => nr?.status === "waiting_input" && nr.waitingReason?.kind === "merge_conflict";
  return isPaused(next) && !!next.ptyId && !(isPaused(prev) && prev?.ptyId === next.ptyId);
}

/** What a run-history row shows when expanded: its lanes (branch, state, pushed) and the PRs it opened. */
export interface RunInfo {
  lanes: Lane[];
  prs: { nodeId: string; label: string; url: string }[];
}

export function runInfoOf(detail: RunDetail): RunInfo {
  const label = new Map(detail.run.graphSnapshot.nodes.map((n) => [n.id, n.label || n.type] as const));
  const prs = Object.values(currentNodeRuns(detail.nodeRuns)).flatMap((nr) =>
    nr.output?.prUrl ? [{ nodeId: nr.nodeId, label: label.get(nr.nodeId) ?? nr.nodeId, url: nr.output.prUrl }] : [],
  );
  return { lanes: [...detail.lanes].sort((a, b) => a.index - b.index), prs };
}
