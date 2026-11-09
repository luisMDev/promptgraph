import { isSafeNextPath, normalizePath } from "@promptgraph/shared";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { emitChatShortcut } from "../lib/chat-shortcut";
import type { KeyAction } from "../lib/keymap";
import { parseRoute } from "../lib/router/routes";

/**
 * The in-app tabs of one window (DESIGN §13.4). Tabs are for diagrams: a graph and its runs, steps and reports, at
 * most one tab per graph. Home and a repository's graph list are not tabs: they show in the **page** (`PAGE_ID`, kept
 * first in `tabs` and never shown in the strip), which the sidebar navigates. A tab's path is the source of truth for
 * what it shows. The live set is kept in `sessionStorage` (one window; survives a reload) and mirrored to
 * `localStorage`, which only seeds a window that starts without a session set.
 */
export interface Tab {
  id: string;
  /** Normalised in-app path (`normalizePath`). */
  path: string;
  /** Last title derived for this path (DESIGN §13.4 Titles); dropped when the tab navigates elsewhere. */
  title?: string;
  /** The tab's chat windows (DESIGN §21.11); dropped when the tab leaves their repository. */
  chats?: TabChats;
  /** The graph the tab shows (`graphKey`): from a graph route, or reported by the view of a run route. */
  graph?: string;
}

/** Chats opened in a tab, in bottom-bar order, and the one whose window is open (null: all minimised). */
export interface TabChats {
  repoId: string;
  ids: string[];
  open: string | null;
}

/** At most this many chats in a tab's bottom bar; opening one more drops the oldest. */
export const MAX_TAB_CHATS = 8;

/** A closed tab, for "reopen closed tab". */
export interface ClosedTab {
  path: string;
  title?: string;
  /** Position it had in the strip. */
  index: number;
}

export interface OpenTabOptions {
  /** Foreground (activate it) or background. */
  activate: boolean;
  /**
   * Reuse a tab that already shows the path (default). "+" and the new-tab shortcut pass false: they
   * always add a tab.
   */
  dedupe?: boolean;
}

/** The latest `navigate` (transient, not persisted): history sync pushes or replaces from it. */
export interface TabNavigation {
  tabId: string;
  path: string;
  replace: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string;
  /** Tab ids, most recently used first. */
  mru: string[];
  /** Closed tabs, most recent last (at most MAX_CLOSED_TABS). */
  closed: ClosedTab[];
  lastNavigation: TabNavigation | null;

  /**
   * Opens a path. Home and `/r/<repoId>` show in the page; a diagram path reuses the tab of its graph (or one already
   * showing the path), navigated to it. Returns the tab id.
   */
  open(path: string, opts: OpenTabOptions): string;
  /** Closes a diagram tab (the page cannot be closed); it goes on the closed stack. The last one shows its repository's graph list in the page. */
  close(id: string): void;
  activate(id: string): void;
  /**
   * The tab shows another path. A page path from a diagram tab shows in the page instead (with `replace`, the tab is
   * closed: what it showed is gone); a diagram path from the page opens its tab; a graph another tab shows activates
   * that tab.
   */
  navigate(id: string, path: string, opts?: { replace?: boolean }): void;
  /** Back/forward re-applies a history entry to its tab and activates it (no new history entry). */
  applyHistory(id: string, path: string): void;
  /** Next (+1) or previous (-1) diagram tab in strip order, wrapping around. */
  next(dir: 1 | -1): void;
  /** Activates the diagram tab at a 0-based strip index, or the last one; out of range does nothing. */
  goto(index: number | "last"): void;
  reopenClosed(): void;
  setTitle(id: string, title: string): void;
  /** Moves a diagram tab to a 0-based strip index (clamped); the active tab and the MRU order do not change. */
  move(id: string, index: number): void;
  /** The view of a run route reports the run's graph (`graphKey`), so the graph keeps one tab. */
  setGraph(id: string, graph: string | null): void;
  /** Replaces a tab's chats (null or no ids: none). */
  setChats(id: string, chats: TabChats | null): void;
}

export type TabsStoreApi = StoreApi<TabsState>;

export const TABS_SESSION_KEY = "pg.tabs.v1";
export const TABS_LAST_KEY = "pg.tabs.last.v1";
export const MAX_TABS = 30;
export const MAX_CLOSED_TABS = 10;
export const HOME_PATH = "/";
/** The page: Home or a repository's graph list, never a tab of the strip. */
export const PAGE_ID = "page";
export const MAX_TAB_PATH = 2048;
export const MAX_TAB_TITLE = 300;

