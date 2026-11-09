import type { ChatContext } from "@promptgraph/shared";
import { getChatStore } from "./chat-store";
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
    ...(graph.issues?.length ? { issues: graph.issues.map((i) => i.identifier) } : {}),
  };
}

/**
 * Sends a user message on a chat of the view's repository. The pending autosave is written first, so Claude reads
 * the graph the user sees. Returns false when nothing was sent.
 */
export async function sendChatMessage(view: ChatView, sessionId: string, text: string): Promise<boolean> {
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
  const sent = store.getState().send(sessionId, trimmed, currentChatContext(view));
  if (!sent) toast("error", "Not connected to the promptgraph daemon: the message was not sent.");
  return sent;
}
