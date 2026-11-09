import { createEmptyGraph, nodeDisplayLabel, slugifyGraphId, webRoutes, type NodeRun, type RunSummary } from "@promptgraph/shared";
import { ApiRequestError, errorMessage } from "../../api/rest";
import { getRepoCache } from "../repo-cache";
import { toast } from "../toast-store";
import type { View } from "./context";
import { discardEditorStore } from "./editor-store";

/**
 * Workflows of one view (graphs, runs, terminals). Navigation goes through the view's location: the route
 * is the source of truth, and the view applies it to its stores (`views/RepoView.tsx`).
 */

/** localStorage key of the repository's last shown graph (DESIGN §13.2). */
export function lastGraphKey(repoId: string): string {
  return `pg.lastGraph.${repoId}`;
}

export function rememberGraph(repoId: string, graphId: string): void {
  try {
    localStorage.setItem(lastGraphKey(repoId), graphId);
  } catch {
    // Per-browser convenience only.
  }
}

export function lastGraphId(repoId: string): string | null {
  try {
    return localStorage.getItem(lastGraphKey(repoId));
  } catch {
    return null;
  }
}

function reportError(prefix: string, err: unknown): void {
  toast("error", `${prefix}: ${errorMessage(err)}`);
}

export function uniqueGraphId(name: string, taken: readonly string[]): string {
  const base = slugifyGraphId(name).slice(0, 56);
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export async function createGraph(view: View, name: string): Promise<void> {
  const cache = getRepoCache(view.repoId).getState();
  const id = uniqueGraphId(name, (cache.graphs ?? []).map((g) => g.id));
  const graph = createEmptyGraph(id, name.trim(), cache.info?.currentBranch ?? "main");
  try {
    await view.api.saveGraph(graph);
    await getRepoCache(view.repoId).getState().refreshGraphs();
    view.navigate(webRoutes.graph(view.repoId, id));
  } catch (err) {
    reportError("Could not create graph", err);
  }
}

export async function deleteGraph(view: View, id: string): Promise<void> {
  const editor = view.editor.getState();
  // A pending autosave would otherwise recreate the file right after the delete.
  if (editor.graphId === id) await editor.flushSave();
  try {
    await view.api.deleteGraph(id);
  } catch (err) {
    reportError("Could not delete graph", err);
    return;
  }
  discardEditorStore(view.repoId, id);
  const cache = getRepoCache(view.repoId);
  await cache
    .getState()
    .refreshGraphs()
    .catch(() => undefined);
  // Deleting the graph the view shows goes back to the repository's overview (§13.3).
  if (view.editor.getState().graphId !== id) return;
  view.navigate(webRoutes.repo(view.repoId), { replace: true });
}

export async function startRun(view: View): Promise<void> {
  const editor = view.editor.getState();
  const graph = editor.graph;
  if (!graph) return;
  await editor.flushSave();
  const after = view.editor.getState();
  if (after.dirty || after.saveError) {
    toast("error", after.saveError ?? "The graph has unsaved changes.");
    return;
  }
  try {
    const detail = await view.api.startRun(graph.id);
    view.editor.getState().setActiveRunId(detail.run.id);
    view.run.getState().showRun(detail);
    view.navigate(webRoutes.run(view.repoId, detail.run.id));
  } catch (err) {
    if (err instanceof ApiRequestError && err.body.code === "validation_failed") {
      toast("error", "The graph has validation errors; fix them before running.");
    } else {
      reportError("Could not start the run", err);
    }
  }
}

export async function cancelRun(view: View, runId: string): Promise<void> {
  try {
    await view.api.cancelRun(runId);
  } catch (err) {
    reportError("Could not cancel the run", err);
  }
}

export async function resumeRun(view: View, runId: string): Promise<void> {
  try {
    await view.api.resumeRun(runId);
  } catch (err) {
    reportError("Could not resume the run", err);
  }
}

export async function cleanupRun(view: View, runId: string): Promise<void> {
  try {
    await view.api.cleanupRun(runId);
    toast("info", "Worktrees cleaned up.");
  } catch (err) {
    reportError("Cleanup failed", err);
  }
}

/**
 * Deletes a finished run (§13.2). A view showing it goes back to the editor of its graph first, so it never shows
 * "does not exist" for a run the user removed.
 */
export async function deleteRun(view: View, run: Pick<RunSummary, "id" | "graphId" | "shortId">): Promise<boolean> {
  if (view.run.getState().selectedRunId === run.id) view.navigate(webRoutes.graph(view.repoId, run.graphId));
  try {
    await view.api.deleteRun(run.id);
  } catch (err) {
    reportError(`Could not delete run #${run.shortId}`, err);
    return false;
  }
  view.run.getState().removeRun(run.id);
  toast("info", `Run #${run.shortId} deleted.`);
  return true;
}

/** PTY ids of "Reopen session" terminals (CONTRACTS § PTY ids). */
export const REOPEN_PTY_PREFIX = "reopen-";

/**
 * Tab title of a node run's terminal: the label plus the run's short id and the attempt, so tabs of
 * earlier runs (or retries) with the same label stay distinguishable.
 */
export function terminalTitle(view: Pick<View, "run">, nodeRun: NodeRun, label: string): string {
  const detail = view.run.getState().detail;
  const shortId = detail?.run.id === nodeRun.runId ? detail.run.shortId : null;
  const attempt = nodeRun.attempt > 0 ? ` try ${nodeRun.attempt + 1}` : "";
  return shortId ? `${label} · #${shortId}${attempt}` : `${label}${attempt}`;
}

export function openNodeTerminal(view: Pick<View, "run" | "ui">, nodeRun: NodeRun, label: string): void {
  if (!nodeRun.ptyId) return;
  view.ui.getState().openTerminal(nodeRun.ptyId, { title: terminalTitle(view, nodeRun, label), nodeRunId: nodeRun.id });
}

/** Workspace setup PTY of a lane's first node run (CONTRACTS § PTY ids). */
export function openSetupTerminal(view: Pick<View, "ui">, nodeRun: NodeRun, label: string): void {
  view.ui.getState().openTerminal(`setup-${nodeRun.id}`, { title: `${label} (setup)`, nodeRunId: null });
}

/**
 * What the run canvas does for a node run (a click on its node, or a `/nodes/<nodeRunId>` route): select
 * its node (and iteration), open its terminal, and the approval dialog when it waits for one.
 */
export function showNodeRun(view: Pick<View, "run" | "ui">, nodeRun: NodeRun): void {
  const run = view.run.getState();
  run.selectNode(nodeRun.nodeId);
  const current = run.currentByNode[nodeRun.nodeId];
  run.selectIteration(current && current.iteration !== nodeRun.iteration ? nodeRun.iteration : null);
  const node = run.detail?.run.graphSnapshot.nodes.find((n) => n.id === nodeRun.nodeId);
  if (nodeRun.status === "waiting_approval") view.ui.getState().openApproval(nodeRun.id);
  openNodeTerminal(view, nodeRun, node ? nodeDisplayLabel(node) : nodeRun.nodeId);
}

export async function reopenSession(view: View, nodeRunId: string, label: string): Promise<void> {
  try {
    const { ptyId, notice } = await view.api.reopen(nodeRunId);
    view.ui.getState().openTerminal(ptyId, { title: `${label} (reopened)`, nodeRunId: null });
    if (notice) toast("info", notice);
  } catch (err) {
    reportError("Could not reopen the session", err);
  }
}

/** Closing a "Reopen session" tab ends that claude process (it is not part of any run). */
export async function closeTerminalTab(view: Pick<View, "api" | "ui">, ptyId: string): Promise<void> {
  view.ui.getState().closeTerminal(ptyId);
  if (!ptyId.startsWith(REOPEN_PTY_PREFIX)) return;
  try {
    await view.api.closePty(ptyId);
  } catch (err) {
    // Already exited: nothing to stop.
    if (!(err instanceof ApiRequestError && err.status === 404)) reportError("Could not stop the reopened session", err);
  }
}

/** Closes every terminal of the view, ending its reopened sessions (another graph was opened). */
export function closeAllTerminals(view: Pick<View, "api" | "ui">): void {
  for (const ptyId of view.ui.getState().terminalTabs) if (ptyId.startsWith(REOPEN_PTY_PREFIX)) void closeTerminalTab(view, ptyId);
  view.ui.getState().closeAllTerminals();
}

export type NodeControl = "done" | "fail" | "retry" | "skip" | "hold" | "release";

export async function nodeControl(view: View, nodeRunId: string, control: NodeControl): Promise<void> {
  try {
    const { nodeRun } =
      control === "fail"
        ? await view.api.failNode(nodeRunId, "Marked as failed by the user")
        : control === "hold" || control === "release"
          ? await view.api.holdNode(nodeRunId, control === "hold")
          : await view.api.nodeAction(nodeRunId, control);
    view.run.getState().applyNodeUpdate(nodeRun);
  } catch (err) {
    reportError(`Could not ${control === "release" ? "release hold on" : control} the node`, err);
  }
}

/** A merge paused on conflicts: open its shell in the drawer so the user can resolve them (§9.5). */
export function openMergeShell(view: Pick<View, "run" | "ui">, nodeRun: NodeRun): void {
  const node = view.run.getState().detail?.run.graphSnapshot.nodes.find((n) => n.id === nodeRun.nodeId);
  if (!nodeRun.ptyId) return;
  view.ui.getState().openTerminal(nodeRun.ptyId, { title: terminalTitle(view, nodeRun, `${node ? nodeDisplayLabel(node) : "Merge"} (merge shell)`), nodeRunId: nodeRun.id });
}
