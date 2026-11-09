// @vitest-environment jsdom
import type { ChatItem, ClientMessage, Graph, SaveGraphResponse } from "@promptgraph/shared";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSessionOf, linearGraph } from "../../test-fixtures";
import { clearChatStores, emptyView, getChatStore, setChatDeps } from "../../store/chat-store";
import { useDaemonStore } from "../../store/daemon-store";
import { createDispatcher } from "../../store/dispatcher";
import { createTestView, TEST_REPO_ID, type TestView } from "../../store/view/test-view";
import { emitChatShortcut } from "../../lib/chat-shortcut";
import { useState } from "react";
import type { TabChats } from "../../store/tabs-store";
import { TabContext, type TabContextValue } from "../tabs/tab-context";
import { ChatDock } from "./ChatDock";
import { ChatWindow, type ChatWindowActions } from "./ChatPanel";

/** The view under test (its repository's chat store is getChatStore(TEST_REPO_ID)). */
let view: TestView;
const chat = () => getChatStore(TEST_REPO_ID);
let dispatcher = createDispatcher();
const handleServerMessage: typeof dispatcher.handle = (msg) => dispatcher.handle(msg);

const sent: ClientMessage[] = [];
const save = vi.fn(async (graph: Graph): Promise<SaveGraphResponse> => ({ graph, hash: "h1" }));

const items: ChatItem[] = [
  { id: "u1", ts: 1, kind: "user", text: "Add a commit after the tests" },
  { id: "t1", ts: 2, kind: "tool_use", toolUseId: "tu1", name: "mcp__plugin_promptgraph_promptgraph__patch_graph", input: { graphId: "g1", ops: [] }, summary: "patch_graph · 1 op" },
  { id: "t2", ts: 3, kind: "tool_result", toolUseId: "tu1", isError: false, text: "added: commit" },
  { id: "a1", ts: 4, kind: "assistant", messageId: "m1", text: "Added a **commit** node after `b`." },
];

