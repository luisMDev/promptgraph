import type { Lane, NodeRun, RunDetail, RunSummary } from "@promptgraph/shared";

/** Runs: history list (from REST + run:update), the selected run's detail (node:update/lane:update merged in). */
export interface RunState {
  runs: RunSummary[];
  /** null = edit mode. */
  selectedRunId: string | null;
  detail: RunDetail | null;
  /** Current (latest iteration+attempt) node run per node id of the selected run. */
  currentByNode: Record<string, NodeRun>;
  lanes: Record<string, Lane>;
}
