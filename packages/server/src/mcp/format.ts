import {
  ATTENTION_NODE_STATUSES,
  compareCanvasOrder,
  isFinalRunStatus,
  nodeDisplayLabel,
  type DiffResponse,
  type GraphNode,
  type NodeRun,
  type NodeRunOutput,
  type NodeStatus,
  type RunDetail,
  type RunReportResponse,
  type RunSummary,
} from "@promptgraph/shared";
import { truncate } from "../util/text.js";

/**
 * Compact, model-friendly views of API responses (§19.3). Full responses carry snapshots, every
 * attempt and long outputs; tools return these instead and offer get_node_output for the rest.
 */

const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);
const seconds = (ms: number | null | undefined): number | null => (ms === null || ms === undefined ? null : Math.round(ms / 100) / 10);
const round = (usd: number): number => Math.round(usd * 10_000) / 10_000;

function compactOutput(output: NodeRunOutput | null, textLimit: number): Record<string, unknown> | null {
  if (!output) return null;
  const { text, stdoutTail, usage, body, ...rest } = output;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
  if (text !== undefined) out.text = truncate(text, textLimit);
  if (stdoutTail !== undefined) out.stdoutTail = stdoutTail.length > textLimit ? `…${stdoutTail.slice(-textLimit)}` : stdoutTail;
  if (body !== undefined) out.body = truncate(body, textLimit);
  if (usage) out.costUsd = round(usage.costUsd);
  return Object.keys(out).length ? out : null;
}

export function compactNodeRun(nr: NodeRun, node: GraphNode | undefined, textLimit = 600): Record<string, unknown> {
  const view: Record<string, unknown> = {
    nodeRunId: nr.id,
    nodeId: nr.nodeId,
    label: node ? nodeDisplayLabel(node) : nr.nodeId,
    type: node?.type ?? null,
    status: nr.status,
  };
  if (nr.iteration > 0) view.iteration = nr.iteration;
  if (nr.attempt > 0) view.attempt = nr.attempt;
  if (nr.laneId) view.lane = nr.laneId;
  if (nr.activity) view.activity = nr.activity;
  if (nr.waitingReason) view.waiting = nr.waitingReason.message;
  if (nr.hold) view.hold = true;
  if (nr.graceUntil) view.autoContinuesAt = iso(nr.graceUntil);
  if (nr.error) view.error = truncate(nr.error, textLimit);
  if (nr.startedAt) view.durationSec = seconds((nr.finishedAt ?? Date.now()) - nr.startedAt);
  const output = compactOutput(nr.output, textLimit);
  if (output) view.output = output;
  return view;
}

/** Latest attempt per (node, iteration), in execution order (never-started nodes last, canvas order). */
export function latestAttempts(detail: RunDetail): NodeRun[] {
  const latest = new Map<string, NodeRun>();
  for (const nr of detail.nodeRuns) {
    const key = `${nr.nodeId}#${nr.iteration}`;
    const prev = latest.get(key);
    if (!prev || nr.attempt > prev.attempt) latest.set(key, nr);
  }
  const nodes = new Map(detail.run.graphSnapshot.nodes.map((n) => [n.id, n]));
  return [...latest.values()].sort((a, b) => {
    if (a.startedAt !== null && b.startedAt !== null) return a.startedAt - b.startedAt || a.iteration - b.iteration;
    if (a.startedAt !== null) return -1;
    if (b.startedAt !== null) return 1;
    const na = nodes.get(a.nodeId);
    const nb = nodes.get(b.nodeId);
    return na && nb ? compareCanvasOrder(na, nb) : a.nodeId.localeCompare(b.nodeId);
  });
}

export function needsAttention(status: NodeStatus): boolean {
  return (ATTENTION_NODE_STATUSES as readonly NodeStatus[]).includes(status);
}

export function compactRunSummary(run: RunSummary): Record<string, unknown> {
  return {
    runId: run.id,
    graphId: run.graphId,
    graphName: run.graphName,
    status: run.status,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    durationSec: seconds((run.finishedAt ?? Date.now()) - run.startedAt),
    error: run.error,
    pendingApprovals: run.pendingApprovals,
    waitingInput: run.waitingInput,
    costUsd: round(run.usage.costUsd),
    cleanedUp: run.cleanedUp,
  };
}

