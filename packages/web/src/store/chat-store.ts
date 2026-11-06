import type {
  ChatContext,
  ChatItem,
  ChatPermissionRequestItem,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatStatus,
  ClientMessage,
  CreateChatSessionRequest,
  ServerMessage,
} from "@promptgraph/shared";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { errorMessage, repoApi } from "../api/rest";
import { wsClient } from "../api/ws";

/**
 * In-app Claude Code chat (DESIGN §21), one store per repository (each repository has its own sessions): session
 * list, the items of the sessions opened in the panel, streamed text and the pending permission prompts. Items come
 * from GET /api/repos/:repoId/chat/sessions/:id and then from chat:* WS messages of that repository.
 */

/** One session as shown in the panel. */
export interface ChatSessionView {
  items: ChatItem[];
  /** messageId → text streamed so far (chat:delta); dropped when the final assistant item arrives. */
  streaming: Record<string, string>;
  /**
   * messageId → offset of the first character held in `streaming` (0 unless the beginning was missed, e.g. deltas
   * that arrived before the session was opened). A message that does not start at 0 is not shown as text yet.
   */
  streamingStart: Record<string, number>;
  /** Order in which streamed messages started, so they render in arrival order. */
  streamingOrder: string[];
  /** Permission prompts Claude is waiting on, oldest first (parallel tool calls may open several). */
  pendingPermissions: ChatPermissionRequestItem[];
  status: ChatStatus;
  warning: string | null;
  /** The detail is being fetched; live items received meanwhile are merged into the response. */
  loading: boolean;
  loadError: string | null;
  /** A live status (chat:status / chat:session / an optimistic send) arrived since the last fetch started: it wins over the fetched one. */
  liveStatus: boolean;
}

export interface ChatState {
  sessions: ChatSessionSummary[];
  sessionsLoaded: boolean;
  activeSessionId: string | null;
  views: Record<string, ChatSessionView>;
  /** Error of the last session-level action (list, create, delete). */
  error: string | null;
}

export interface ChatStore extends ChatState {
  repoId: string;
  loadSessions(): Promise<void>;
  /** Shows a session (fetching its detail once), or none. */
  selectSession(id: string | null): Promise<void>;
  /** Creates a session and shows it. Returns its id, or null on failure. */
  newSession(req?: CreateChatSessionRequest): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
  /** Sends a user turn on the WS. Returns false when it could not be sent (socket down). */
  send(sessionId: string, text: string, context: ChatContext): boolean;
  interrupt(sessionId: string): void;
  answerPermission(sessionId: string, requestId: string, allow: boolean, message?: string): void;
  /**
   * After a WS reconnect: reloads the list and the shown session (items may have been missed); drops other views.
   * The shown view stays on screen meanwhile, so the conversation, its permission card and Stop do not disappear.
   */
  resync(): Promise<void>;
  /** Routes a chat:* server message of this repository; other messages are ignored. */
  applyServerMessage(msg: ServerMessage): void;
}

export interface ChatDeps {
  listSessions(): Promise<{ sessions: ChatSessionSummary[] }>;
  createSession(req: CreateChatSessionRequest): Promise<ChatSessionSummary>;
  getSession(id: string): Promise<ChatSessionDetail>;
  deleteSession(id: string): Promise<void>;
  /** Sends a client message; returns false when the socket is not connected. */
  send(msg: ClientMessage): boolean;
}

/** The repository's REST routes and the page's socket. */
export function repoChatDeps(repoId: string): ChatDeps {
  const api = repoApi(repoId);
  return {
    listSessions: () => api.listChatSessions(),
    createSession: (req) => api.createChatSession(req),
    getSession: (id) => api.getChatSession(id),
    deleteSession: (id) => api.deleteChatSession(id),
    send: (msg) => {
      if (!wsClient.isOpen()) return false;
      wsClient.send(msg);
      return true;
    },
  };
}

let depsOverride: Partial<ChatDeps> = {};

/** Test seam: overrides the deps of the stores created from now on. */
export function setChatDeps(d: Partial<ChatDeps>): void {
  depsOverride = { ...depsOverride, ...d };
}

function lastSessionKey(repoId: string): string {
  return `pg_last_chat:${repoId}`;
}

