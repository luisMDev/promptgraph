import {
  edgeMatches,
  isActiveNodeStatus,
  isFinalNodeStatus,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Lane,
  type LoopState,
  type NodeOutcome,
  type NodeRun,
  type RunDetail,
  nodeDisplayLabel,
} from "@promptgraph/shared";

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

/**
 * Run-mode look of an edge: animated while its source runs, green once it delivered an activation, greyed when
 * it delivered a skip (dead path, §8.2/§15.3). An exhausted loop back-edge delivers a skip even when it matches.
 */
export function edgeRunState(edge: GraphEdge, source: NodeRun | undefined, loop?: Pick<LoopView, "exhausted">): EdgeRunState {
  if (!source) return "idle";
  if (isActiveNodeStatus(source.status)) return "flowing";
  const outcome = outcomeOf(source);
  if (!outcome) return source.status === "skipped" ? "dead" : "idle";
  if (!edgeMatches(edge, outcome)) return "dead";
  if (edge.loop && loop?.exhausted) return "dead";
  return "activated";
}

function outcomeOf(nr: NodeRun): NodeOutcome | null {
  if (nr.status === "skipped" && nr.output?.skippedByUser) return { kind: "success" };
  if (nr.status === "succeeded") return nr.output?.port ? { kind: "success", port: nr.output.port } : { kind: "success" };
  if (nr.status === "failed") return { kind: "failure" };
  return null;
}

// ---------------------------------------------------------------------------
// Loops and iterations (§15.4)
// ---------------------------------------------------------------------------

/** What the canvas shows for a loop back-edge: times looped back (in the current pass) / maximum. */
export interface LoopView {
  iteration: number;
  maxIterations: number;
  exhausted: boolean;
}

/**
 * Loop state per loop back-edge of the snapshot. The server's `RunDetail.loops` wins; for edges it does not
 * list, the count is derived from the highest iteration of the loop target's node runs (exact for a single
 * loop; an enclosing loop also advances it) and `exhausted` is unknown (false).
 */
export function loopViews(graph: Pick<Graph, "edges">, nodeRuns: readonly NodeRun[], server?: readonly LoopState[]): Record<string, LoopView> {
  const maxIteration = new Map<string, number>();
  for (const nr of nodeRuns) maxIteration.set(nr.nodeId, Math.max(maxIteration.get(nr.nodeId) ?? 0, nr.iteration));
  const known = new Map((server ?? []).map((l) => [l.edgeId, l] as const));
  const out: Record<string, LoopView> = {};
  for (const e of graph.edges) {
    if (!e.loop) continue;
    const s = known.get(e.id);
    out[e.id] = s
      ? { iteration: s.iteration, maxIterations: s.maxIterations, exhausted: s.exhausted }
      : { iteration: Math.min(maxIteration.get(e.target) ?? 0, e.loop.maxIterations), maxIterations: e.loop.maxIterations, exhausted: false };
  }
  return out;
}

/** Iteration badge of a loop edge during runs, e.g. "2/3". */
export function loopBadge(loop: LoopView): string {
  return `${loop.iteration}/${loop.maxIterations}`;
}

/**
 * Whether a node update means the server-side loop state may have changed: a node run of a new iteration
 * (a loop edge looped back), or a loop edge's source settling (it may have exhausted its loop).
 */
export function affectsLoops(graph: Pick<Graph, "edges">, prev: readonly NodeRun[], next: NodeRun): boolean {
  const loopEdges = graph.edges.filter((e) => e.loop);
  if (loopEdges.length === 0) return false;
  const newIteration = next.iteration > 0 && !prev.some((n) => n.nodeId === next.nodeId && n.iteration === next.iteration);
  if (newIteration) return true;
  const before = prev.find((n) => n.id === next.id);
  const settled = isFinalNodeStatus(next.status) && before?.status !== next.status;
  return settled && loopEdges.some((e) => e.source === next.nodeId);
}

/** One entry per iteration of a node: its latest attempt, plus how many attempts it took. Ascending. */
export interface IterationEntry {
  iteration: number;
  nodeRun: NodeRun;
  attempts: number;
}

export function nodeIterations(nodeRuns: readonly NodeRun[], nodeId: string): IterationEntry[] {
  const byIteration = new Map<number, IterationEntry>();
  for (const nr of nodeRuns) {
    if (nr.nodeId !== nodeId) continue;
    const cur = byIteration.get(nr.iteration);
    if (!cur) byIteration.set(nr.iteration, { iteration: nr.iteration, nodeRun: nr, attempts: 1 });
    else byIteration.set(nr.iteration, { iteration: nr.iteration, nodeRun: nr.attempt >= cur.nodeRun.attempt ? nr : cur.nodeRun, attempts: cur.attempts + 1 });
  }
  return [...byIteration.values()].sort((a, b) => a.iteration - b.iteration);
}

/**
 * The iteration the inspector shows: the selected one when it exists, else the latest (null when the node
 * has no node run yet).
 */
export function selectIterationEntry(entries: readonly IterationEntry[], selected: number | null): IterationEntry | null {
  if (entries.length === 0) return null;
  if (selected !== null) {
    const hit = entries.find((e) => e.iteration === selected);
    if (hit) return hit;
  }
  return entries[entries.length - 1]!;
}

export type NoteTone = "amber" | "violet" | "green" | "red" | "blue" | "zinc";

/** Type-specific state line on a run-mode node card (merge conflicts, approval gates). */
export function cardNote(node: Pick<GraphNode, "type">, nodeRun: NodeRun | null): { text: string; tone: NoteTone } | null {
  if (!nodeRun) return null;
  const o = nodeRun.output;
  if (nodeRun.status === "failed" && o?.failureHandled) return { text: "Handled: its failure path ran instead", tone: "zinc" };
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
  if (node.type === "condition") {
    if (!o?.port) return null;
    const reason = o.text?.trim();
    return { text: reason ? `${o.port} — ${reason}` : `Result: ${o.port}`, tone: o.port === "true" ? "green" : "zinc" };
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
  const label = new Map(detail.run.graphSnapshot.nodes.map((n) => [n.id, nodeDisplayLabel(n)] as const));
  const prs = Object.values(currentNodeRuns(detail.nodeRuns)).flatMap((nr) =>
    nr.output?.prUrl ? [{ nodeId: nr.nodeId, label: label.get(nr.nodeId) ?? nr.nodeId, url: nr.output.prUrl }] : [],
  );
  return { lanes: [...detail.lanes].sort((a, b) => a.index - b.index), prs };
}