/** What a run looks like now, plus a one-line hint of what to do next. */
export function compactRunDetail(detail: RunDetail, textLimit = 600): Record<string, unknown> {
  const nodes = new Map(detail.run.graphSnapshot.nodes.map((n) => [n.id, n]));
  const steps = latestAttempts(detail);
  return {
    ...compactRunSummary(detail.run),
    next: nextHint(detail.run, steps),
    /** nodeRunIds of the steps (below) that need the user. */
    attention: steps.filter((s) => needsAttention(s.status)).map((s) => s.id),
    steps: steps.map((s) => compactNodeRun(s, nodes.get(s.nodeId), textLimit)),
    lanes: detail.lanes.map((l) => ({ id: l.id, branch: l.branch, status: l.status, worktreePath: l.worktreePath, pushed: l.pushed })),
    ...(detail.loops?.length ? { loops: detail.loops } : {}),
  };
}

function nextHint(run: RunSummary, steps: NodeRun[]): string {
  const any = (status: NodeStatus) => steps.some((s) => s.status === status);
  if (any("waiting_approval")) return "A step waits for approval: the user approves or rejects it in the promptgraph UI (open_ui). Use get_approval to summarise what is being approved.";
  if (any("waiting_input")) return "A Claude step waits for input in its terminal (permission prompt, trust dialog or question): the user answers it in the promptgraph UI, or mark it done/failed with node_action.";
  if (any("idle")) return "A Claude step finished its turn and waits (manual completion or Hold): review its output with get_node_output, then node_action done (or fail).";
  if (run.status === "paused") {
    const stuck = steps.filter((s) => s.status === "failed" || s.status === "interrupted");
    return stuck.length
      ? `The run is paused on ${stuck.map((s) => s.nodeId).join(", ")}: inspect with get_node_output, then node_action retry or skip, or cancel_run.`
      : "The run is paused: resume_run continues it.";
  }
  if (run.status === "running") return "Running: call wait_for_run to block until it finishes or needs attention.";
  if (isFinalRunStatus(run.status)) return "Finished: get_run_report summarises results, changes and pull requests.";
  return "";
}

export function compactReport(report: RunReportResponse, textLimit = 400): Record<string, unknown> {
  return {
    ...compactRunSummary(report.run),
    durationSec: seconds(report.durationMs),
    stalls: report.stalls.map((s) => ({ ...s, waitingSec: seconds(s.waitingMs), waitingMs: undefined })),
    steps: report.nodes.map((n) => ({
      nodeRunId: n.nodeRun.id,
      nodeId: n.nodeRun.nodeId,
      label: n.label,
      type: n.type,
      status: n.nodeRun.status,
      ...(n.nodeRun.iteration > 0 ? { iteration: n.nodeRun.iteration } : {}),
      attempts: n.attempts,
      durationSec: seconds(n.durationMs),
      waitedSec: seconds(n.waitingMs),
      changes: n.changes,
      output: compactOutput(n.nodeRun.output, textLimit),
      ...(n.nodeRun.error ? { error: truncate(n.nodeRun.error, textLimit) } : {}),
    })),
    pullRequests: report.prs,
    lanes: report.lanes.map((l) => ({
      id: l.lane.id,
      branch: l.lane.branch,
      status: l.lane.status,
      changes: l.changes,
      commits: l.commits.map((c) => `${c.sha.slice(0, 10)} ${c.subject}${c.checkpoint ? " (checkpoint)" : ""}`),
    })),
  };
}

export function compactDiff(diff: DiffResponse, maxPatchChars: number): Record<string, unknown> {
  return {
    base: diff.base,
    head: diff.head,
    files: diff.files.map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} → ` : ""}${f.path} (+${f.additions} −${f.deletions}${f.binary ? ", binary" : ""})`),
    patch: truncate(diff.patch, maxPatchChars),
    truncated: diff.truncated || diff.patch.length > maxPatchChars,
  };
}
