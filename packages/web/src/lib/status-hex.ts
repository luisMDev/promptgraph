import type { NodeStatus } from "@promptgraph/shared";
import type { Theme } from "./theme";

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

/** Dark-theme replacements for the neutral statuses, whose light greys glare on the dark minimap. */
const DARK_OVERRIDES: Partial<Record<NodeStatus, string>> = {
  pending: "#52525b",
  ready: "#71717a",
  skipped: "#3f3f46",
  cancelled: "#71717a",
  interrupted: "#71717a",
};

/** Minimap colour of a node status in the given theme. */
export function statusHex(status: NodeStatus, theme: Theme): string {
  return (theme === "dark" ? DARK_OVERRIDES[status] : undefined) ?? NODE_STATUS_COLOR_HEX[status];
}

/** Minimap colour of an editor node (no run): red when it has errors, otherwise the pending grey. */
export function editorNodeHex(hasErrors: boolean, theme: Theme): string {
  return hasErrors ? NODE_STATUS_COLOR_HEX.failed : statusHex("pending", theme);
}