function rememberSession(repoId: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(lastSessionKey(repoId), id);
    else localStorage.removeItem(lastSessionKey(repoId));
  } catch {
    // Per-browser convenience only.
  }
}

/** The session last shown in this repository's chat panel (per browser). */
export function lastChatSessionId(repoId: string): string | null {
  try {
    return localStorage.getItem(lastSessionKey(repoId));
  } catch {
    return null;
  }
}

export function emptyView(status: ChatStatus = "idle"): ChatSessionView {
  return {
    items: [],
    streaming: {},
    streamingStart: {},
    streamingOrder: [],
    pendingPermissions: [],
    status,
    warning: null,
    loading: false,
    loadError: null,
    liveStatus: false,
  };
}

/** Statuses during which a permission prompt can stay open. */
function keepsPermissions(status: ChatStatus): boolean {
  return status === "waiting_permission" || status === "thinking";
}

function dropStreaming(view: ChatSessionView, messageId: string): ChatSessionView {
  if (!(messageId in view.streaming)) return view;
  const { [messageId]: _text, ...streaming } = view.streaming;
  const { [messageId]: _start, ...streamingStart } = view.streamingStart;
  return { ...view, streaming, streamingStart, streamingOrder: view.streamingOrder.filter((m) => m !== messageId) };
}

