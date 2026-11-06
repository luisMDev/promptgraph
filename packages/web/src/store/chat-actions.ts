import type { ChatContext } from "@promptgraph/shared";
import { lastChatSessionId, useChatStore } from "./chat-store";
import { isReadOnly, useEditorStore } from "./editor-store";
import { useRunStore } from "./run-store";
import { useUiStore } from "./ui-store";

/** Chat workflows that read other stores: the per-message context and sending (DESIGN §20.3). */

/** What the user is looking at: the graph on screen, its selection and the run shown or active. */
export function currentChatContext(): ChatContext {
  const editor = useEditorStore.getState();
  const runs = useRunStore.getState();
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

/** Opens the panel; the first time it loads the session list and shows the last used chat. */
export async function openChatPanel(): Promise<void> {
  useUiStore.getState().setChatOpen(true);
  const chat = useChatStore.getState();
  if (chat.sessionsLoaded) return;
  await chat.loadSessions();
  const { sessions, activeSessionId } = useChatStore.getState();
  if (activeSessionId) return;
  const last = lastChatSessionId();
  const id = sessions.find((s) => s.id === last)?.id ?? sessions[0]?.id ?? null;
  if (id) await useChatStore.getState().selectSession(id);
}

export function toggleChatPanel(): void {
  if (useUiStore.getState().chatOpen) useUiStore.getState().setChatOpen(false);
  else void openChatPanel();
}

/**
 * Sends a user message on the shown chat (creating one when none is shown). The pending autosave is written first,
 * so Claude reads the graph the user sees. Returns false when nothing was sent.
 */
export async function sendChatMessage(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  await useEditorStore.getState().flushSave();
  // Claude would read (and patch) the file on disk, not the graph on screen.
  const editor = useEditorStore.getState();
  if (editor.graph && !isReadOnly(editor) && (editor.dirty || editor.externalChange)) {
    const why = editor.externalChange
      ? "the graph changed outside the editor: reload it or keep your changes first."
      : `your latest graph changes are not saved${editor.saveError ? ` (${editor.saveError})` : ""}.`;
    useUiStore.getState().toast("error", `Message not sent: ${why}`);
    return false;
  }
  let sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) sessionId = await useChatStore.getState().newSession();
  if (!sessionId) return false;
  const sent = useChatStore.getState().send(sessionId, trimmed, currentChatContext());
  if (!sent) useUiStore.getState().toast("error", "Not connected to the promptgraph server: the message was not sent.");
  return sent;
}
