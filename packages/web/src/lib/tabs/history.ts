import { activeTab, type TabNavigation, type TabsStoreApi } from "../../store/tabs-store";

/** A window history entry of the tabbed app (DESIGN §13.2). */
export interface TabHistoryState {
  tabId: string;
  path: string;
}

export interface TabHistoryWindow {
  history: Pick<History, "pushState" | "replaceState">;
  location: Pick<Location, "pathname" | "search" | "hash">;
  addEventListener(type: "popstate", listener: (ev: PopStateEvent) => void): void;
  removeEventListener(type: "popstate", listener: (ev: PopStateEvent) => void): void;
}

function isTabHistoryState(v: unknown): v is TabHistoryState {
  return typeof v === "object" && v !== null && typeof (v as TabHistoryState).tabId === "string" && typeof (v as TabHistoryState).path === "string";
}

function same(a: TabHistoryState | null, b: TabHistoryState): boolean {
  return !!a && a.tabId === b.tabId && a.path === b.path;
}

/**
 * Keeps the window URL on the active tab (DESIGN §13.2): a navigation inside the active tab pushes
 * `{tabId, path}` (or replaces it when asked), anything else that changes the active tab or its path
 * (switching, closing, opening in the foreground) replaces the current entry. Back/forward re-applies the
 * entry to its tab and activates it; an entry whose tab was closed is skipped by putting the active tab's
 * path back with `replaceState`, so it never changes another tab. Returns teardown.
 */
export function syncTabHistory(store: TabsStoreApi, win: TabHistoryWindow): () => void {
  const target = (): TabHistoryState => {
    const tab = activeTab(store.getState());
    return { tabId: tab.id, path: tab.path };
  };
  let synced: TabHistoryState = target();
  win.history.replaceState(synced, "", synced.path);
  let lastNavigation: TabNavigation | null = store.getState().lastNavigation;

  const unsubscribe = store.subscribe((s) => {
    const next = target();
    const nav = s.lastNavigation;
    if (nav !== lastNavigation) {
      lastNavigation = nav;
      if (nav && !nav.replace && nav.tabId === next.tabId && nav.path === next.path && !same(synced, next)) {
        win.history.pushState(next, "", next.path);
        synced = next;
        return;
      }
    }
    if (!same(synced, next)) {
      win.history.replaceState(next, "", next.path);
      synced = next;
    }
  });

  const onPop = (ev: PopStateEvent) => {
    const state: unknown = ev.state;
    const s = store.getState();
    if (isTabHistoryState(state) && s.tabs.some((t) => t.id === state.tabId)) {
      synced = { tabId: state.tabId, path: state.path };
      s.applyHistory(state.tabId, state.path);
      // applyHistory normalises; keep the entry in step if it changed anything.
      const now = target();
      if (!same(synced, now)) {
        win.history.replaceState(now, "", now.path);
        synced = now;
      }
      return;
    }
    if (isTabHistoryState(state)) {
      // Its tab was closed: skip the entry.
      synced = target();
      win.history.replaceState(synced, "", synced.path);
      return;
    }
    // An entry this app did not write (a typed URL fragment, an entry from before the page loaded).
    const { pathname, search, hash } = win.location;
    synced = { tabId: "", path: "" };
    s.open(pathname + search + hash, { activate: true });
    const now = target();
    if (!same(synced, now)) {
      win.history.replaceState(now, "", now.path);
      synced = now;
    }
  };
  win.addEventListener("popstate", onPop);
  return () => {
    unsubscribe();
    win.removeEventListener("popstate", onPop);
  };
}
