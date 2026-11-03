import {
  ATTENTION_NODE_STATUSES,
  nodeDisplayLabel,
  type ChangeStats,
  type DiffResponse,
  type Lane,
  type NodeRun,
  type NodeStatus,
  type ReportLane,
  type ReportNode,
  type ReportStall,
  type Run,
  type RunEvent,
  type RunReportResponse,
} from "@promptgraph/shared";
import type { Store } from "../store/store.js";
import type { LaneManager } from "../workspace/lane-manager.js";

/** Waits at least this long are reported as where the run lost time. */
export const SLOW_WAIT_MS = 60_000;

const ATTENTION: ReadonlySet<NodeStatus> = new Set(ATTENTION_NODE_STATUSES);
const WAITING_FALLBACK: Partial<Record<NodeStatus, string>> = {
  idle: "Claude finished a turn and is waiting for you",
  waiting_input: "Needs your input",
  waiting_approval: "Waiting for approval",
};

export interface ReportDeps {
  store: Store;
  lanes: LaneManager;
  now: () => number;
}

/**
 * Run report (§13.1): per (node, iteration) result, per lane changes and commits, PR links, cost,
 * duration, and where the run stopped or waited. Works on finished runs after cleanup (snapshots).
 */
export async function buildRunReport(deps: ReportDeps, run: Run): Promise<RunReportResponse> {
  const { store, lanes, now } = deps;
  const graph = run.graphSnapshot;
  const nodeRuns = store.listNodeRuns(run.id);
  const waits = waitingTimes(store.listEvents(run.id), now());

  const groups = new Map<string, NodeRun[]>();
  for (const nr of nodeRuns) {
    const key = `${nr.nodeId}\0${nr.iteration}`;
    groups.set(key, [...(groups.get(key) ?? []), nr]);
  }
  const canvasOrder = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const nodes: ReportNode[] = [];
  for (const attempts of groups.values()) {
    const nr = attempts.at(-1)!;
    const node = graph.nodes.find((n) => n.id === nr.nodeId);
    if (!node) continue;
    const end = nr.finishedAt ?? (nr.startedAt !== null ? now() : null);
    nodes.push({
      nodeRun: nr,
      label: nr.iteration > 0 ? `${nodeDisplayLabel(node)} #${nr.iteration + 1}` : nodeDisplayLabel(node),
      type: node.type,
      attempts: attempts.length,
      durationMs: nr.startedAt !== null && end !== null ? end - nr.startedAt : null,
      waitingMs: attempts.reduce((sum, a) => sum + (waits.get(a.id) ?? 0), 0),
      changes: await nodeChanges(lanes, nr),
    });
  }
  nodes.sort(
    (a, b) =>
      (a.nodeRun.startedAt ?? Infinity) - (b.nodeRun.startedAt ?? Infinity) ||
      (canvasOrder.get(a.nodeRun.nodeId) ?? 0) - (canvasOrder.get(b.nodeRun.nodeId) ?? 0) ||
      a.nodeRun.iteration - b.nodeRun.iteration,
  );

  const reportLanes: ReportLane[] = [];
  for (const lane of store.listLanes(run.id)) {
    reportLanes.push(await laneSummary(lanes, lane, graph.settings.baseBranch, lastSnapshot(nodeRuns, lane.id)));
  }

  const prs = nodes.flatMap((n) => (n.nodeRun.output?.prUrl ? [{ url: n.nodeRun.output.prUrl, nodeRunId: n.nodeRun.id, label: n.label }] : []));
  const { graphSnapshot: _snapshot, ...summary } = run;
  return {
    run: summary,
    durationMs: (run.finishedAt ?? now()) - run.startedAt,
    nodes,
    lanes: reportLanes,
    prs,
    stalls: stallsOf(nodes),
  };
}

/** Lane diff for the report: the live worktree, or (after cleanup) its base → last snapshot. */
export async function laneDiff(deps: ReportDeps, run: Run, lane: Lane): Promise<DiffResponse> {
  const baseBranch = run.graphSnapshot.settings.baseBranch;
  if (deps.lanes.hasWorktree(lane)) return deps.lanes.diff(lane, baseBranch);
  const summary = await deps.lanes.summarize(lane, baseBranch, lastSnapshot(deps.store.listNodeRuns(run.id), lane.id));
  if (!summary.head) return { base: summary.base, head: summary.base, files: [], patch: "", truncated: false };
  return deps.lanes.diffCommits(summary.base, summary.head);
}

/** The latest end snapshot of a node run in the lane (by finish time). */
function lastSnapshot(nodeRuns: readonly NodeRun[], laneId: string): string | null {
  let best: NodeRun | null = null;
  for (const nr of nodeRuns) {
    if (nr.laneId !== laneId || !nr.snapshotEnd) continue;
    if (!best || (nr.finishedAt ?? 0) >= (best.finishedAt ?? 0)) best = nr;
  }
  return best?.snapshotEnd ?? null;
}

async function nodeChanges(lanes: LaneManager, nr: NodeRun): Promise<ChangeStats | null> {
  if (!nr.snapshotStart || !nr.snapshotEnd) return null;
  try {
    return await lanes.changeStats(nr.snapshotStart, nr.snapshotEnd);
  } catch {
    return null; // snapshot refs pruned
  }
}

async function laneSummary(lanes: LaneManager, lane: Lane, baseBranch: string, snapshot: string | null): Promise<ReportLane> {
  try {
    return await lanes.summarize(lane, baseBranch, snapshot);
  } catch {
    return { lane, base: lane.baseRef, head: null, changes: { files: 0, additions: 0, deletions: 0 }, commits: [] };
  }
}

/** Per node run: ms spent in idle / waiting_input / waiting_approval, from the node.status events. */
export function waitingTimes(events: readonly RunEvent[], now: number): Map<string, number> {
  const open = new Map<string, number>();
  const total = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "node.status" || !e.nodeRunId) continue;
    const status = (e.payload as { status?: NodeStatus } | null)?.status;
    const since = open.get(e.nodeRunId);
    if (since !== undefined) {
      total.set(e.nodeRunId, (total.get(e.nodeRunId) ?? 0) + e.at - since);
      open.delete(e.nodeRunId);
    }
    if (status && ATTENTION.has(status)) open.set(e.nodeRunId, e.at);
  }
  for (const [id, since] of open) total.set(id, (total.get(id) ?? 0) + now - since);
  return total;
}

/** Unhandled failures, interruptions, cancellations and nodes waiting now first; then long waits, longest first. */
function stallsOf(nodes: readonly ReportNode[]): ReportStall[] {
  const blocking: ReportStall[] = [];
  const slow: ReportStall[] = [];
  for (const { nodeRun: nr, label, waitingMs } of nodes) {
    const base = { nodeRunId: nr.id, label, waitingMs };
    if (nr.status === "failed" && !nr.output?.failureHandled) blocking.push({ ...base, kind: "failed", message: nr.error ?? "Failed" });
    else if (nr.status === "interrupted") blocking.push({ ...base, kind: "interrupted", message: nr.error ?? "Interrupted" });
    else if (nr.status === "cancelled") blocking.push({ ...base, kind: "cancelled", message: nr.error ?? "Cancelled" });
    else if (ATTENTION.has(nr.status)) blocking.push({ ...base, kind: "waiting", message: nr.waitingReason?.message ?? WAITING_FALLBACK[nr.status] ?? "Waiting" });
    else if (waitingMs >= SLOW_WAIT_MS) slow.push({ ...base, kind: "slow_wait", message: "Waited for you" });
  }
  return [...blocking, ...slow.sort((a, b) => b.waitingMs - a.waitingMs)];
}