/**
 * A stored tab. Path and title limits are checked per tab (in `tabPath` and `parsePersistedTabs`), so one
 * bad entry drops that tab or its title, never the whole set.
 */
const TabChatsSchema = z.object({
  repoId: z.string().min(1).max(200),
  ids: z.array(z.string().min(1).max(200)).max(MAX_TAB_CHATS),
  open: z.string().nullable(),
});

const TabSchema = z.object({
  id: z.string().min(1).max(64),
  path: z.string(),
  title: z.string().max(MAX_TAB_TITLE).optional().catch(undefined),
  chats: TabChatsSchema.optional().catch(undefined),
  graph: z.string().max(500).optional().catch(undefined),
});

/** What both storages hold: `{version: 1, tabs, activeId, mru}`. */
const PersistedTabsSchema = z.object({
  version: z.literal(1),
  tabs: z.array(TabSchema).min(1).max(MAX_TABS),
  activeId: z.string(),
  mru: z.array(z.string()),
});
export type PersistedTabs = z.infer<typeof PersistedTabsSchema>;

/** An in-app path, normalised; anything else (another origin, `//host`, control characters, too long) is Home. */
export function tabPath(path: string): string {
  if (path.length > MAX_TAB_PATH || !isSafeNextPath(path)) return HOME_PATH;
  const normalized = normalizePath(path);
  return normalized.length > MAX_TAB_PATH ? HOME_PATH : normalized;
}

/** Home and a repository's graph list show in the page; everything else (diagrams, not found) in a tab. */
export function isPagePath(path: string): boolean {
  const kind = parseRoute(path).kind;
  return kind === "home" || kind === "repo";
}

/** The graph a graph route shows (`<repoId>/<graphId>`), else null. */
export function graphKeyOf(path: string): string | null {
  const route = parseRoute(path);
  return route.kind === "graph" ? graphKey(route.repoId, route.graphId) : null;
}

export function graphKey(repoId: string, graphId: string): string {
  return `${repoId}/${graphId}`;
}

/** Titles come from user data (graph names, node labels) of any length: what a tab keeps is capped. */
function capTitle(title: string): string {
  return title.slice(0, MAX_TAB_TITLE);
}

