import { z } from "zod";

/** §8.2. "ready" doubles as "queued" (waiting for a scheduler slot). */
export const NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "idle",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/** A process or gate is live for the node; manual controls (done/fail/hold) apply. */
export const ACTIVE_NODE_STATUSES = ["running", "idle", "waiting_input", "waiting_approval"] as const satisfies readonly NodeStatus[];
/** No further transitions without retry. */
export const FINAL_NODE_STATUSES = ["succeeded", "failed", "skipped", "cancelled", "interrupted"] as const satisfies readonly NodeStatus[];
/** Statuses that count as "the node needs the user" (header counter, notifications). */
export const ATTENTION_NODE_STATUSES = ["idle", "waiting_input", "waiting_approval"] as const satisfies readonly NodeStatus[];

export function isActiveNodeStatus(s: NodeStatus): boolean {
  return (ACTIVE_NODE_STATUSES as readonly NodeStatus[]).includes(s);
}
export function isFinalNodeStatus(s: NodeStatus): boolean {
  return (FINAL_NODE_STATUSES as readonly NodeStatus[]).includes(s);
}

/** §8.3 */
export const RUN_STATUSES = ["running", "succeeded", "failed", "paused", "cancelled"] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export function isFinalRunStatus(s: RunStatus): boolean {
  return s === "succeeded" || s === "failed" || s === "cancelled";
}

export const LaneStatusSchema = z.enum(["active", "merged", "removed"]);
export type LaneStatus = z.infer<typeof LaneStatusSchema>;
