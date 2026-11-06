// @vitest-environment jsdom
import type { ChatItem, ClientMessage, Graph, SaveGraphResponse } from "@promptgraph/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSessionOf, linearGraph } from "../../test-fixtures";
import { handleServerMessage } from "../../store/app-actions";
import { useAppStore } from "../../store/app-store";
import { emptyView, setChatDeps, useChatStore } from "../../store/chat-store";
import { setEditorPersistence, useEditorStore } from "../../store/editor-store";
import { useUiStore } from "../../store/ui-store";
import { ChatPanel } from "./ChatPanel";

const sent: ClientMessage[] = [];
const save = vi.fn(async (graph: Graph): Promise<SaveGraphResponse> => ({ graph, hash: "h1" }));

const items: ChatItem[] = [
  { id: "u1", ts: 1, kind: "user", text: "Add a commit after the tests" },
  { id: "t1", ts: 2, kind: "tool_use", toolUseId: "tu1", name: "mcp__plugin_promptgraph_promptgraph__patch_graph", input: { graphId: "g1", ops: [] }, summary: "patch_graph · 1 op" },
  { id: "t2", ts: 3, kind: "tool_result", toolUseId: "tu1", isError: false, text: "added: commit" },
  { id: "a1", ts: 4, kind: "assistant", messageId: "m1", text: "Added a **commit** node after `b`." },
];

function show(status: "idle" | "thinking" = "idle", extra: ChatItem[] = []) {
  useChatStore.setState({
    sessions: [chatSessionOf({ id: "s1", title: "Commit step", totalCostUsd: 0.0123 }), chatSessionOf({ id: "s2", title: "Older chat" })],
    sessionsLoaded: true,
    activeSessionId: "s1",
    views: { s1: { ...emptyView(status), items: [...items, ...extra] } },
    error: null,
  });
}

