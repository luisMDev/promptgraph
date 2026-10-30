import type { NodeRun, NodeStatus, RunStatus } from "@promptgraph/shared";

export interface StatusStyle {
  label: string;
  /** Card border + background classes (§8.2 colours). */
  card: string;
  /** Small dot / pill background. */
  dot: string;
  text: string;
}

/** Literal class names so Tailwind picks them up. */
export const NODE_STATUS_STYLE: Record<NodeStatus, StatusStyle> = {
  pending: { label: "Pending", card: "border-status-pending/60 bg-zinc-900", dot: "bg-status-pending", text: "text-zinc-400" },
  ready: { label: "Queued", card: "border-status-ready bg-zinc-800", dot: "bg-status-ready", text: "text-zinc-300" },
  running: { label: "Running", card: "pg-running border-status-running bg-blue-950/60", dot: "bg-status-running", text: "text-blue-300" },
  idle: { label: "Idle — awaiting Done", card: "border-status-idle bg-sky-950/50", dot: "bg-status-idle", text: "text-sky-300" },
  waiting_input: {
    label: "Waiting for input",
    card: "pg-pulse-amber border-status-waiting-input bg-amber-950/50",
    dot: "bg-status-waiting-input",
    text: "text-amber-300",
  },
  waiting_approval: {
    label: "Waiting for approval",
    card: "border-status-waiting-approval bg-violet-950/50",
    dot: "bg-status-waiting-approval",
    text: "text-violet-300",
  },
  succeeded: { label: "Succeeded", card: "border-status-succeeded bg-green-950/40", dot: "bg-status-succeeded", text: "text-green-300" },
  failed: { label: "Failed", card: "border-status-failed bg-red-950/50", dot: "bg-status-failed", text: "text-red-300" },
  skipped: { label: "Skipped", card: "border-dashed border-status-skipped/50 bg-zinc-900 opacity-50", dot: "bg-status-skipped", text: "text-zinc-400" },
  cancelled: { label: "Cancelled", card: "border-status-cancelled bg-zinc-800/80", dot: "bg-status-cancelled", text: "text-zinc-400" },
  interrupted: { label: "Interrupted", card: "border-status-interrupted bg-zinc-800/80", dot: "bg-status-interrupted", text: "text-zinc-400" },
};

/** A node the user skipped counts as success downstream: it is not drawn like a dead path. */
const USER_SKIPPED_STYLE: StatusStyle = {
  label: "Skipped by you",
  card: "border-status-skipped bg-zinc-900",
  dot: "bg-status-skipped",
  text: "text-zinc-300",
};

/** Style of a node run (status, or "skipped by you" for user skips). */
export function nodeRunStyle(nodeRun: Pick<NodeRun, "status" | "output"> | null): StatusStyle {
  if (nodeRun?.status === "skipped" && nodeRun.output?.skippedByUser) return USER_SKIPPED_STYLE;
  return NODE_STATUS_STYLE[nodeRun?.status ?? "pending"];
}

export const RUN_STATUS_STYLE: Record<RunStatus, { label: string; dot: string; text: string }> = {
  running: { label: "Running", dot: "bg-status-running", text: "text-blue-300" },
  paused: { label: "Paused", dot: "bg-status-waiting-input", text: "text-amber-300" },
  succeeded: { label: "Succeeded", dot: "bg-status-succeeded", text: "text-green-300" },
  failed: { label: "Failed", dot: "bg-status-failed", text: "text-red-300" },
  cancelled: { label: "Cancelled", dot: "bg-status-cancelled", text: "text-zinc-400" },
};

/** Lane colours by Lane.index, so parallel worktrees are distinguishable at a glance. */
const LANE_COLORS = [
  "bg-cyan-500/20 text-cyan-300 ring-cyan-500/40",
  "bg-fuchsia-500/20 text-fuchsia-300 ring-fuchsia-500/40",
  "bg-lime-500/20 text-lime-300 ring-lime-500/40",
  "bg-orange-500/20 text-orange-300 ring-orange-500/40",
  "bg-teal-500/20 text-teal-300 ring-teal-500/40",
  "bg-pink-500/20 text-pink-300 ring-pink-500/40",
  "bg-indigo-500/20 text-indigo-300 ring-indigo-500/40",
  "bg-yellow-500/20 text-yellow-300 ring-yellow-500/40",
] as const;

export function laneColor(index: number): string {
  return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]!;
}
