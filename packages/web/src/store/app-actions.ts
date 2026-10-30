import { createEmptyGraph, isFinalRunStatus, slugifyGraphId, type NodeRun, type ServerMessage } from "@promptgraph/shared";
import { ApiRequestError, api, errorMessage } from "../api/rest";
import { wsClient } from "../api/ws";
import { enteredMergeConflict } from "../lib/run-view";
import { useAppStore } from "./app-store";
import { useEditorStore } from "./editor-store";
import { useRunStore } from "./run-store";
import { useUiStore } from "./ui-store";

/** Cross-store workflows (graph switching, runs, terminals) and the WS → store wiring. */

const LAST_GRAPH_KEY = "pg_last_graph";

function rememberGraph(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_GRAPH_KEY, id);
    else localStorage.removeItem(LAST_GRAPH_KEY);
  } catch {
    // Per-browser convenience only.
  }
}

function lastGraphId(): string | null {
  try {
    return localStorage.getItem(LAST_GRAPH_KEY);
  } catch {
    return null;
  }
}

function reportError(prefix: string, err: unknown): void {
  useUiStore.getState().toast("error", `${prefix}: ${errorMessage(err)}`);
}

export async function selectGraph(id: string | null): Promise<void> {
  const runs = useRunStore.getState();
  await runs.selectRun(null);
  for (const ptyId of useUiStore.getState().terminalTabs) if (ptyId.startsWith(REOPEN_PTY_PREFIX)) void closeTerminalTab(ptyId);
  useUiStore.getState().closeAllTerminals();
  rememberGraph(id);
  if (!id) {
    await useEditorStore.getState().flushSave();
    useEditorStore.getState().closeGraph();
    runs.clearRuns();
    return;
  }
  await useEditorStore.getState().openGraph(id);
  await useRunStore.getState().loadRuns(id).catch((err) => reportError("Could not load run history", err));
  const active = useEditorStore.getState().activeRunId;
  if (active) await useRunStore.getState().selectRun(active);
}

/** First graph to show at startup: last used, else the first listed. */
export async function openInitialGraph(): Promise<void> {
  const graphs = useAppStore.getState().graphs;
  const last = lastGraphId();
  const id = graphs.find((g) => g.id === last)?.id ?? graphs[0]?.id ?? null;
  if (id) await selectGraph(id);
}

