import type { NodeStatus } from "@promptgraph/shared";

/** Hex values of the §8.2 status colours, for SVG contexts (minimap) that cannot use Tailwind classes. */
export const NODE_STATUS_COLOR_HEX: Record<NodeStatus, string> = {
  pending: "#52525b",
  ready: "#71717a",
  running: "#3b82f6",
  idle: "#7dd3fc",
  waiting_input: "#f59e0b",
  waiting_approval: "#8b5cf6",
  succeeded: "#22c55e",
  failed: "#ef4444",
  skipped: "#3f3f46",
  cancelled: "#52525b",
  interrupted: "#52525b",
};
