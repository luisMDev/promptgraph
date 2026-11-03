import type { NodeStatus } from "@promptgraph/shared";

/** Hex values of the §8.2 status colours, for SVG contexts (minimap) that cannot use Tailwind classes. */
export const NODE_STATUS_COLOR_HEX: Record<NodeStatus, string> = {
  pending: "#a8a29e",
  ready: "#78716c",
  running: "#3b82f6",
  idle: "#38bdf8",
  waiting_input: "#f59e0b",
  waiting_approval: "#8b5cf6",
  succeeded: "#22c55e",
  failed: "#ef4444",
  skipped: "#d6d3d1",
  cancelled: "#78716c",
  interrupted: "#78716c",
};