function show(status: "idle" | "thinking" = "idle", extra: ChatItem[] = []) {
  chat().setState({
    sessions: [chatSessionOf({ id: "s1", title: "Commit step", totalCostUsd: 0.0123 }), chatSessionOf({ id: "s2", title: "Older chat" })],
    sessionsLoaded: true,
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
    clearChatStores();
    dispatcher = createDispatcher();
    view = createTestView({ graphId: "g1", persistence: { load: async () => ({ graph: linearGraph(), hash: "h0", modifiedOutside: false, activeRunId: null }), save } });
    await view.editor.getState().load();
    useDaemonStore.setState({ connection: "open" });
  });
  afterEach(cleanup);

  const actions: ChatWindowActions = { onMinimize: vi.fn(), onClose: vi.fn(), expanded: false, onToggleExpanded: vi.fn() };
  const Window = ({ id = "s1" }: { id?: string }) => <ChatWindow sessionId={id} actions={actions} />;

  it("renders messages with markdown and folds tool calls into one activity group", async () => {
    show();
    const user = userEvent.setup();
    view.render(<Window />);
    expect(screen.getByText("Add a commit after the tests")).toBeTruthy();
    expect(screen.getByText("commit").tagName).toBe("STRONG");
    expect(screen.getByRole("heading", { name: "Commit step" })).toBeTruthy();
    // The group says what it did; the calls and their results are hidden until it is expanded.
    expect(screen.queryByText("added: commit")).toBeNull();
    expect(screen.queryByRole("button", { name: /Update graph g1/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Updated the graph.*1 step/ }));
    await user.click(screen.getByRole("button", { name: /Update graph g1 · 0 changes/ }));
    expect(screen.getByText("added: commit")).toBeTruthy();
  });

  it("streams deltas and replaces them with the final text", () => {
    show("thinking");
    view.render(<Window />);
    act(() => {
      handleServerMessage({ type: "chat:delta", repoId: TEST_REPO_ID, sessionId: "s1", messageId: "m2", text: "Working on ", offset: 0 });
      handleServerMessage({ type: "chat:delta", repoId: TEST_REPO_ID, sessionId: "s1", messageId: "m2", text: "it", offset: 11 });
    });
    expect(screen.getByText("Working on it")).toBeTruthy();
    act(() => handleServerMessage({ type: "chat:item", repoId: TEST_REPO_ID, sessionId: "s1", item: { id: "a2", ts: 5, kind: "assistant", messageId: "m2", text: "Done." } }));
    expect(screen.queryByText("Working on it")).toBeNull();
    expect(screen.getByText("Done.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/working/i);
  });

  it("sends on Enter with the context, flushing the autosave first; Shift+Enter adds a new line", async () => {
    show();
    view.editor.getState().setSelection(["b"], []);
    view.editor.getState().rename("Edited");
    const user = userEvent.setup();
    view.render(<Window />);
    expect(screen.getByTestId("chat-context").textContent).toMatch(/Edited · node b/);
    const input = screen.getByRole("textbox", { name: "Message Claude" });
    await user.type(input, "first line{Shift>}{Enter}{/Shift}second");
    expect(sent).toEqual([]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({
      type: "chat:send",
      repoId: TEST_REPO_ID,
      sessionId: "s1",
      text: "first line\nsecond",
      context: { graphId: "g1", graphName: "Edited", selectedNodeIds: ["b"], selectedEdgeIds: [], runId: null, readOnly: false },
    });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("shows Stop while Claude works and sends an interrupt", async () => {
    show("thinking");
    const user = userEvent.setup();
    view.render(<Window />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(sent).toEqual([{ type: "chat:interrupt", repoId: TEST_REPO_ID, sessionId: "s1" }]);
  });

  it("answers a permission request from the card", async () => {
    show("thinking");
    const user = userEvent.setup();
    view.render(<Window />);
    act(() => {
      handleServerMessage({
        type: "chat:item",
        repoId: TEST_REPO_ID,
        sessionId: "s1",
        item: { id: "p1", ts: 6, kind: "permission_request", requestId: "r1", toolName: "mcp__plugin_promptgraph_promptgraph__delete_graph", input: { graphId: "old" }, description: "Delete a graph" },
      });
      handleServerMessage({ type: "chat:status", repoId: TEST_REPO_ID, sessionId: "s1", status: "waiting_permission" });
    });
    const card = screen.getByRole("alertdialog", { name: /delete_graph/ });
    expect(within(card).getByText("Delete a graph")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/permission/);
    // Focus moves to the card so keyboard users know Claude waits on them.
    expect(document.activeElement).toBe(within(card).getByRole("button", { name: "Allow" }));
    expect(card.getAttribute("aria-describedby")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Deny" }));
    expect(sent).toEqual([{ type: "chat:permission", repoId: TEST_REPO_ID, sessionId: "s1", requestId: "r1", allow: false, message: "Denied by the user" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  const askInput = {
    questions: [
      { question: "How complex should the graph be?", header: "Complexity", multiSelect: false, options: [{ label: "Simple", description: "2-4 steps" }, { label: "Complex" }] },
      { question: "How is the result checked?", header: "Checks", multiSelect: true, options: [{ label: "Tests" }, { label: "Review" }] },
    ],
  };
  function askQuestions() {
    act(() => {
      handleServerMessage({
        type: "chat:item",
        repoId: TEST_REPO_ID,
        sessionId: "s1",
        item: { id: "q-use", ts: 6, kind: "tool_use", toolUseId: "tq", name: "AskUserQuestion", input: askInput, summary: "AskUserQuestion · 2 questions" },
      });
      handleServerMessage({
        type: "chat:item",
        repoId: TEST_REPO_ID,
        sessionId: "s1",
        item: { id: "q-req", ts: 7, kind: "permission_request", requestId: "rq", toolName: "AskUserQuestion", input: askInput, toolUseId: "tq" },
      });
      handleServerMessage({ type: "chat:status", repoId: TEST_REPO_ID, sessionId: "s1", status: "waiting_permission" });
    });
  }

  it("answers AskUserQuestion from a question card", async () => {
    show("thinking");
    const user = userEvent.setup();
    view.render(<Window />);
    askQuestions();
    const card = screen.getByTestId("question-card");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(card).getByText("Claude has 2 questions")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Chat messages" })).getByText("Claude is asking you…")).toBeTruthy();
    // Focus goes to the first option; picking a single-choice option moves to the next question.
    expect(document.activeElement).toBe(within(card).getByRole("radio", { name: /Simple/ }));
    await user.click(within(card).getByRole("radio", { name: /Simple/ }));
    expect(within(card).getByText("How is the result checked?")).toBeTruthy();
    // Number keys pick options; "Other" takes free text.
    await user.keyboard("1");
    expect(within(card).getByRole("checkbox", { name: /Tests/ }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(card).getByRole("checkbox", { name: /Other/ }));
    await user.type(within(card).getByRole("textbox", { name: "Your answer" }), "a smoke run");
    await user.click(within(card).getByRole("button", { name: "Submit" }));
    expect(sent).toEqual([
      {
        type: "chat:permission",
        repoId: TEST_REPO_ID,
        sessionId: "s1",
        requestId: "rq",
        allow: true,
        answers: { "How complex should the graph be?": "Simple", "How is the result checked?": "Tests, a smoke run" },
      },
    ]);
    expect(screen.queryByTestId("question-card")).toBeNull();
    // The answered questions stay in the conversation.
    act(() =>
      handleServerMessage({
        type: "chat:item",
        repoId: TEST_REPO_ID,
        sessionId: "s1",
        item: { id: "q-res", ts: 8, kind: "tool_result", toolUseId: "tq", isError: false, text: "answered", answers: { "How complex should the graph be?": "Simple" } },
      }),
    );
    const list = screen.getByRole("list", { name: "Chat messages" });
    expect(within(list).getByText("Claude asked 2 questions")).toBeTruthy();
    expect(within(list).getByText("Simple")).toBeTruthy();
  });

  it("skips AskUserQuestion with a deny", async () => {
    show("thinking");
    const user = userEvent.setup();
    view.render(<Window />);
    askQuestions();
    await user.click(within(screen.getByTestId("question-card")).getByRole("button", { name: "Skip" }));
    expect(sent).toEqual([{ type: "chat:permission", repoId: TEST_REPO_ID, sessionId: "s1", requestId: "rq", allow: false }]);
  });

  it("starts planning from a suggestion of an empty chat", async () => {
    chat().setState({ sessions: [chatSessionOf({ id: "s1" })], sessionsLoaded: true, views: { s1: emptyView() }, error: null });
    const user = userEvent.setup();
    view.render(<Window />);
    await user.click(screen.getByRole("button", { name: "Plan a new graph" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: "chat:send", sessionId: "s1", text: "Help me plan a new graph for this repository." });
  });

  it("shows Thinking inline while Claude works without streaming text", () => {
    show("thinking");
    view.render(<Window />);
    expect(within(screen.getByRole("list", { name: "Chat messages" })).getByText("Thinking…")).toBeTruthy();
  });

  it("shows concurrent permission prompts one after the other", async () => {
    show("thinking");
    const user = userEvent.setup();
    view.render(<Window />);
    act(() => {
      handleServerMessage({ type: "chat:item", repoId: TEST_REPO_ID, sessionId: "s1", item: { id: "p1", ts: 6, kind: "permission_request", requestId: "r1", toolName: "Write", input: { file_path: "a" } } });
      handleServerMessage({ type: "chat:item", repoId: TEST_REPO_ID, sessionId: "s1", item: { id: "p2", ts: 7, kind: "permission_request", requestId: "r2", toolName: "Edit", input: { file_path: "b" } } });
      handleServerMessage({ type: "chat:status", repoId: TEST_REPO_ID, sessionId: "s1", status: "waiting_permission" });
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
    view.render(<Window />);
    act(() => handleServerMessage({ type: "chat:delta", repoId: TEST_REPO_ID, sessionId: "s1", messageId: "m3", text: "the commit node after b.", offset: 120 }));
    expect(screen.queryByText(/the commit node after b/)).toBeNull();
    expect(screen.getByText("Receiving reply…")).toBeTruthy();
  });

  it("announces new replies in a persistent live region, not the loaded history", () => {
    show("idle");
    view.render(<Window />);
    const announcer = screen.getByTestId("chat-announcer");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("");
    // The status region exists while idle, so later changes are announced.
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => handleServerMessage({ type: "chat:item", repoId: TEST_REPO_ID, sessionId: "s1", item: { id: "a9", ts: 9, kind: "assistant", messageId: "m9", text: "Removed node b." } }));
    expect(announcer.textContent).toBe("Claude replied: Removed node b.");
  });

  it("does not carry the draft or the scroll state over to another session", async () => {
    show();
    const user = userEvent.setup();
    const { rerender } = view.render(<Window />);
    const input = screen.getByRole("textbox", { name: "Message Claude" });
    await user.type(input, "draft for s1");
    act(() => chat().setState({ views: { ...chat().getState().views, s2: emptyView() } }));
    rerender(<Window id="s2" />);
    expect((screen.getByRole("textbox", { name: "Message Claude" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the cost in the actions menu and minimises, grows and closes from the header or Esc", async () => {
    show();
    const user = userEvent.setup();
    view.render(<Window />);
    await user.click(screen.getByRole("button", { name: "Chat actions" }));
    expect(await screen.findByText("$0.012")).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open as side panel" }));
    await user.click(screen.getByRole("button", { name: "Close chat" }));
    expect(actions.onToggleExpanded).toHaveBeenCalledTimes(1);
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    screen.getByRole("textbox", { name: "Message Claude" }).focus();
    await user.keyboard("{Escape}");
    expect(actions.onMinimize).toHaveBeenCalledTimes(1);
  });

  it("shows warnings in the status line", () => {
    show();
    view.render(<Window />);
    act(() => handleServerMessage({ type: "chat:status", repoId: TEST_REPO_ID, sessionId: "s1", status: "idle", warning: "promptgraph plugin not found: MCP tools only, no skills" }));
    expect(screen.getByRole("status").textContent).toMatch(/plugin not found/);
  });
});

describe("ChatDock (DESIGN §21.11)", () => {
  beforeEach(() => {
    sent.length = 0;
    setChatDeps({
      send: () => true,
      listSessions: async () => ({ sessions: [chatSessionOf({ id: "s2", title: "Older chat" })] }),
      getSession: async (id) => ({ session: chatSessionOf({ id, title: id === "s2" ? "Older chat" : "" }), items: [], pendingPermissions: [], streaming: [] }),
      createSession: async () => chatSessionOf({ id: "s3", title: "" }),
    });
    clearChatStores();
    view = createTestView({ graphId: null });
    useDaemonStore.setState({ connection: "open" });
  });
  afterEach(cleanup);

  it("opens new chats from the bar, minimises and reopens them, picks old ones from the history and closes them", async () => {
    const user = userEvent.setup();
    view.render(<ChatDock />);
    const bar = screen.getByRole("toolbar", { name: "Chats" });
    await user.click(within(bar).getByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("region", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();

    // The bar button of the open chat minimises it; clicking it again reopens it.
    await user.click(within(bar).getByRole("button", { name: "Minimize chat New chat" }));
    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    await user.click(within(bar).getByRole("button", { name: "Open chat New chat" }));
    expect(screen.getByRole("region", { name: "Chat" })).toBeTruthy();

    await user.click(within(bar).getByRole("button", { name: "Chat history" }));
    await user.click(await screen.findByRole("menuitem", { name: /Older chat/ }));
    expect(await screen.findByRole("heading", { name: "Older chat" })).toBeTruthy();
    expect(within(bar).getAllByRole("button", { name: /^(Open|Minimize) chat/ }).map((b) => b.textContent)).toEqual(["New chat", "Older chat"]);

    await user.click(within(bar).getByRole("button", { name: "Close chat Older chat" }));
    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    expect(within(bar).getAllByRole("button", { name: /^(Open|Minimize) chat/ }).map((b) => b.textContent)).toEqual(["New chat"]);
  });

  it("docks the expanded chat as a side panel next to the tab's panel, and floats it again", async () => {
    localStorage.removeItem("pg.chat.docked");
    const side = document.createElement("div");
    const bottomBar = document.createElement("div");
    document.body.append(side, bottomBar);
    let chats: TabChats | null = null;
    function InTab() {
      const [state, setState] = useState<TabChats | null>(chats);
      chats = state;
      const ctx: TabContextValue = {
        tabId: "t",
        active: true,
        setTitle: () => undefined,
        setGraph: () => undefined,
        close: () => undefined,
        reportEditor: () => undefined,
        chats: state,
        setChats: setState,
        bottomBar,
        bottomBarStart: null,
        sidePanel: side,
      };
      return (
        <TabContext.Provider value={ctx}>
          <div data-testid="panel">
            <ChatDock />
          </div>
        </TabContext.Provider>
      );
    }
    const user = userEvent.setup();
    view.render(<InTab />);
    await user.click(within(bottomBar).getByRole("button", { name: "New chat" }));
    const floating = await screen.findByRole("region", { name: "Chat" });
    expect(screen.getByTestId("panel").contains(floating)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Open as side panel" }));
    const docked = screen.getByRole("region", { name: "Chat" });
    expect(side.contains(docked)).toBe(true);
    expect(screen.getByTestId("panel").contains(docked)).toBe(false);
    expect(screen.getByRole("separator", { name: "Resize chat" })).toBeTruthy();
    expect(localStorage.getItem("pg.chat.docked")).toBe("1");
    await user.click(screen.getByRole("button", { name: "Float over the canvas" }));
    expect(screen.getByTestId("panel").contains(screen.getByRole("region", { name: "Chat" }))).toBe(true);
    side.remove();
    bottomBar.remove();
  });

  it("the shortcut opens a new chat, minimises the open one and reopens the newest", async () => {
    view.render(<ChatDock />);
    act(() => emitChatShortcut());
    expect(await screen.findByRole("region", { name: "Chat" })).toBeTruthy();
    act(() => emitChatShortcut());
    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    act(() => emitChatShortcut());
    expect(screen.getByRole("region", { name: "Chat" })).toBeTruthy();
    expect(chat().getState().sessions.map((x) => x.id)).toContain("s3");
  });
});
