import type { ChatItem, ChatSessionDetail, ClientMessage } from "@promptgraph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatSessionOf } from "../test-fixtures";
import { handleServerMessage } from "./app-actions";
import { applyDelta, applyItem, emptyView, formatCost, mergeDetail, setChatDeps, useChatStore } from "./chat-store";

const sessionOf = chatSessionOf;

const user = (id: string, text: string): ChatItem => ({ id, ts: 1, kind: "user", text });
const assistant = (id: string, messageId: string, text: string): ChatItem => ({ id, ts: 1, kind: "assistant", messageId, text });
const permission: ChatItem = { id: "p1", ts: 1, kind: "permission_request", requestId: "r1", toolName: "mcp__plugin_promptgraph_promptgraph__delete_graph", input: { graphId: "g1" } };
const permission2: ChatItem = { id: "p2", ts: 2, kind: "permission_request", requestId: "r2", toolName: "Write", input: { file_path: "b" } };

function detailOf(extra: Partial<ChatSessionDetail> = {}): ChatSessionDetail {
  return { session: sessionOf({ id: "s1" }), items: [], pendingPermissions: [], streaming: [], ...extra };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("chat view reducers", () => {
  it("streams deltas and replaces them with the final assistant item", () => {
    let v = applyDelta(emptyView(), "m1", "Hel");
    v = applyDelta(v, "m1", "lo");
    v = applyDelta(v, "m2", "Second");
    expect(v.streaming).toEqual({ m1: "Hello", m2: "Second" });
    expect(v.streamingOrder).toEqual(["m1", "m2"]);
    v = applyItem(v, assistant("a1", "m1", "Hello!"));
    expect(v.streaming).toEqual({ m2: "Second" });
    expect(v.streamingOrder).toEqual(["m2"]);
    // A late delta of a finished message is ignored.
    expect(applyDelta(v, "m1", "x")).toBe(v);
  });

  it("ignores duplicate items and tracks the pending permission", () => {
    let v = applyItem(emptyView(), user("u1", "hi"));
    expect(applyItem(v, user("u1", "hi"))).toBe(v);
    v = applyItem(v, permission);
    expect(v.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    v = applyItem(v, { id: "p2", ts: 2, kind: "permission_resolved", requestId: "r1", allowed: false, by: "user" });
    expect(v.pendingPermissions).toEqual([]);
  });

  it("clears stale streamed text at the end of a turn", () => {
    let v = applyDelta(emptyView("thinking"), "m1", "partial");
    v = applyItem(v, { id: "r", ts: 2, kind: "result", subtype: "error_during_execution", isError: true });
    expect(v.streamingOrder).toEqual([]);
  });

  it("merges live items received while the detail was loading", () => {
    const detail = detailOf({ session: sessionOf({ id: "s1", status: "thinking" }), items: [user("u1", "hi")] });
    let live = applyItem({ ...emptyView(), loading: true }, user("u1", "hi"));
    live = applyItem(live, assistant("a1", "m1", "hello"));
    live = applyDelta(live, "m2", "more");
    const v = mergeDetail(detail, live);
    expect(v.items.map((i) => i.id)).toEqual(["u1", "a1"]);
    expect(v.streaming).toEqual({ m2: "more" });
    expect(v.loading).toBe(false);
    expect(v.status).toBe("thinking");
  });

  it("joins overlapping deltas by offset: no duplicate or missing text", () => {
    let v = applyDelta(emptyView(), "m1", "Hello", 0);
    v = applyDelta(v, "m1", "lo world", 3);
    expect(v.streaming.m1).toBe("Hello world");
    // A chunk entirely seen already changes nothing.
    expect(applyDelta(v, "m1", "world", 6)).toBe(v);
    // Deltas that started mid-message are held from their offset until the beginning is known.
    let late = applyDelta(emptyView(), "m2", "the commit node.", 40);
    expect(late.streamingStart.m2).toBe(40);
    late = applyDelta(late, "m2", "x".repeat(40) + "the", 0);
    expect(late).toMatchObject({ streaming: { m2: `${"x".repeat(40)}the commit node.` }, streamingStart: { m2: 0 } });
  });

  it("merges the partial text of the detail with live deltas received while loading", () => {
    // The panel was opened mid-stream: the view only saw the deltas after offset 6.
    const live = applyDelta({ ...emptyView(), loading: true }, "m1", "world, and more", 6);
    const v = mergeDetail(detailOf({ streaming: [{ messageId: "m1", text: "Hello world" }] }), live);
    expect(v.streaming.m1).toBe("Hello world, and more");
    expect(v.streamingStart.m1).toBe(0);
  });

  it("a live status received while loading wins over the detail's, also idle", () => {
    const detail = detailOf({ session: sessionOf({ id: "s1", status: "thinking" }) });
    expect(mergeDetail(detail, { ...emptyView("idle"), loading: true }).status).toBe("thinking");
    expect(mergeDetail(detail, { ...emptyView("idle"), loading: true, liveStatus: true }).status).toBe("idle");
  });

  it("keeps every pending permission, oldest first", () => {
    let v = applyItem(emptyView("waiting_permission"), permission);
    v = applyItem(v, permission2);
    expect(v.pendingPermissions.map((p) => p.requestId)).toEqual(["r1", "r2"]);
    const merged = mergeDetail(detailOf({ session: sessionOf({ id: "s1", status: "waiting_permission" }), pendingPermissions: [permission as never, permission2 as never] }), undefined);
    expect(merged.pendingPermissions.map((p) => p.requestId)).toEqual(["r1", "r2"]);
  });

  it("formats costs", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.123)).toBe("$0.123");
    expect(formatCost(2.5)).toBe("$2.50");
  });
});

