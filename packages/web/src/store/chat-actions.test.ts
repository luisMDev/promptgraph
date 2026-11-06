import type { ClientMessage, Graph, SaveGraphResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSessionOf, linearGraph, runDetailOf } from "../test-fixtures";
import { currentChatContext, sendChatMessage } from "./chat-actions";
import { clearChatStores, getChatStore, setChatDeps } from "./chat-store";
import { useToastStore } from "./toast-store";
import { createTestView, TEST_REPO_ID, type TestView } from "./view/test-view";

describe("chat actions", () => {
  const events: string[] = [];
  const sent: ClientMessage[] = [];
  const save = vi.fn(async (graph: Graph): Promise<SaveGraphResponse> => {
    events.push("save");
    return { graph, hash: "h1" };
  });
  let view: TestView;

  beforeEach(async () => {
    events.length = 0;
    sent.length = 0;
    save.mockClear();
    view = createTestView({
      graphId: "g1",
      persistence: { load: async () => ({ graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null }), save },
      runDeps: { fetchRun: async () => runDetailOf(linearGraph(), []) },
    });
    await view.editor.getState().load();
    clearChatStores();
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
    getChatStore(TEST_REPO_ID).setState({ sessionsLoaded: true });
  });

  afterEach(() => {
    clearChatStores();
  });

  it("describes the graph on screen and its selection", () => {
    view.editor.getState().setSelection(["a", "b"], ["e1"]);
    expect(currentChatContext(view)).toEqual({ graphId: "g1", graphName: "Graph 1", selectedNodeIds: ["a", "b"], selectedEdgeIds: ["e1"], runId: null, readOnly: false });
    view.editor.getState().setActiveRunId("r9");
    expect(currentChatContext(view)).toMatchObject({ runId: "r9", readOnly: true });
  });

  it("uses the inspected node of a shown run as the selection", () => {
    view.run.getState().showRun(runDetailOf(linearGraph(), [], "r1"));
    view.run.getState().selectNode("b");
    expect(currentChatContext(view)).toMatchObject({ graphId: "g1", selectedNodeIds: ["b"], selectedEdgeIds: [], runId: "r1", readOnly: true });
  });

  it("reports no graph when none is open", () => {
    const empty = createTestView({ graphId: null });
    expect(currentChatContext(empty)).toEqual({ graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: null, readOnly: true });
  });

  it("flushes the pending autosave, then sends on the given session of the view's repository", async () => {
    view.editor.getState().rename("Edited");
    expect(await sendChatMessage(view, "s1", "  add a test step  ")).toBe(true);
    expect(events).toEqual(["save", "send"]);
    expect(sent[0]).toMatchObject({ type: "chat:send", repoId: TEST_REPO_ID, sessionId: "s1", text: "add a test step", context: { graphId: "g1", graphName: "Edited" } });
    expect(await sendChatMessage(view, "s1", "   ")).toBe(false);
  });

  it("does not send when the graph on screen could not be saved", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    view.editor.getState().rename("Edited");
    expect(await sendChatMessage(view, "s1", "remove this node")).toBe(false);
    expect(events).not.toContain("send");
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: "error", message: expect.stringMatching(/not saved \(Save failed: disk full\)/) });
  });
});