let idCounter = 0;
function newTabId(): string {
  idCounter += 1;
  return `t${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Parses and repairs a stored tab set; null when absent or invalid (the caller falls back). */
export function parsePersistedTabs(raw: string | null): Pick<TabsState, "tabs" | "activeId" | "mru"> | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PersistedTabsSchema.safeParse(json);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of parsed.data.tabs) {
    // A duplicate id, or a path that is not a safe in-app path, drops that tab only.
    if (seen.has(t.id) || t.path.length > MAX_TAB_PATH || !isSafeNextPath(t.path)) continue;
    const path = normalizePath(t.path);
    if (path.length > MAX_TAB_PATH) continue;
    seen.add(t.id);
    const tab: Tab = t.title === undefined ? { id: t.id, path } : { id: t.id, path, title: t.title };
    const chats = t.chats && repoOf(path) === t.chats.repoId ? normalizeChats(t.chats) : null;
    if (chats) tab.chats = chats;
    const graph = graphKeyOf(path) ?? (t.graph && repoOf(path) === t.graph.split("/")[0] ? t.graph : undefined);
    if (graph) tab.graph = graph;
    tabs.push(tab);
  }
  if (tabs.length === 0) return null;
  const mru = [...new Set(parsed.data.mru.filter((id) => seen.has(id)))];
  for (const t of tabs) if (!mru.includes(t.id)) mru.push(t.id);
  const activeId = seen.has(parsed.data.activeId) ? parsed.data.activeId : mru[0]!;
  return withPage(tabs, activeId, [activeId, ...mru.filter((id) => id !== activeId)]);
}

/**
 * Puts the page first, made from the stored page or (sets saved before the page existed) the most recently used
 * Home or repository tab, which are dropped; every other tab is a diagram tab.
 */
function withPage(all: Tab[], activeId: string, mru: string[]): Pick<TabsState, "tabs" | "activeId" | "mru"> {
  const pageLike = (t: Tab) => t.id === PAGE_ID || isPagePath(t.path);
  const stored = all.find((t) => t.id === PAGE_ID && isPagePath(t.path));
  const recent = mru.map((id) => all.find((t) => t.id === id)).find((t): t is Tab => !!t && pageLike(t));
  const source = stored ?? recent;
  const page: Tab = source ? { ...source, id: PAGE_ID } : { id: PAGE_ID, path: HOME_PATH };
  if (!isPagePath(page.path)) page.path = HOME_PATH;
  delete page.graph;
  const tabs = [page, ...all.filter((t) => !pageLike(t))];
  const ids = new Set(tabs.map((t) => t.id));
  const active = ids.has(activeId) ? activeId : all.find((t) => t.id === activeId && pageLike(t)) ? PAGE_ID : (mru.find((id) => ids.has(id)) ?? PAGE_ID);
  const order = [...new Set(mru.map((id) => (ids.has(id) ? id : all.find((t) => t.id === id && pageLike(t)) ? PAGE_ID : null)).filter((id): id is string => id !== null))];
  for (const t of tabs) if (!order.includes(t.id)) order.push(t.id);
  return { tabs, activeId: active, mru: [active, ...order.filter((id) => id !== active)] };
}

/** Unique ids, at most MAX_TAB_CHATS (the newest), `open` one of them; null when there is none. */
function normalizeChats(chats: TabChats): TabChats | null {
  const ids = [...new Set(chats.ids)].slice(-MAX_TAB_CHATS);
  if (ids.length === 0) return null;
  return { repoId: chats.repoId, ids, open: chats.open !== null && ids.includes(chats.open) ? chats.open : null };
}

/**
 * A tab moved to `path`: the title is dropped, the chats kept while it stays in their repository, the graph taken
 * from a graph route (else kept while it stays in its repository, until the view reports it).
 */
function retarget(tab: Tab, path: string): Tab {
  const next: Tab = { id: tab.id, path };
  if (tab.chats && repoOf(path) === tab.chats.repoId) next.chats = tab.chats;
  if (tab.id !== PAGE_ID) {
    const graph = graphKeyOf(path) ?? (tab.graph && repoOf(path) === tab.graph.split("/")[0] ? tab.graph : undefined);
    if (graph) next.graph = graph;
  }
  return next;
}

function homeSet(): Pick<TabsState, "tabs" | "activeId" | "mru"> {
  return { tabs: [{ id: PAGE_ID, path: HOME_PATH }], activeId: PAGE_ID, mru: [PAGE_ID] };
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage full or disabled: the tabs still work for this page.
  }
}

export interface CreateTabsStoreOptions {
  /** This window's storage (`sessionStorage`). */
  session: Storage | null;
  /** Shared by every window of the origin (`localStorage`); read once, here, and only as a seed. */
  local: Storage | null;
  /** The window's URL at start: a tab for it is opened or activated. */
  initialPath?: string;
}

/** The repository of a path, when it is a repository route. */
function repoOf(path: string): string | null {
  const route = parseRoute(path);
  return "repoId" in route ? route.repoId : null;
}

/** Moves `id` to the front of the MRU list. */
function touch(mru: string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

export function createTabsStore(opts: CreateTabsStoreOptions): TabsStoreApi {
  const initial = parsePersistedTabs(read(opts.session, TABS_SESSION_KEY)) ?? parsePersistedTabs(read(opts.local, TABS_LAST_KEY)) ?? homeSet();

  const store = createStore<TabsState>()((set, get) => {
    /**
     * Drops the least recently used tabs beyond MAX_TABS onto the closed stack: never the active one, nor
     * `keepId` (the tab being added, which a background open puts last in the MRU list).
     */
    function capped(state: Pick<TabsState, "tabs" | "activeId" | "mru" | "closed">, keepId: string): Pick<TabsState, "tabs" | "mru" | "closed"> {
      let { tabs, mru, closed } = state;
      while (tabs.length > MAX_TABS) {
        const victim = [...mru].reverse().find((id) => id !== state.activeId && id !== keepId && id !== PAGE_ID)!;
        const index = tabs.findIndex((t) => t.id === victim);
        // The closed stack keeps strip indices (the page, first, is not in the strip).
        closed = pushClosed(closed, tabs[index]!, index - 1);
        tabs = tabs.filter((t) => t.id !== victim);
        mru = mru.filter((id) => id !== victim);
      }
      return { tabs, mru, closed };
    }

    function pushClosed(closed: ClosedTab[], tab: Tab, index: number): ClosedTab[] {
      const entry: ClosedTab = tab.title === undefined ? { path: tab.path, index } : { path: tab.path, title: tab.title, index };
      return [...closed, entry].slice(-MAX_CLOSED_TABS);
    }

    function add(path: string, activate: boolean, at?: number, title?: string): string {
      const s = get();
      const id = newTabId();
      const tab: Tab = title === undefined ? { id, path } : { id, path, title: capTitle(title) };
      const graph = graphKeyOf(path);
      if (graph) tab.graph = graph;
      const tabs = [...s.tabs];
      // `at` is a strip index; the page stays first.
      tabs.splice(at === undefined ? tabs.length : Math.min(Math.max(at + 1, 1), tabs.length), 0, tab);
      const activeId = activate ? id : s.activeId;
      const mru = activate ? [id, ...s.mru] : [...s.mru, id];
      set({ activeId, ...capped({ tabs, activeId, mru, closed: s.closed }, id) });
      return id;
    }

    /** The page shows `path` (Home or a graph list), activated or not. */
    function showPage(path: string, activate: boolean): void {
      const s = get();
      const page = s.tabs.find((t) => t.id === PAGE_ID)!;
      const tabs = page.path === path ? s.tabs : s.tabs.map((t) => (t.id === PAGE_ID ? retarget(t, path) : t));
      set({ tabs, lastNavigation: { tabId: PAGE_ID, path, replace: false } });
      if (activate) get().activate(PAGE_ID);
    }

    return {
      ...initial,
      closed: [],
      lastNavigation: null,

      open(rawPath, { activate, dedupe = true }) {
        const path = tabPath(rawPath);
        if (isPagePath(path)) {
          showPage(path, activate);
          return PAGE_ID;
        }
        const s = get();
        if (dedupe) {
          const graph = graphKeyOf(path);
          // In MRU order: of two tabs of the same graph (or path), the one used last wins.
          const byMru = s.mru.map((id) => s.tabs.find((t) => t.id === id)).filter((t): t is Tab => t !== undefined && t.id !== PAGE_ID);
          const existing = byMru.find((t) => t.path === path) ?? (graph ? byMru.find((t) => t.graph === graph) : undefined);
          if (existing) {
            if (existing.path !== path) set({ tabs: get().tabs.map((t) => (t.id === existing.id ? retarget(t, path) : t)), lastNavigation: { tabId: existing.id, path, replace: false } });
            if (activate) get().activate(existing.id);
            return existing.id;
          }
        }
        return add(path, activate);
      },

      close(id) {
        const s = get();
        const index = s.tabs.findIndex((t) => t.id === id);
        if (index === -1 || id === PAGE_ID) return;
        const tab = s.tabs[index]!;
        const closed = pushClosed(s.closed, tab, index - 1);
        let tabs = s.tabs.filter((t) => t.id !== id);
        const mru = s.mru.filter((x) => x !== id);
        if (tabs.length === 1) {
          // The last diagram tab: the page shows its repository's graph list.
          const repoId = repoOf(tab.path);
          if (repoId) tabs = tabs.map((t) => (t.id === PAGE_ID ? retarget(t, `/r/${encodeURIComponent(repoId)}`) : t));
          set({ tabs, closed, activeId: PAGE_ID, mru: touch(mru, PAGE_ID) });
          return;
        }
        // Closing the active tab activates its right neighbour (else the left one), as browsers do.
        const activeId = s.activeId === id ? tabs[Math.min(index, tabs.length - 1)]!.id : s.activeId;
        set({ tabs, closed, activeId, mru: touch(mru, activeId) });
      },

      activate(id) {
        const s = get();
        if (!s.tabs.some((t) => t.id === id)) return;
        if (s.activeId === id && s.mru[0] === id) return;
        set({ activeId: id, mru: touch(s.mru, id) });
      },

      navigate(id, rawPath, navOpts) {
        const path = tabPath(rawPath);
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return;
        if (id === PAGE_ID && !isPagePath(path)) {
          // A diagram from the page (Home, a graph list): its tab.
          get().open(path, { activate: true });
          return;
        }
        if (id !== PAGE_ID && isPagePath(path)) {
          // Home or a graph list from a diagram: the page. A replace means what the tab showed is gone (a deleted graph).
          if (navOpts?.replace) get().close(id);
          showPage(path, true);
          return;
        }
        const graph = graphKeyOf(path);
        const other = graph ? s.tabs.find((t) => t.id !== id && t.id !== PAGE_ID && t.graph === graph) : undefined;
        if (other) {
          // The graph already has a tab: go there.
          get().open(path, { activate: true });
          return;
        }
        const replace = !!navOpts?.replace;
        const tabs = tab.path === path ? s.tabs : s.tabs.map((t) => (t.id === id ? retarget(t, path) : t));
        set({ tabs, lastNavigation: { tabId: id, path, replace } });
      },

      applyHistory(id, rawPath) {
        const path = tabPath(rawPath);
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return;
        const tabs = tab.path === path ? s.tabs : s.tabs.map((t) => (t.id === id ? retarget(t, path) : t));
        set({ tabs, activeId: id, mru: touch(s.mru, id) });
      },

      next(dir) {
        const strip = stripTabs(get());
        if (strip.length === 0) return;
        const i = strip.findIndex((t) => t.id === get().activeId);
        const n = strip.length;
        // From the page, +1 goes to the first tab and -1 to the last.
        get().activate(strip[i === -1 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n]!.id);
      },

      goto(index) {
        const strip = stripTabs(get());
        const tab = index === "last" ? strip.at(-1) : strip[index];
        if (tab) get().activate(tab.id);
      },

      reopenClosed() {
        const s = get();
        const last = s.closed.at(-1);
        if (!last) return;
        set({ closed: s.closed.slice(0, -1) });
        add(last.path, true, last.index, last.title);
      },

      move(id, index) {
        const s = get();
        const from = s.tabs.findIndex((t) => t.id === id);
        if (from < 1) return;
        // `index` is a strip index; the page stays first.
        const to = Math.min(Math.max(Math.trunc(index) + 1, 1), s.tabs.length - 1);
        if (to === from) return;
        const tabs = s.tabs.filter((t) => t.id !== id);
        tabs.splice(to, 0, s.tabs[from]!);
        set({ tabs });
      },

      setGraph(id, graph) {
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab || id === PAGE_ID || (tab.graph ?? null) === graph) return;
        set({
          tabs: s.tabs.map((t) => {
            if (t.id !== id) return t;
            const { graph: _old, ...rest } = t;
            return graph ? { ...rest, graph } : rest;
          }),
        });
      },

      setChats(id, chats) {
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return;
        const next = chats ? normalizeChats(chats) : null;
        if (JSON.stringify(tab.chats ?? null) === JSON.stringify(next)) return;
        set({
          tabs: s.tabs.map((t) => {
            if (t.id !== id) return t;
            const { chats: _old, ...rest } = t;
            return next ? { ...rest, chats: next } : rest;
          }),
        });
      },

      setTitle(id, title) {
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        const next = capTitle(title);
        if (!tab || tab.title === next) return;
        set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: next } : t)) });
      },
    };
  });

  // A reload restores the window's tabs: the URL is already the active tab's unless it was changed by hand.
  if (opts.initialPath !== undefined) {
    const s = store.getState();
    if (s.tabs.find((t) => t.id === s.activeId)?.path !== tabPath(opts.initialPath)) s.open(opts.initialPath, { activate: true });
  }

  // Every change is saved to this window's session and mirrored as the seed of the next new window.
  let saved = "";
  const persist = (s: TabsState) => {
    const value: PersistedTabs = { version: 1, tabs: s.tabs, activeId: s.activeId, mru: s.mru };
    const json = JSON.stringify(value);
    if (json === saved) return;
    saved = json;
    write(opts.session, TABS_SESSION_KEY, json);
    write(opts.local, TABS_LAST_KEY, json);
  };
  persist(store.getState());
  store.subscribe(persist);
  return store;
}

/** The tabs of the strip: every diagram tab, in order (the page is not one). */
export function stripTabs(s: Pick<TabsState, "tabs">): Tab[] {
  return s.tabs.filter((t) => t.id !== PAGE_ID);
}

export function activeTab(s: Pick<TabsState, "tabs" | "activeId">): Tab {
  return s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]!;
}

let pageStore: TabsStoreApi | null = null;

function storage(kind: "sessionStorage" | "localStorage"): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

/** The page's tab store, created on first use from the window's storages and URL. */
export function tabsStore(): TabsStoreApi {
  if (!pageStore) {
    const { pathname, search, hash } = window.location;
    pageStore = createTabsStore({ session: storage("sessionStorage"), local: storage("localStorage"), initialPath: pathname + search + hash });
  }
  return pageStore;
}

/** Tests: replaces (or with null, forgets) the page's tab store. */
export function setTabsStore(store: TabsStoreApi | null): void {
  pageStore = store;
}

export function useTabs<T>(selector: (s: TabsState) => T): T {
  return useStore(tabsStore(), selector);
}

/** What a tab shortcut does (DESIGN §13.4): "new tab" shows Home in the page. */
export function runTabAction(store: TabsStoreApi, action: KeyAction): void {
  const s = store.getState();
  switch (action.type) {
    case "newTab":
      s.open(HOME_PATH, { activate: true });
      return;
    case "closeTab":
      s.close(s.activeId);
      return;
    case "reopenClosed":
      s.reopenClosed();
      return;
    case "nextTab":
      s.next(1);
      return;
    case "prevTab":
      s.next(-1);
      return;
    case "gotoTab":
      s.goto(action.n - 1);
      return;
    case "lastTab":
      s.goto("last");
      return;
    case "toggleChat":
      emitChatShortcut();
      return;
  }
}
