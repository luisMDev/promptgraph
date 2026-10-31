import { ACTIVE_NODE_STATUSES } from "@promptgraph/shared";
import type { Store } from "../store/store.js";

export const INTERRUPTED_RUN_ERROR = "Server stopped during the run";
export const INTERRUPTED_NODE_ERROR = "Server stopped while the node was running";

/** Which runs a server may interrupt: those of its own repository, optionally only the given ones. */
export interface InterruptScope {
  repoPath: string;
  /** Only these runs (shutdown: the engine's live runs). Omitted: every run of the repository (startup). */
  runIds?: readonly string[];
}

/**
 * §8.6 at startup / §4.5 on shutdown: node runs in running/idle/waiting_* (and ready) → interrupted
 * (ready → pending); their runs (status running) → paused, error "Server stopped during the run".
 * Only runs of `scope.repoPath` are touched: the state DB is shared by every promptgraph instance, and
 * another instance (another repository) may be running its own runs right now. Returns affected run ids.
 */
export function markInterrupted(store: Store, scope: InterruptScope, now: number = Date.now()): string[] {
  const only = scope.runIds ? new Set(scope.runIds) : null;
  const inScope = (runId: string) => only === null || only.has(runId);
  const filter = { repoPath: scope.repoPath };
  return store.transaction(() => {
    const affected = new Set<string>();
    for (const nr of store.listNodeRunsByStatus(ACTIVE_NODE_STATUSES, filter)) {
      if (!inScope(nr.runId)) continue;
      store.updateNodeRun(nr.id, { status: "interrupted", error: INTERRUPTED_NODE_ERROR, finishedAt: now, waitingReason: null });
      store.appendEvent(nr.runId, nr.id, "node.status", { status: "interrupted", from: nr.status });
      affected.add(nr.runId);
    }
    for (const nr of store.listNodeRunsByStatus(["ready"], filter)) {
      if (!inScope(nr.runId)) continue;
      store.updateNodeRun(nr.id, { status: "pending" });
      affected.add(nr.runId);
    }
    for (const run of store.listRunsByStatus(["running"], filter)) {
      if (!inScope(run.id)) continue;
      store.updateRun(run.id, { status: "paused", error: INTERRUPTED_RUN_ERROR });
      store.appendEvent(run.id, null, "run.status", { status: "paused", from: "running", error: INTERRUPTED_RUN_ERROR });
      affected.add(run.id);
    }
    return [...affected];
  });
}
