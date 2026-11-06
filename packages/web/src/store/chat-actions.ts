import type { ChatContext } from "@promptgraph/shared";
import { getChatStore, lastChatSessionId } from "./chat-store";
import { toast } from "./toast-store";
import type { View } from "./view/context";
import { isReadOnly } from "./view/editor-store";

/** Chat workflows that read a view's stores: the per-message context and sending (DESIGN §21.3). */

export type ChatView = Pick<View, "repoId" | "editor" | "run" | "ui">;

/** What the user is looking at in this view: the graph on screen, its selection and the run shown or active. */
export function currentChatContext(view: ChatView): ChatContext {
  const editor = view.editor.getState();
  const runs = view.run.getState();
  const runMode = runs.selectedRunId !== null;
  const graph = editor.graph;
  if (!graph) return { graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: runs.selectedRunId, readOnly: true };
  return {
    graphId: graph.id,
    ...(graph.name ? { graphName: graph.name } : {}),
    // In run mode the canvas selection is the run store's single inspected node.
    selectedNodeIds: runMode ? (runs.selectedNodeId ? [runs.selectedNodeId] : []) : editor.selectedNodeIds,
    selectedEdgeIds: runMode ? [] : editor.selectedEdgeIds,
    runId: runs.selectedRunId ?? editor.activeRunId,
    readOnly: runMode || isReadOnly(editor),
  };
}

/** Opens the view's panel; the first time it loads the repository's sessions and shows the last used chat. */
export async function openChatPanel(view: ChatView): Promise<void> {
  view.ui.getState().setChatOpen(true);
  const store = getChatStore(view.repoId);
  const chat = store.getState();
  if (chat.sessionsLoaded) return;
  await chat.loadSessions();
  const { sessions, activeSessionId } = store.getState();
  if (activeSessionId) return;
  const last = lastChatSessionId(view.repoId);
  const id = sessions.find((s) => s.id === last)?.id ?? sessions[0]?.id ?? null;
  if (id) await store.getState().selectSession(id);
}

export function toggleChatPanel(view: ChatView): void {
  if (view.ui.getState().chatOpen) view.ui.getState().setChatOpen(false);
  else void openChatPanel(view);
}

/**
 * Sends a user message on the shown chat of the view's repository (creating one when none is shown). The pending
 * autosave is written first, so Claude reads the graph the user sees. Returns false when nothing was sent.
 */
export async function sendChatMessage(view: ChatView, text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  await view.editor.getState().flushSave();
  // Claude would read (and patch) the file on disk, not the graph on screen.
  const editor = view.editor.getState();
  if (editor.graph && !isReadOnly(editor) && (editor.dirty || editor.externalChange)) {
    const why = editor.externalChange
      ? "the graph changed outside the editor: reload it or keep your changes first."
      : `your latest graph changes are not saved${editor.saveError ? ` (${editor.saveError})` : ""}.`;
    toast("error", `Message not sent: ${why}`);
    return false;
  }
  const store = getChatStore(view.repoId);
  let sessionId = store.getState().activeSessionId;
  if (!sessionId) sessionId = await store.getState().newSession();
  if (!sessionId) return false;
  const sent = store.getState().send(sessionId, trimmed, currentChatContext(view));
  if (!sent) toast("error", "Not connected to the promptgraph daemon: the message was not sent.");
  return sent;
}
