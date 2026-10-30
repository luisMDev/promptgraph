import type { NodeType } from "@promptgraph/shared";

export interface SchedulerItem {
  nodeRunId: string;
  nodeType: NodeType;
  laneId: string;
}

/**
 * FIFO by readiness (§8.4). Claude-type items (prompt/command, and merge while resolving with Claude is
 * accounted by the runner) are capped at maxParallelClaude across the run; shell/git items are not capped.
 * `onStart` is invoked synchronously for every item that may start now.
 */
export class Scheduler {
  constructor(
    private readonly maxParallelClaude: number,
    private readonly onStart: (item: SchedulerItem) => void,
  ) {}

  enqueue(item: SchedulerItem): void {
    throw new Error("not implemented");
  }

  /** Item finished (any final status) → frees its slot and starts queued items. */
  release(nodeRunId: string): void {
    throw new Error("not implemented");
  }

  /** Removes a queued item (cancel/skip before start). */
  remove(nodeRunId: string): void {
    throw new Error("not implemented");
  }

  get runningCount(): number {
    throw new Error("not implemented");
  }

  get queuedCount(): number {
    throw new Error("not implemented");
  }
}