export function uniqueGraphId(name: string, taken: readonly string[]): string {
  const base = slugifyGraphId(name).slice(0, 56);
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export async function createGraph(name: string): Promise<void> {
  const app = useAppStore.getState();
  const id = uniqueGraphId(name, app.graphs.map((g) => g.id));
  const graph = createEmptyGraph(id, name.trim(), app.repo?.currentBranch ?? "main");
  try {
    await api.saveGraph(graph);
    await app.refreshGraphs();
    await selectGraph(id);
  } catch (err) {
    reportError("Could not create graph", err);
  }
}

export async function deleteGraph(id: string): Promise<void> {
  // A pending autosave would otherwise recreate the file right after the delete.
  if (useEditorStore.getState().graphId === id) await useEditorStore.getState().flushSave();
  try {
    await api.deleteGraph(id);
  } catch (err) {
    reportError("Could not delete graph", err);
    return;
  }
  const app = useAppStore.getState();
  await app.refreshGraphs().catch(() => undefined);
  const next = useAppStore.getState().graphs[0]?.id ?? null;
  if (useEditorStore.getState().graphId === id) await selectGraph(next);
}

export async function startRun(): Promise<void> {
  const editor = useEditorStore.getState();
  const graph = editor.graph;
  if (!graph) return;
  await editor.flushSave();
  const after = useEditorStore.getState();
  if (after.dirty || after.saveError) {
    useUiStore.getState().toast("error", after.saveError ?? "The graph has unsaved changes.");
    return;
  }
  try {
    const detail = await api.startRun(graph.id);
    useEditorStore.getState().setActiveRunId(detail.run.id);
    useRunStore.getState().showRun(detail);
  } catch (err) {
    if (err instanceof ApiRequestError && err.body.code === "validation_failed") {
      useUiStore.getState().toast("error", "The graph has validation errors; fix them before running.");
    } else {
      reportError("Could not start the run", err);
    }
  }
}

export async function cancelRun(runId: string): Promise<void> {
  try {
    await api.cancelRun(runId);
  } catch (err) {
    reportError("Could not cancel the run", err);
  }
}

export async function resumeRun(runId: string): Promise<void> {
  try {
    await api.resumeRun(runId);
  } catch (err) {
    reportError("Could not resume the run", err);
  }
}

export async function cleanupRun(runId: string): Promise<void> {
  try {
    await api.cleanupRun(runId);
    useUiStore.getState().toast("info", "Worktrees cleaned up.");
  } catch (err) {
    reportError("Cleanup failed", err);
  }
}

/** PTY ids of "Reopen session" terminals (CONTRACTS § PTY ids). */
const REOPEN_PTY_PREFIX = "reopen-";

export function openNodeTerminal(nodeRun: NodeRun, label: string): void {
  if (!nodeRun.ptyId) return;
  useUiStore.getState().openTerminal(nodeRun.ptyId, { title: label, nodeRunId: nodeRun.id });
}

/** Workspace setup PTY of a lane's first node run (CONTRACTS § PTY ids). */
export function openSetupTerminal(nodeRun: NodeRun, label: string): void {
  useUiStore.getState().openTerminal(`setup-${nodeRun.id}`, { title: `${label} (setup)`, nodeRunId: null });
}

export async function reopenSession(nodeRunId: string, label: string): Promise<void> {
  try {
    const { ptyId } = await api.reopen(nodeRunId);
    useUiStore.getState().openTerminal(ptyId, { title: `${label} (reopened)`, nodeRunId: null });
  } catch (err) {
    reportError("Could not reopen the session", err);
  }
}

/** Closing a "Reopen session" tab ends that claude process (it is not part of any run). */
export async function closeTerminalTab(ptyId: string): Promise<void> {
  useUiStore.getState().closeTerminal(ptyId);
  if (!ptyId.startsWith(REOPEN_PTY_PREFIX)) return;
  try {
    await api.closePty(ptyId);
  } catch (err) {
    // Already exited: nothing to stop.
    if (!(err instanceof ApiRequestError && err.status === 404)) reportError("Could not stop the reopened session", err);
  }
}

export type NodeControl = "done" | "fail" | "retry" | "skip" | "hold" | "release";

export async function nodeControl(nodeRunId: string, control: NodeControl): Promise<void> {
  try {
    const { nodeRun } =
      control === "fail"
        ? await api.failNode(nodeRunId, "Marked as failed by the user")
        : control === "hold" || control === "release"
          ? await api.holdNode(nodeRunId, control === "hold")
          : await api.nodeAction(nodeRunId, control);
    useRunStore.getState().applyNodeUpdate(nodeRun);
  } catch (err) {
    reportError(`Could not ${control === "release" ? "release hold on" : control} the node`, err);
  }
}

/** A merge paused on conflicts: open its shell in the drawer so the user can resolve them (§9.5). */
function openMergeShell(nodeRun: NodeRun): void {
  const node = useRunStore.getState().detail?.run.graphSnapshot.nodes.find((n) => n.id === nodeRun.nodeId);
  if (!nodeRun.ptyId) return;
  useUiStore.getState().openTerminal(nodeRun.ptyId, { title: `${node?.label || "Merge"} (merge shell)`, nodeRunId: nodeRun.id });
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
function refreshPendingSoon(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void useAppStore.getState().refreshPending();
  }, 300);
}

let helloCount = 0;

export function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "hello":
      // On reconnect, refresh everything that may have changed while disconnected.
      if (helloCount++ > 0) {
        void useAppStore.getState().refreshGraphs().catch(() => undefined);
        void useAppStore.getState().refreshPending();
        void useRunStore.getState().reloadSelected();
      }
      return;
    case "run:update": {
      useRunStore.getState().applyRunUpdate(msg.run);
      const editor = useEditorStore.getState();
      if (editor.graph?.id === msg.run.graphId) {
        if (!isFinalRunStatus(msg.run.status)) editor.setActiveRunId(msg.run.id);
        else if (editor.activeRunId === msg.run.id) editor.setActiveRunId(null);
      }
      refreshPendingSoon();
      return;
    }
    case "node:update": {
      const runs = useRunStore.getState();
      const prev = runs.detail?.nodeRuns.find((n) => n.id === msg.nodeRun.id);
      runs.applyNodeUpdate(msg.nodeRun);
      if (msg.nodeRun.runId === runs.selectedRunId && enteredMergeConflict(prev, msg.nodeRun)) openMergeShell(msg.nodeRun);
      return;
    }
    case "lane:update":
      useRunStore.getState().applyLaneUpdate(msg.lane);
      return;
    case "graphs:changed":
      void useAppStore.getState().refreshGraphs().catch(() => undefined);
      void useEditorStore.getState().checkExternalChange(msg.graphId);
      return;
    default:
      return;
  }
}

/** Connects the shared socket and routes server messages into the stores. Returns teardown. */
export function startLiveUpdates(): () => void {
  const offMsg = wsClient.onMessage(handleServerMessage);
  const offConn = wsClient.onConnection((c) => useAppStore.getState().setConnected(c));
  wsClient.connect();
  return () => {
    offMsg();
    offConn();
    wsClient.close();
  };
}