describe("ChatPanel", () => {
  beforeEach(async () => {
    sent.length = 0;
    save.mockClear();
    setChatDeps({
      send: (msg) => {
        sent.push(msg);
        return true;
      },
      getSession: async (id) => ({ session: chatSessionOf({ id }), items: [], pendingPermissions: [], streaming: [] }),
      createSession: async () => chatSessionOf({ id: "s3" }),
    });
    setEditorPersistence({ load: async () => ({ graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null }), save });
    useEditorStore.getState().closeGraph();
    await useEditorStore.getState().openGraph("g1");
    useAppStore.setState({ connected: true });
    useUiStore.setState({ chatOpen: true });
  });
  afterEach(cleanup);

  it("renders messages with markdown and folds tool results into their tool row", async () => {
    show();
    const user = userEvent.setup();
    render(<ChatPanel />);
    expect(screen.getByText("Add a commit after the tests")).toBeTruthy();
    expect(screen.getByText("commit").tagName).toBe("STRONG");
    expect(screen.getByText("$0.012")).toBeTruthy();
    // The result is hidden until the tool row is expanded.
    expect(screen.queryByText("added: commit")).toBeNull();
    await user.click(screen.getByRole("button", { name: /patch_graph · 1 op/ }));
    expect(screen.getByText("added: commit")).toBeTruthy();
  });

  it("streams deltas and replaces them with the final text", () => {
    show("thinking");
    render(<ChatPanel />);
    act(() => {
      handleServerMessage({ type: "chat:delta", sessionId: "s1", messageId: "m2", text: "Working on ", offset: 0 });
      handleServerMessage({ type: "chat:delta", sessionId: "s1", messageId: "m2", text: "it", offset: 11 });
    });
    expect(screen.getByText("Working on it")).toBeTruthy();
    act(() => handleServerMessage({ type: "chat:item", sessionId: "s1", item: { id: "a2", ts: 5, kind: "assistant", messageId: "m2", text: "Done." } }));
    expect(screen.queryByText("Working on it")).toBeNull();
    expect(screen.getByText("Done.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/working/i);
  });

  it("sends on Enter with the context, flushing the autosave first; Shift+Enter adds a new line", async () => {
    show();
    useEditorStore.getState().setSelection(["b"], []);
    useEditorStore.getState().rename("Edited");
    const user = userEvent.setup();
    render(<ChatPanel />);
    expect(screen.getByTestId("chat-context").textContent).toMatch(/Edited · node b/);
    const input = screen.getByRole("textbox", { name: "Message Claude" });
    await user.type(input, "first line{Shift>}{Enter}{/Shift}second");
    expect(sent).toEqual([]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({
      type: "chat:send",
      sessionId: "s1",
      text: "first line\nsecond",
      context: { graphId: "g1", graphName: "Edited", selectedNodeIds: ["b"], selectedEdgeIds: [], runId: null, readOnly: false },
    });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("shows Stop while Claude works and sends an interrupt", async () => {
    show("thinking");
    const user = userEvent.setup();
    render(<ChatPanel />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(sent).toEqual([{ type: "chat:interrupt", sessionId: "s1" }]);
  });

  it("answers a permission request from the card", async () => {
    show("thinking");
    const user = userEvent.setup();
    render(<ChatPanel />);
    act(() => {
      handleServerMessage({
        type: "chat:item",
        sessionId: "s1",
        item: { id: "p1", ts: 6, kind: "permission_request", requestId: "r1", toolName: "mcp__plugin_promptgraph_promptgraph__delete_graph", input: { graphId: "old" }, description: "Delete a graph" },
      });
      handleServerMessage({ type: "chat:status", sessionId: "s1", status: "waiting_permission" });
    });
    const card = screen.getByRole("alertdialog", { name: /delete_graph/ });
    expect(within(card).getByText("Delete a graph")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/permission/);
    // Focus moves to the card so keyboard users know Claude waits on them.
    expect(document.activeElement).toBe(within(card).getByRole("button", { name: "Allow" }));
    expect(card.getAttribute("aria-describedby")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Deny" }));
    expect(sent).toEqual([{ type: "chat:permission", sessionId: "s1", requestId: "r1", allow: false, message: "Denied by the user" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows concurrent permission prompts one after the other", async () => {
    show("thinking");
    const user = userEvent.setup();
    render(<ChatPanel />);
    act(() => {
      handleServerMessage({ type: "chat:item", sessionId: "s1", item: { id: "p1", ts: 6, kind: "permission_request", requestId: "r1", toolName: "Write", input: { file_path: "a" } } });
      handleServerMessage({ type: "chat:item", sessionId: "s1", item: { id: "p2", ts: 7, kind: "permission_request", requestId: "r2", toolName: "Edit", input: { file_path: "b" } } });
      handleServerMessage({ type: "chat:status", sessionId: "s1", status: "waiting_permission" });
    });
    let card = screen.getByRole("alertdialog", { name: /Write/ });
    expect(within(card).getByText("+1 more waiting")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Allow" }));
    card = screen.getByRole("alertdialog", { name: /Edit/ });
    await user.click(within(card).getByRole("button", { name: "Allow" }));
    expect(sent.map((m) => (m as { requestId?: string }).requestId)).toEqual(["r1", "r2"]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows 'Receiving reply' for a message whose beginning was streamed before it was opened", () => {
    show("thinking");
    render(<ChatPanel />);
    act(() => handleServerMessage({ type: "chat:delta", sessionId: "s1", messageId: "m3", text: "the commit node after b.", offset: 120 }));
    expect(screen.queryByText(/the commit node after b/)).toBeNull();
    expect(screen.getByText("Receiving reply…")).toBeTruthy();
  });

  it("announces new replies in a persistent live region, not the loaded history", () => {
    show("idle");
    render(<ChatPanel />);
    const announcer = screen.getByTestId("chat-announcer");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("");
    // The status region exists while idle, so later changes are announced.
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => handleServerMessage({ type: "chat:item", sessionId: "s1", item: { id: "a9", ts: 9, kind: "assistant", messageId: "m9", text: "Removed node b." } }));
    expect(announcer.textContent).toBe("Claude replied: Removed node b.");
  });

  it("does not carry the draft or the scroll state over to another session", async () => {
    show();
    const user = userEvent.setup();
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: "Message Claude" });
    await user.type(input, "draft for s1");
    act(() => {
      useChatStore.setState({ activeSessionId: "s2", views: { ...useChatStore.getState().views, s2: emptyView() } });
    });
    expect((screen.getByRole("textbox", { name: "Message Claude" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("switches sessions and starts a new chat from the picker", async () => {
    show();
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Commit step/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Older chat/ }));
    await waitFor(() => expect(useChatStore.getState().activeSessionId).toBe("s2"));
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(useChatStore.getState().activeSessionId).toBe("s3"));
    expect(screen.getByText(/Describe what you want to build/)).toBeTruthy();
  });

  it("shows warnings in the status line", () => {
    show();
    render(<ChatPanel />);
    act(() => handleServerMessage({ type: "chat:status", sessionId: "s1", status: "idle", warning: "promptgraph plugin not found: MCP tools only, no skills" }));
    expect(screen.getByRole("status").textContent).toMatch(/plugin not found/);
  });
});
