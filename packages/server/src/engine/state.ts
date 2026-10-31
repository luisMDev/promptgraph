import type { NodeStatus, RunStatus } from "@promptgraph/shared";

/** Allowed node status transitions (§8.2). Retry creates a NEW node run (attempt+1) instead of leaving a final state. */
export const NODE_TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "pending", "skipped", "cancelled"], // → pending only by crash recovery
  running: ["idle", "waiting_input", "waiting_approval", "succeeded", "failed", "cancelled", "interrupted"],
  idle: ["running", "waiting_input", "succeeded", "failed", "cancelled", "interrupted"],
  waiting_input: ["running", "idle", "succeeded", "failed", "cancelled", "interrupted"],
  waiting_approval: ["running", "succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: ["skipped"], // "skip" on a failed node treats it as success for downstream (§8.3)
  skipped: [],
  cancelled: [],
  interrupted: ["skipped"],
};

export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return from === to || NODE_TRANSITIONS[from].includes(to);
}

/** @throws Error naming both states when the transition is not allowed. */
export function assertTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid node status transition ${from} → ${to}`);
}

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  running: ["succeeded", "failed", "paused", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