/** Most recently updated first. */
function sortSessions(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsertSession(sessions: ChatSessionSummary[], session: ChatSessionSummary): ChatSessionSummary[] {
  return sortSessions([...sessions.filter((s) => s.id !== session.id), session]);
}

/** Appends an item (ignoring a duplicate id) and updates the derived streaming / permission state. Pure. */
export function applyItem(view: ChatSessionView, item: ChatItem): ChatSessionView {
  if (view.items.some((i) => i.id === item.id)) return view;
  let next: ChatSessionView = { ...view, items: [...view.items, item] };
  switch (item.kind) {
    case "assistant":
      return dropStreaming(next, item.messageId);
    case "permission_request":
      return next.pendingPermissions.some((p) => p.requestId === item.requestId) ? next : { ...next, pendingPermissions: [...next.pendingPermissions, item] };
    case "permission_resolved":
      return { ...next, pendingPermissions: next.pendingPermissions.filter((p) => p.requestId !== item.requestId) };
    case "result":
      // A turn ended: any text that never got its final item is stale.
      return { ...next, streaming: {}, streamingStart: {}, streamingOrder: [] };
    default:
      return next;
  }
}

/**
 * Adds a streamed chunk that starts at `offset` in the message's text. Overlapping chunks (the same text seen in a
 * fetched detail and as a live delta) are joined without duplicating characters. Without `offset` the chunk is
 * appended. Pure.
 */
export function applyDelta(view: ChatSessionView, messageId: string, text: string, offset?: number): ChatSessionView {
  // A late delta of a message whose final item is already shown must not resurrect it.
  if (view.items.some((i) => i.kind === "assistant" && i.messageId === messageId)) return view;
  const cur = view.streaming[messageId];
  if (cur === undefined) {
    return {
      ...view,
      streaming: { ...view.streaming, [messageId]: text },
      streamingStart: { ...view.streamingStart, [messageId]: offset ?? 0 },
      streamingOrder: [...view.streamingOrder, messageId],
    };
  }
  const start = view.streamingStart[messageId] ?? 0;
  const end = start + cur.length;
  if (offset === undefined) return { ...view, streaming: { ...view.streaming, [messageId]: cur + text } };
  if (offset < start) {
    // The chunk covers text before what is held (e.g. the fetched beginning of the message).
    if (offset + text.length < start) return view;
    const joined = text + cur.slice(Math.max(0, offset + text.length - start));
    return { ...view, streaming: { ...view.streaming, [messageId]: joined }, streamingStart: { ...view.streamingStart, [messageId]: offset } };
  }
  const added = offset <= end ? text.slice(end - offset) : text;
  if (!added) return view;
  return { ...view, streaming: { ...view.streaming, [messageId]: cur + added } };
}

/** Builds the view of a fetched detail, keeping live items, deltas and status that arrived while it was in flight. */
export function mergeDetail(detail: ChatSessionDetail, live: ChatSessionView | undefined): ChatSessionView {
  // An answered prompt may still be listed as pending if the resolution is among the items.
  const resolved = new Set(detail.items.flatMap((i) => (i.kind === "permission_resolved" ? [i.requestId] : [])));
  let view: ChatSessionView = {
    ...emptyView(detail.session.status),
    items: detail.items,
    pendingPermissions: detail.pendingPermissions.filter((p) => !resolved.has(p.requestId)),
    warning: live?.warning ?? null,
  };
  for (const s of detail.streaming) view = applyDelta(view, s.messageId, s.text, 0);
  if (!live) return view;
  for (const item of live.items) view = applyItem(view, item);
  for (const id of live.streamingOrder) view = applyDelta(view, id, live.streaming[id] ?? "", live.streamingStart[id] ?? 0);
  // A status received while loading is at least as recent as the snapshot (also a live "idle").
  if (live.liveStatus) view = { ...view, status: live.status, pendingPermissions: keepsPermissions(live.status) ? view.pendingPermissions : [] };
  return view;
}

export type ChatStoreApi = StoreApi<ChatStore>;

/** The chat store of one repository (not cached: use getChatStore). */
export function createChatStore(repoId: string, deps: ChatDeps = { ...repoChatDeps(repoId), ...depsOverride }): ChatStoreApi {
  return createStore<ChatStore>()((set, get) => {
  function patchView(sessionId: string, fn: (v: ChatSessionView) => ChatSessionView): void {
    const views = get().views;
    const cur = views[sessionId];
    if (!cur) return;
    const next = fn(cur);
    if (next !== cur) set({ views: { ...views, [sessionId]: next } });
  }

  function setStatus(sessionId: string, status: ChatStatus, warning?: string): void {
    patchView(sessionId, (v) => {
      // A turn that ended (or a process that died) without a resolution item takes its prompts with it.
      const pendingPermissions = keepsPermissions(status) ? v.pendingPermissions : [];
      return { ...v, status, pendingPermissions, warning: warning ?? v.warning, liveStatus: true };
    });
    const s = get().sessions.find((x) => x.id === sessionId);
    if (s && s.status !== status) set({ sessions: get().sessions.map((x) => (x.id === sessionId ? { ...x, status } : x)) });
  }

  async function fetchDetail(id: string): Promise<void> {
    set({ views: { ...get().views, [id]: { ...(get().views[id] ?? emptyView()), loading: true, loadError: null, liveStatus: false } } });
    try {
      const detail = await deps.getSession(id);
      const live = get().views[id];
      if (!live) return; // deleted meanwhile
      set({ views: { ...get().views, [id]: mergeDetail(detail, live) }, sessions: upsertSession(get().sessions, detail.session) });
    } catch (err) {
      patchView(id, (v) => ({ ...v, loading: false, loadError: errorMessage(err) }));
    }
  }

  return {
    repoId,
    sessions: [],
    sessionsLoaded: false,
    activeSessionId: null,
    views: {},
    error: null,

    async loadSessions() {
      try {
        const { sessions } = await deps.listSessions();
        set({ sessions: sortSessions(sessions), sessionsLoaded: true, error: null });
      } catch (err) {
        set({ sessionsLoaded: true, error: `Could not load chats: ${errorMessage(err)}` });
      }
    },

    async selectSession(id) {
      set({ activeSessionId: id });
      rememberSession(repoId, id);
      if (!id) return;
      const view = get().views[id];
      if (!view || view.loadError) await fetchDetail(id);
    },

    async newSession(req = {}) {
      try {
        const session = await deps.createSession(req);
        set({
          sessions: upsertSession(get().sessions, session),
          views: { ...get().views, [session.id]: emptyView(session.status) },
          activeSessionId: session.id,
          error: null,
        });
        rememberSession(repoId, session.id);
        return session.id;
      } catch (err) {
        set({ error: `Could not start a chat: ${errorMessage(err)}` });
        return null;
      }
    },

    async deleteSession(id) {
      try {
        await deps.deleteSession(id);
      } catch (err) {
        set({ error: `Could not delete the chat: ${errorMessage(err)}` });
        return;
      }
      removeLocal(id);
    },

    send(sessionId, text, context) {
      const ok = deps.send({ type: "chat:send", repoId, sessionId, text, context });
      // Optimistic: the server confirms with chat:status (starting → thinking) right away.
      if (ok) patchView(sessionId, (v) => (v.status === "idle" || v.status === "exited" || v.status === "error" ? { ...v, status: "thinking", liveStatus: true } : v));
      return ok;
    },

    interrupt(sessionId) {
      deps.send({ type: "chat:interrupt", repoId, sessionId });
    },

    answerPermission(sessionId, requestId, allow, message) {
      const ok = deps.send({ type: "chat:permission", repoId, sessionId, requestId, allow, ...(message ? { message } : {}) });
      // The card disappears at once (the next prompt, if any, shows); the server's permission_resolved item records the answer.
      if (ok) {
        patchView(sessionId, (v) => {
          if (!v.pendingPermissions.some((p) => p.requestId === requestId)) return v;
          const pendingPermissions = v.pendingPermissions.filter((p) => p.requestId !== requestId);
          return { ...v, pendingPermissions, status: pendingPermissions.length > 0 ? "waiting_permission" : "thinking" };
        });
      }
    },

    async resync() {
      if (!get().sessionsLoaded) return;
      // Keep the shown view (marked loading) so live messages still apply and the panel does not blank out.
      const shown = get().activeSessionId;
      const kept = shown ? get().views[shown] : undefined;
      set({ views: shown && kept ? { [shown]: { ...kept, loading: true, loadError: null, liveStatus: false } } : {} });
      await get().loadSessions();
      // The user may have picked another session meanwhile.
      const active = get().activeSessionId;
      if (!active) return;
      if (get().sessions.some((x) => x.id === active)) await fetchDetail(active);
      else removeLocal(active);
    },

    applyServerMessage(msg) {
      if (!("repoId" in msg) || msg.repoId !== repoId) return;
      switch (msg.type) {
        case "chat:item":
          patchView(msg.sessionId, (v) => applyItem(v, msg.item));
          return;
        case "chat:delta":
          patchView(msg.sessionId, (v) => applyDelta(v, msg.messageId, msg.text, msg.offset));
          return;
        case "chat:status":
          setStatus(msg.sessionId, msg.status, msg.warning);
          return;
        case "chat:session":
          set({ sessions: upsertSession(get().sessions, msg.session) });
          if (get().views[msg.session.id] && get().views[msg.session.id]!.status !== msg.session.status) setStatus(msg.session.id, msg.session.status);
          return;
        case "chat:deleted":
          removeLocal(msg.sessionId);
          return;
        default:
          return;
      }
    },
  };

  function removeLocal(id: string): void {
    const s = get();
    const { [id]: _gone, ...views } = s.views;
    const sessions = s.sessions.filter((x) => x.id !== id);
    const activeSessionId = s.activeSessionId === id ? null : s.activeSessionId;
    set({ sessions, views, activeSessionId });
    if (s.activeSessionId === id) rememberSession(repoId, null);
  }
  });
}

// --- One store per repository ---------------------------------------------------------------------------

const stores = new Map<string, ChatStoreApi>();

/** The chat store of a repository, created on first use. */
export function getChatStore(repoId: string): ChatStoreApi {
  let store = stores.get(repoId);
  if (!store) {
    store = createChatStore(repoId);
    stores.set(repoId, store);
  }
  return store;
}

/** The store if something already created it. */
export function peekChatStore(repoId: string): ChatStoreApi | undefined {
  return stores.get(repoId);
}

/** `repo:removed`: forgets the repository's chat state. */
export function dropChatStore(repoId: string): void {
  stores.delete(repoId);
}

export function liveChatStores(): ChatStoreApi[] {
  return [...stores.values()];
}

/** Tests: forgets every store. */
export function clearChatStores(): void {
  stores.clear();
}

export function useRepoChat<T>(repoId: string, selector: (s: ChatStore) => T): T {
  return useStore(getChatStore(repoId), selector);
}

/** Total cost of a session in USD, formatted for the panel ("$0.042"). */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** True while Claude is working on a turn (the Stop button is shown). */
export function isBusy(status: ChatStatus): boolean {
  return status === "starting" || status === "thinking" || status === "waiting_permission";
}
