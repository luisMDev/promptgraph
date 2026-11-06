import { isSafeNextPath, normalizePath } from "@promptgraph/shared";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { KeyAction } from "../lib/keymap";
import { parseRoute } from "../lib/router/routes";

/**
 * The in-app tabs of one window (DESIGN §13.4). A tab shows any view of any repository; its path is the
 * source of truth for what it shows. The live set is kept in `sessionStorage` (one window; survives a
 * reload) and mirrored to `localStorage`, which only seeds a window that starts without a session set.
 */
export interface Tab {
  id: string;
  /** Normalised in-app path (`normalizePath`). */
  path: string;
  /** Last title derived for this path (DESIGN §13.4 Titles); dropped when the tab navigates elsewhere. */
  title?: string;
}

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
   * Opens a path: a tab already showing it (after normalisation) is reused; `/r/<repoId>` reuses the most
   * recently used tab of that repository. Returns the tab id.
   */
  open(path: string, opts: OpenTabOptions): string;
  /** Closes a tab (the last one leaves a Home tab); it goes on the closed stack. */
  close(id: string): void;
  activate(id: string): void;
  /** The tab shows another path (duplicates of other tabs are allowed). */
  navigate(id: string, path: string, opts?: { replace?: boolean }): void;
  /** Back/forward re-applies a history entry to its tab and activates it (no new history entry). */
  applyHistory(id: string, path: string): void;
  /** Next (+1) or previous (-1) tab in strip order, wrapping around. */
  next(dir: 1 | -1): void;
  /** Activates the tab at a 0-based strip index, or the last one; out of range does nothing. */
  goto(index: number | "last"): void;
  reopenClosed(): void;
  setTitle(id: string, title: string): void;
}

export type TabsStoreApi = StoreApi<TabsState>;

export const TABS_SESSION_KEY = "pg.tabs.v1";
export const TABS_LAST_KEY = "pg.tabs.last.v1";
export const MAX_TABS = 30;
export const MAX_CLOSED_TABS = 10;
export const HOME_PATH = "/";
export const MAX_TAB_PATH = 2048;
export const MAX_TAB_TITLE = 300;

/**
 * A stored tab. Path and title limits are checked per tab (in `tabPath` and `parsePersistedTabs`), so one
 * bad entry drops that tab or its title, never the whole set.
 */
const TabSchema = z.object({
  id: z.string().min(1).max(64),
  path: z.string(),
  title: z.string().max(MAX_TAB_TITLE).optional().catch(undefined),
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
    tabs.push(t.title === undefined ? { id: t.id, path } : { id: t.id, path, title: t.title });
  }
  if (tabs.length === 0) return null;
  const mru = [...new Set(parsed.data.mru.filter((id) => seen.has(id)))];
  for (const t of tabs) if (!mru.includes(t.id)) mru.push(t.id);
  const activeId = seen.has(parsed.data.activeId) ? parsed.data.activeId : mru[0]!;
  return { tabs, activeId, mru: [activeId, ...mru.filter((id) => id !== activeId)] };
}

function homeSet(): Pick<TabsState, "tabs" | "activeId" | "mru"> {
  const id = newTabId();
  return { tabs: [{ id, path: HOME_PATH }], activeId: id, mru: [id] };
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
        const victim = [...mru].reverse().find((id) => id !== state.activeId && id !== keepId)!;
        const index = tabs.findIndex((t) => t.id === victim);
        closed = pushClosed(closed, tabs[index]!, index);
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
      const tabs = [...s.tabs];
      tabs.splice(at === undefined ? tabs.length : Math.min(Math.max(at, 0), tabs.length), 0, tab);
      const activeId = activate ? id : s.activeId;
      const mru = activate ? [id, ...s.mru] : [...s.mru, id];
      set({ activeId, ...capped({ tabs, activeId, mru, closed: s.closed }, id) });
      return id;
    }

    return {
      ...initial,
      closed: [],
      lastNavigation: null,

      open(rawPath, { activate, dedupe = true }) {
        const path = tabPath(rawPath);
        const s = get();
        if (dedupe) {
          const route = parseRoute(path);
          // In MRU order: of two tabs on the same path (or repository), the one used last wins.
          const byMru = s.mru.map((id) => s.tabs.find((t) => t.id === id)).filter((t): t is Tab => t !== undefined);
          const existing = byMru.find((t) => (route.kind === "repo" ? repoOf(t.path) === route.repoId : t.path === path));
          if (existing) {
            if (activate) get().activate(existing.id);
            return existing.id;
          }
        }
        return add(path, activate);
      },

      close(id) {
        const s = get();
        const index = s.tabs.findIndex((t) => t.id === id);
        if (index === -1) return;
        const closed = pushClosed(s.closed, s.tabs[index]!, index);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const mru = s.mru.filter((x) => x !== id);
        if (tabs.length === 0) {
          const home = homeSet();
          set({ ...home, closed });
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
        const replace = !!navOpts?.replace;
        const tabs = tab.path === path ? s.tabs : s.tabs.map((t) => (t.id === id ? { id, path } : t));
        set({ tabs, lastNavigation: { tabId: id, path, replace } });
      },

      applyHistory(id, rawPath) {
        const path = tabPath(rawPath);
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab) return;
        const tabs = tab.path === path ? s.tabs : s.tabs.map((t) => (t.id === id ? { id, path } : t));
        set({ tabs, activeId: id, mru: touch(s.mru, id) });
      },

      next(dir) {
        const s = get();
        const i = s.tabs.findIndex((t) => t.id === s.activeId);
        const n = s.tabs.length;
        get().activate(s.tabs[(i + dir + n) % n]!.id);
      },

      goto(index) {
        const s = get();
        const tab = index === "last" ? s.tabs.at(-1) : s.tabs[index];
        if (tab) get().activate(tab.id);
      },

      reopenClosed() {
        const s = get();
        const last = s.closed.at(-1);
        if (!last) return;
        set({ closed: s.closed.slice(0, -1) });
        add(last.path, true, last.index, last.title);
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

/** What a tab shortcut does (DESIGN §13.4): "new tab" always adds a Home tab. */
export function runTabAction(store: TabsStoreApi, action: KeyAction): void {
  const s = store.getState();
  switch (action.type) {
    case "newTab":
      s.open(HOME_PATH, { activate: true, dedupe: false });
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
  }
}
