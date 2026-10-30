import { ACTIVE_NODE_STATUSES } from "@promptgraph/shared";
import type { Store } from "../store/store.js";

export const INTERRUPTED_RUN_ERROR = "Server stopped during the run";
export const INTERRUPTED_NODE_ERROR = "Server stopped while the node was running";

/**
 * §8.6 at startup: node runs in running/idle/waiting_* (and ready) → interrupted (ready → pending);
 * their runs (status running) → paused, error "Server stopped during the run". Returns affected run ids.
 */
export function markInterrupted(store: Store, now: number = Date.now()): string[] {
  return store.transaction(() => {
    const affected = new Set<string>();
    for (const nr of store.listNodeRunsByStatus(ACTIVE_NODE_STATUSES)) {
      store.updateNodeRun(nr.id, { status: "interrupted", error: INTERRUPTED_NODE_ERROR, finishedAt: now, waitingReason: null });
      store.appendEvent(nr.runId, nr.id, "node.status", { status: "interrupted", from: nr.status });
      affected.add(nr.runId);
    }
    for (const nr of store.listNodeRunsByStatus(["ready"])) {
      store.updateNodeRun(nr.id, { status: "pending" });
      affected.add(nr.runId);
    }
    for (const run of store.listRunsByStatus(["running"])) {
      store.updateRun(run.id, { status: "paused", error: INTERRUPTED_RUN_ERROR });
      store.appendEvent(run.id, null, "run.status", { status: "paused", from: "running", error: INTERRUPTED_RUN_ERROR });
      affected.add(run.id);
    }
    return [...affected];
  });
}
