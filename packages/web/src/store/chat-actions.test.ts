import type { ClientMessage, Graph, SaveGraphResponse } from "@promptgraph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatSessionOf, linearGraph, runDetailOf } from "../test-fixtures";
import { currentChatContext, sendChatMessage } from "./chat-actions";
import { setChatDeps, useChatStore } from "./chat-store";
import { setEditorPersistence, useEditorStore } from "./editor-store";
import { setRunStoreDeps, useRunStore } from "./run-store";
import { useUiStore } from "./ui-store";

describe("chat actions", () => {
  const events: string[] = [];
  const sent: ClientMessage[] = [];
  const save = vi.fn(async (graph: Graph): Promise<SaveGraphResponse> => {
    events.push("save");
    return { graph, hash: "h1" };
  });

  beforeEach(async () => {
    events.length = 0;
    sent.length = 0;
    save.mockClear();
    setEditorPersistence({ load: async () => ({ graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null }), save });
    setRunStoreDeps({ subscribe: () => undefined, unsubscribe: () => undefined, fetchRun: async () => runDetailOf(linearGraph(), []) });
    await useRunStore.getState().selectRun(null);
    useEditorStore.getState().closeGraph();
    await useEditorStore.getState().openGraph("g1");
    setChatDeps({
      createSession: async () => {
        events.push("create");
        return chatSessionOf({ id: "s1" });
      },
      send: (msg) => {
        events.push("send");
        sent.push(msg);
        return true;
      },
    });
    useChatStore.setState({ sessions: [], sessionsLoaded: true, activeSessionId: null, views: {}, error: null });
  });

  it("describes the graph on screen and its selection", () => {
    useEditorStore.getState().setSelection(["a", "b"], ["e1"]);
    expect(currentChatContext()).toEqual({ graphId: "g1", graphName: "Graph 1", selectedNodeIds: ["a", "b"], selectedEdgeIds: ["e1"], runId: null, readOnly: false });
    useEditorStore.getState().setActiveRunId("r9");
    expect(currentChatContext()).toMatchObject({ runId: "r9", readOnly: true });
  });

  it("uses the inspected node of a shown run as the selection", () => {
    useRunStore.getState().showRun(runDetailOf(linearGraph(), [], "r1"));
    useRunStore.getState().selectNode("b");
    expect(currentChatContext()).toMatchObject({ graphId: "g1", selectedNodeIds: ["b"], selectedEdgeIds: [], runId: "r1", readOnly: true });
  });

  it("reports no graph when none is open", () => {
    useEditorStore.getState().closeGraph();
    expect(currentChatContext()).toEqual({ graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: null, readOnly: true });
  });

  it("flushes the pending autosave, creates a session when needed and sends", async () => {
    useEditorStore.getState().rename("Edited");
    expect(await sendChatMessage("  add a test step  ")).toBe(true);
    expect(events).toEqual(["save", "create", "send"]);
    expect(sent[0]).toMatchObject({ type: "chat:send", sessionId: "s1", text: "add a test step", context: { graphId: "g1", graphName: "Edited" } });
    expect(await sendChatMessage("   ")).toBe(false);
  });

  it("does not send when the graph on screen could not be saved", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    useEditorStore.getState().rename("Edited");
    expect(await sendChatMessage("remove this node")).toBe(false);
    expect(events).not.toContain("send");
    expect(useUiStore.getState().toasts.at(-1)).toMatchObject({ kind: "error", message: expect.stringMatching(/not saved \(Save failed: disk full\)/) });
  });
});