describe("chat store", () => {
  const sent: ClientMessage[] = [];
  const getSession = vi.fn(async (id: string): Promise<ChatSessionDetail> => detailOf({ session: sessionOf({ id }), items: [user("u1", "hi")] }));
  const createSession = vi.fn(async () => sessionOf({ id: "new", updatedAt: 99 }));
  const deleteSession = vi.fn(async () => undefined);
  let connected = true;

  beforeEach(() => {
    sent.length = 0;
    connected = true;
    getSession.mockClear();
    createSession.mockClear();
    deleteSession.mockClear();
    setChatDeps({
      listSessions: async () => ({ sessions: [sessionOf({ id: "old", updatedAt: 1 }), sessionOf({ id: "recent", updatedAt: 5 })] }),
      getSession,
      createSession,
      deleteSession,
      send: (msg) => {
        if (connected) sent.push(msg);
        return connected;
      },
    });
    useChatStore.setState({ sessions: [], sessionsLoaded: false, activeSessionId: null, views: {}, error: null });
  });

  it("lists sessions most recent first and loads a session's detail once", async () => {
    await useChatStore.getState().loadSessions();
    expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual(["recent", "old"]);
    await useChatStore.getState().selectSession("old");
    await useChatStore.getState().selectSession("recent");
    await useChatStore.getState().selectSession("old");
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().views.old?.items).toHaveLength(1);
  });

  it("creates a session, sends with the context and answers permissions on the socket", async () => {
    const id = await useChatStore.getState().newSession();
    expect(id).toBe("new");
    expect(useChatStore.getState().activeSessionId).toBe("new");
    const ctx = { graphId: "g1", selectedNodeIds: ["a"], selectedEdgeIds: [], runId: null, readOnly: false };
    expect(useChatStore.getState().send("new", "hi", ctx)).toBe(true);
    expect(useChatStore.getState().views.new?.status).toBe("thinking");

    handleServerMessage({ type: "chat:item", sessionId: "new", item: permission });
    handleServerMessage({ type: "chat:status", sessionId: "new", status: "waiting_permission" });
    expect(useChatStore.getState().views.new?.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    useChatStore.getState().answerPermission("new", "r1", true);
    useChatStore.getState().interrupt("new");
    expect(sent).toEqual([
      { type: "chat:send", sessionId: "new", text: "hi", context: ctx },
      { type: "chat:permission", sessionId: "new", requestId: "r1", allow: true },
      { type: "chat:interrupt", sessionId: "new" },
    ]);
    expect(useChatStore.getState().views.new?.pendingPermissions).toEqual([]);
  });

  it("reports a send while disconnected", async () => {
    await useChatStore.getState().newSession();
    connected = false;
    expect(useChatStore.getState().send("new", "hi", { graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: null, readOnly: true })).toBe(false);
    expect(useChatStore.getState().views.new?.status).toBe("idle");
  });

  it("routes chat:* WS messages: deltas, status, sessions and deletion", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("old");
    handleServerMessage({ type: "chat:delta", sessionId: "old", messageId: "m1", text: "Hi", offset: 0 });
    handleServerMessage({ type: "chat:status", sessionId: "old", status: "thinking", warning: "no skills" });
    // Messages for sessions not opened in the panel only update the list.
    handleServerMessage({ type: "chat:delta", sessionId: "recent", messageId: "m9", text: "x", offset: 0 });
    let s = useChatStore.getState();
    expect(s.views.old).toMatchObject({ streaming: { m1: "Hi" }, status: "thinking", warning: "no skills" });
    expect(s.views.recent).toBeUndefined();
    expect(s.sessions.find((x) => x.id === "old")?.status).toBe("thinking");

    handleServerMessage({ type: "chat:session", session: sessionOf({ id: "old", title: "Landing page", updatedAt: 10, totalCostUsd: 0.2 }) });
    s = useChatStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(["old", "recent"]);
    expect(s.sessions[0]?.title).toBe("Landing page");

    handleServerMessage({ type: "chat:deleted", sessionId: "old" });
    s = useChatStore.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.views.old).toBeUndefined();
    expect(s.sessions.map((x) => x.id)).toEqual(["recent"]);
  });

  it("drops the permission card when the turn ends without a resolution", async () => {
    await useChatStore.getState().newSession();
    handleServerMessage({ type: "chat:item", sessionId: "new", item: permission });
    handleServerMessage({ type: "chat:status", sessionId: "new", status: "exited" });
    expect(useChatStore.getState().views.new?.pendingPermissions).toEqual([]);
  });

  it("deletes a session through the API", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("recent");
    await useChatStore.getState().deleteSession("recent");
    expect(deleteSession).toHaveBeenCalledWith("recent");
    expect(useChatStore.getState().activeSessionId).toBeNull();
  });

  it("resyncs the shown session after a reconnect", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("old");
    await useChatStore.getState().selectSession("recent");
    await useChatStore.getState().resync();
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(Object.keys(useChatStore.getState().views)).toEqual(["recent"]);
  });

  it("answers concurrent permission prompts one at a time", async () => {
    await useChatStore.getState().newSession();
    handleServerMessage({ type: "chat:item", sessionId: "new", item: permission });
    handleServerMessage({ type: "chat:item", sessionId: "new", item: permission2 });
    handleServerMessage({ type: "chat:status", sessionId: "new", status: "waiting_permission" });
    useChatStore.getState().answerPermission("new", "r2", true);
    let v = useChatStore.getState().views.new!;
    expect(v.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    expect(v.status).toBe("waiting_permission");
    // The server confirms: r1 is still open.
    handleServerMessage({ type: "chat:status", sessionId: "new", status: "waiting_permission" });
    expect(useChatStore.getState().views.new!.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
    useChatStore.getState().answerPermission("new", "r1", false);
    v = useChatStore.getState().views.new!;
    expect(v).toMatchObject({ pendingPermissions: [], status: "thinking" });
  });

  it("a turn that ends while the detail is in flight does not leave the panel busy", async () => {
    await useChatStore.getState().loadSessions();
    const pending = deferred<ChatSessionDetail>();
    getSession.mockImplementationOnce(() => pending.promise);
    const selecting = useChatStore.getState().selectSession("old");
    // The server built the detail while thinking; the end of the turn arrives on the WS first.
    handleServerMessage({ type: "chat:item", sessionId: "old", item: { id: "res", ts: 3, kind: "result", subtype: "success", isError: false } });
    handleServerMessage({ type: "chat:status", sessionId: "old", status: "idle" });
    pending.resolve(detailOf({ session: sessionOf({ id: "old", status: "thinking" }), items: [user("u1", "hi")] }));
    await selecting;
    const v = useChatStore.getState().views.old!;
    expect(v.status).toBe("idle");
    expect(v.items.map((i) => i.id)).toEqual(["u1", "res"]);
  });

  it("keeps the shown conversation on screen during a resync and applies live messages meanwhile", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("old");
    handleServerMessage({ type: "chat:item", sessionId: "old", item: permission });
    handleServerMessage({ type: "chat:status", sessionId: "old", status: "waiting_permission" });
    const list = deferred<{ sessions: ReturnType<typeof sessionOf>[] }>();
    setChatDeps({ listSessions: () => list.promise });
    const resyncing = useChatStore.getState().resync();
    let v = useChatStore.getState().views.old!;
    expect(v).toMatchObject({ loading: true, status: "waiting_permission" });
    expect(v.items.map((i) => i.id)).toEqual(["u1", "p1"]);
    expect(v.pendingPermissions).toHaveLength(1);
    handleServerMessage({ type: "chat:delta", sessionId: "old", messageId: "m1", text: "Hi", offset: 0 });
    expect(useChatStore.getState().views.old!.streaming.m1).toBe("Hi");
    getSession.mockImplementationOnce(async () =>
      detailOf({
        session: sessionOf({ id: "old", status: "waiting_permission" }),
        items: [user("u1", "hi"), permission],
        pendingPermissions: [permission as never],
        streaming: [{ messageId: "m1", text: "Hi there" }],
      }),
    );
    list.resolve({ sessions: [sessionOf({ id: "old", updatedAt: 1 })] });
    await resyncing;
    v = useChatStore.getState().views.old!;
    expect(v).toMatchObject({ loading: false, status: "waiting_permission", streaming: { m1: "Hi there" } });
    expect(v.pendingPermissions.map((p) => p.requestId)).toEqual(["r1"]);
  });

  it("resyncs the session picked during the reconnect, not the one shown before", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("old");
    const list = deferred<{ sessions: ReturnType<typeof sessionOf>[] }>();
    setChatDeps({ listSessions: () => list.promise });
    const resyncing = useChatStore.getState().resync();
    void useChatStore.getState().selectSession("recent");
    getSession.mockClear();
    list.resolve({ sessions: [sessionOf({ id: "old", updatedAt: 1 }), sessionOf({ id: "recent", updatedAt: 5 })] });
    await resyncing;
    expect(useChatStore.getState().activeSessionId).toBe("recent");
    expect(getSession.mock.calls.map((c) => c[0])).toContain("recent");
    expect(getSession.mock.calls.map((c) => c[0])).not.toContain("old");
  });
});
