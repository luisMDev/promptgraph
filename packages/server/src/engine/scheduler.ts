import { CLAUDE_NODE_TYPES, type NodeType } from "@promptgraph/shared";

export interface SchedulerItem {
  nodeRunId: string;
  nodeType: NodeType;
  laneId: string;
}

const isCapped = (t: NodeType) => (CLAUDE_NODE_TYPES as readonly NodeType[]).includes(t);

/**
 * FIFO by readiness (§8.4). Claude-type items (prompt/command, and merge while resolving with Claude is
 * accounted by the runner) are capped at maxParallelClaude across the run; shell/git items are not capped.
 * `onStart` is invoked synchronously for every item that may start now.
 */
export class Scheduler {
  private readonly queue: SchedulerItem[] = [];
  private readonly running = new Map<string, SchedulerItem>();
  private pumping = false;
  private pumpAgain = false;

  constructor(
    private readonly maxParallelClaude: number,
    private readonly onStart: (item: SchedulerItem) => void,
  ) {}

  enqueue(item: SchedulerItem): void {
    if (this.running.has(item.nodeRunId) || this.queue.some((q) => q.nodeRunId === item.nodeRunId)) return;
    this.queue.push(item);
    this.pump();
  }

  /** Item finished (any final status) → frees its slot and starts queued items. */
  release(nodeRunId: string): void {
    if (this.running.delete(nodeRunId)) this.pump();
  }

  /** Removes a queued item (cancel/skip before start). */
  remove(nodeRunId: string): void {
    const i = this.queue.findIndex((q) => q.nodeRunId === nodeRunId);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Drops every queued item (run cancelled/terminated); returns them. */
  clear(): SchedulerItem[] {
    return this.queue.splice(0);
  }

  get runningCount(): number {
    return this.running.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Starts every startable item in FIFO order; re-entrant calls (from onStart) are folded into one loop. */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        let claudeRunning = [...this.running.values()].filter((r) => isCapped(r.nodeType)).length;
        for (let i = 0; i < this.queue.length; ) {
          const item = this.queue[i]!;
          if (isCapped(item.nodeType) && claudeRunning >= this.maxParallelClaude) {
            i++;
            continue;
          }
          this.queue.splice(i, 1);
          this.running.set(item.nodeRunId, item);
          if (isCapped(item.nodeType)) claudeRunning++;
          this.onStart(item);
          if (this.pumpAgain) break;
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }
}
