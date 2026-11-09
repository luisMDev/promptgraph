import { describe, expect, it } from "vitest";
import {
  MAX_CLOSED_TABS,
  MAX_TAB_CHATS,
  MAX_TABS,
  PAGE_ID,
  TABS_LAST_KEY,
  TABS_SESSION_KEY,
  activeTab,
  createTabsStore,
  parsePersistedTabs,
  runTabAction,
  stripTabs,
  type TabsStoreApi,
} from "./tabs-store";

/** A Storage over a Map (one per simulated window for sessionStorage, shared for localStorage). */
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  reads: string[] = [];
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    this.reads.push(key);
    return this.data.get(key) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const R = "/r/repo-0123abcd";
const R2 = "/r/repo-9876fedc";
const G1 = "repo-0123abcd/g1";

function windowStores(local = new MemoryStorage()) {
  return { session: new MemoryStorage(), local };
}

/** Every path, the page's first. */
function paths(store: TabsStoreApi): string[] {
  return store.getState().tabs.map((t) => t.path);
}

/** The paths of the strip's tabs (diagrams only). */
function strip(store: TabsStoreApi): string[] {
  return stripTabs(store.getState()).map((t) => t.path);
}

function pagePath(store: TabsStoreApi): string {
  return store.getState().tabs.find((t) => t.id === PAGE_ID)!.path;
}

function activePath(store: TabsStoreApi): string {
  return activeTab(store.getState()).path;
}

describe("tabs store (DESIGN §13.4)", () => {
  it("starts with only the page on Home, then opens a tab for a diagram URL or shows a page URL in the page", () => {
    const fresh = createTabsStore(windowStores());
    expect(fresh.getState().tabs).toEqual([{ id: PAGE_ID, path: "/" }]);
    expect(fresh.getState().activeId).toBe(PAGE_ID);

    const atGraph = createTabsStore({ ...windowStores(), initialPath: `${R}/graphs/g1` });
    expect(paths(atGraph)).toEqual(["/", `${R}/graphs/g1`]);
    expect(activePath(atGraph)).toBe(`${R}/graphs/g1`);
    expect(activeTab(atGraph.getState()).graph).toBe(G1);

    const atRepo = createTabsStore({ ...windowStores(), initialPath: R });
    expect(paths(atRepo)).toEqual([R]);
    expect(atRepo.getState().activeId).toBe(PAGE_ID);
  });

  it("open dedupes on the normalised path; background opens keep the active tab; page paths show in the page", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const a = s().open(`${R}/graphs/g%31/`, { activate: true });
    expect(activePath(store)).toBe(`${R}/graphs/g1`);
    // Same path, other spellings: the same tab.
    expect(s().open(`${R}/graphs/g1`, { activate: false })).toBe(a);
    expect(s().open(`${R}/graphs/%67%31`, { activate: true })).toBe(a);
    expect(strip(store)).toEqual([`${R}/graphs/g1`]);

    const b = s().open(`${R}/runs/r1`, { activate: false });
    expect(s().activeId).toBe(a);
    expect(s().mru).toEqual([a, PAGE_ID, b]);

    // Home and a graph list are never tabs: they show in the page, activated or in the background.
    expect(s().open(R2, { activate: false })).toBe(PAGE_ID);
    expect(pagePath(store)).toBe(R2);
    expect(s().activeId).toBe(a);
    expect(s().open("/", { activate: true, dedupe: false })).toBe(PAGE_ID);
    expect(s().activeId).toBe(PAGE_ID);
    expect(pagePath(store)).toBe("/");
    expect(strip(store)).toEqual([`${R}/graphs/g1`, `${R}/runs/r1`]);
  });

  it("a graph has at most one tab: opening or navigating to it activates its tab, also once a run tab reports it", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const g1 = s().open(`${R}/graphs/g1`, { activate: true });
    const run = s().open(`${R}/runs/r1`, { activate: true });
    // From another tab, the graph's own tab is activated; the navigating tab is left as it was.
    s().navigate(run, `${R}/graphs/g1`);
    expect(s().activeId).toBe(g1);
    expect(s().tabs.find((t) => t.id === run)!.path).toBe(`${R}/runs/r1`);

    // g1's tab moves to one of its runs: it still belongs to g1 (until the view reports otherwise).
    s().navigate(g1, `${R}/runs/r2`);
    expect(s().tabs.find((t) => t.id === g1)!.graph).toBe(G1);
    // Opening the graph again goes back to that tab, shown on the graph.
    expect(s().open(`${R}/graphs/g1`, { activate: true })).toBe(g1);
    expect(activePath(store)).toBe(`${R}/graphs/g1`);

    // A run tab whose view reports g2 is the tab of g2.
    s().setGraph(run, "repo-0123abcd/g2");
    expect(s().open(`${R}/graphs/g2`, { activate: true })).toBe(run);
    expect(activePath(store)).toBe(`${R}/graphs/g2`);
    expect(strip(store)).toHaveLength(2);
    // The page cannot take a graph.
    s().setGraph(PAGE_ID, G1);
    expect(s().tabs[0]!.graph).toBeUndefined();
  });

  it("from the page a diagram opens its tab; from a diagram a page path shows the page, and with replace closes the tab", () => {
    const store = createTabsStore({ ...windowStores(), initialPath: R });
    const s = () => store.getState();
    s().navigate(PAGE_ID, `${R}/graphs/g1`);
    const g1 = s().activeId;
    expect(g1).not.toBe(PAGE_ID);
    expect(strip(store)).toEqual([`${R}/graphs/g1`]);
    expect(pagePath(store)).toBe(R);

    s().navigate(g1, "/");
    expect(s().activeId).toBe(PAGE_ID);
    expect(pagePath(store)).toBe("/");
    expect(strip(store)).toEqual([`${R}/graphs/g1`]);
    expect(s().lastNavigation).toEqual({ tabId: PAGE_ID, path: "/", replace: false });

    // What the tab showed is gone (a deleted graph): the tab closes.
    const g2 = s().open(`${R}/graphs/g2`, { activate: true });
    s().navigate(g2, R, { replace: true });
    expect(strip(store)).toEqual([`${R}/graphs/g1`]);
    expect(s().activeId).toBe(PAGE_ID);
    expect(pagePath(store)).toBe(R);
  });

  it("navigate within a diagram tab drops the stale title and never takes an unsafe path", () => {
    const store = createTabsStore({ ...windowStores(), initialPath: `${R}/graphs/g1` });
    const s = () => store.getState();
    const a = s().activeId;
    s().setTitle(a, "repo · g1");
    s().navigate(a, `${R}/runs/r1`);
    expect(activePath(store)).toBe(`${R}/runs/r1`);
    expect(activeTab(s()).title).toBeUndefined();
    expect(s().lastNavigation).toEqual({ tabId: a, path: `${R}/runs/r1`, replace: false });
    // An unsafe path is Home, which shows in the page.
    s().navigate(a, "//evil.example/x");
    expect(activePath(store)).toBe("/");
    expect(s().activeId).toBe(PAGE_ID);
    expect(strip(store)).toEqual([`${R}/runs/r1`]);
  });

  it("closing the last tab shows its repository's graph list; closing the active one activates its neighbour; the page never closes", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const a = s().open(`${R}/graphs/a`, { activate: false });
    const b = s().open(`${R}/graphs/b`, { activate: true });
    s().activate(a);
    s().close(a);
    expect(s().activeId).toBe(b);
    s().close(b);
    expect(s().activeId).toBe(PAGE_ID);
    expect(paths(store)).toEqual([R]);
    s().close(PAGE_ID);
    expect(paths(store)).toEqual([R]);
  });

  it("reopenClosed restores closed tabs in reverse order, at their strip position, at most 10", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const a = s().open(`${R}/graphs/a`, { activate: true });
    s().setTitle(a, "repo · A");
    s().open(`${R}/graphs/b`, { activate: true });
    s().close(a);
    s().close(activeTab(s()).id);
    expect(strip(store)).toEqual([]);
    s().reopenClosed();
    expect(strip(store)).toEqual([`${R}/graphs/b`]);
    s().reopenClosed();
    expect(strip(store)).toEqual([`${R}/graphs/a`, `${R}/graphs/b`]);
    expect(activeTab(s()).title).toBe("repo · A");
    s().reopenClosed();
    expect(strip(store)).toHaveLength(2);

    for (let i = 0; i < MAX_CLOSED_TABS + 5; i++) s().close(s().open(`${R}/graphs/n${i}`, { activate: true }));
    expect(s().closed).toHaveLength(MAX_CLOSED_TABS);
    expect(s().closed.at(-1)!.path).toBe(`${R}/graphs/n${MAX_CLOSED_TABS + 4}`);
  });

  it("next, goto and the shortcut actions go over the diagram tabs; new tab shows Home in the page", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    for (const g of ["a", "b", "c"]) s().open(`${R}/graphs/${g}`, { activate: false });
    // From the page, next goes to the first tab and previous to the last.
    s().next(-1);
    expect(activePath(store)).toBe(`${R}/graphs/c`);
    s().next(1);
    expect(activePath(store)).toBe(`${R}/graphs/a`);
    s().next(-1);
    expect(activePath(store)).toBe(`${R}/graphs/c`);
    runTabAction(store, { type: "gotoTab", n: 2 });
    expect(activePath(store)).toBe(`${R}/graphs/b`);
    runTabAction(store, { type: "gotoTab", n: 8 });
    expect(activePath(store)).toBe(`${R}/graphs/b`);
    runTabAction(store, { type: "lastTab" });
    expect(activePath(store)).toBe(`${R}/graphs/c`);
    runTabAction(store, { type: "prevTab" });
    expect(activePath(store)).toBe(`${R}/graphs/b`);
    runTabAction(store, { type: "closeTab" });
    expect(strip(store)).toEqual([`${R}/graphs/a`, `${R}/graphs/c`]);
    runTabAction(store, { type: "reopenClosed" });
    expect(activePath(store)).toBe(`${R}/graphs/b`);
    expect(strip(store)).toEqual([`${R}/graphs/a`, `${R}/graphs/b`, `${R}/graphs/c`]);
    runTabAction(store, { type: "newTab" });
    expect(strip(store)).toHaveLength(3);
    expect(s().activeId).toBe(PAGE_ID);
    expect(activePath(store)).toBe("/");
    // Close on the page does nothing.
    runTabAction(store, { type: "closeTab" });
    expect(strip(store)).toHaveLength(3);
  });

  it("keeps at most 30 tabs, never the page, dropping the least recently used onto the closed stack", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    for (let i = 0; i < MAX_TABS; i++) s().open(`${R}/graphs/g${i}`, { activate: true });
    expect(s().tabs).toHaveLength(MAX_TABS);
    expect(s().tabs[0]!.id).toBe(PAGE_ID);
    expect(strip(store)).not.toContain(`${R}/graphs/g0`);
    expect(s().closed.map((c) => c.path)).toEqual([`${R}/graphs/g0`]);
    // It reopens where it was, first in the strip.
    s().reopenClosed();
    expect(strip(store)[0]).toBe(`${R}/graphs/g0`);
  });

  it("at the cap, a background open keeps the new tab and drops the least recently used inactive one", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    for (let i = 1; i < MAX_TABS; i++) s().open(`${R}/graphs/g${i}`, { activate: true });
    expect(s().tabs).toHaveLength(MAX_TABS);
    const active = s().activeId;
    const id = s().open(`${R}/graphs/new`, { activate: false });
    expect(s().tabs).toHaveLength(MAX_TABS);
    expect(s().tabs.some((t) => t.id === id)).toBe(true);
    expect(s().activeId).toBe(active);
    // The page was the least recently used, but it is never dropped: the oldest diagram tab is.
    expect(s().tabs[0]!.id).toBe(PAGE_ID);
    expect(s().closed.map((c) => c.path)).toEqual([`${R}/graphs/g1`]);
  });

  it("caps titles and paths so one long value never invalidates the saved set", () => {
    const w = windowStores();
    const store = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    const s = () => store.getState();
    s().setTitle(s().activeId, "x".repeat(301));
    expect(activeTab(s()).title).toHaveLength(300);
    // A too long path is Home, in the page.
    s().open(`${R}/graphs/${"y".repeat(2100)}`, { activate: false });
    expect(paths(store)).toEqual(["/", `${R}/graphs/g1`]);

    const reloaded = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    expect(paths(reloaded)).toEqual(["/", `${R}/graphs/g1`]);
    expect(activeTab(reloaded.getState()).title).toHaveLength(300);

    // A stored set written before the caps: the bad title and the bad tab are dropped, the rest is kept.
    const raw = { version: 1, tabs: [{ id: "a", path: "/", title: "z".repeat(301) }, { id: "b", path: `/${"y".repeat(2100)}` }, { id: "c", path: `${R}/graphs/g1`, title: "ok" }], activeId: "c", mru: ["c", "b", "a"] };
    expect(parsePersistedTabs(JSON.stringify(raw))).toEqual({
      tabs: [
        { id: PAGE_ID, path: "/" },
        { id: "c", path: `${R}/graphs/g1`, title: "ok", graph: G1 },
      ],
      activeId: "c",
      mru: ["c", PAGE_ID],
    });
  });

  it("migrates a set saved before the page: the most recently used Home or repository tab becomes the page", () => {
    const raw = {
      version: 1,
      tabs: [
        { id: "h", path: "/", title: "Home" },
        { id: "g", path: `${R}/graphs/g1` },
        { id: "r", path: R2, title: "other" },
        { id: "run", path: `${R}/runs/r1`, graph: G1 },
      ],
      activeId: "r",
      mru: ["r", "g", "h", "run"],
    };
    expect(parsePersistedTabs(JSON.stringify(raw))).toEqual({
      tabs: [
        { id: PAGE_ID, path: R2, title: "other" },
        { id: "g", path: `${R}/graphs/g1`, graph: G1 },
        { id: "run", path: `${R}/runs/r1`, graph: G1 },
      ],
      activeId: PAGE_ID,
      mru: [PAGE_ID, "g", "run"],
    });
    // A stored graph of another repository than the tab's path is dropped.
    const foreign = { version: 1, tabs: [{ id: "run", path: `${R}/runs/r1`, graph: "repo-9876fedc/x" }], activeId: "run", mru: ["run"] };
    expect(parsePersistedTabs(JSON.stringify(foreign))?.tabs).toEqual([
      { id: PAGE_ID, path: "/" },
      { id: "run", path: `${R}/runs/r1` },
    ]);
  });

  it("persists to sessionStorage, mirrors to localStorage, and restores the round trip", () => {
    const w = windowStores();
    const store = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    const s = () => store.getState();
    s().setTitle(s().activeId, "repo · First");
    s().open(`${R}/runs/r1`, { activate: false });
    const session = JSON.parse(w.session.getItem(TABS_SESSION_KEY)!);
    expect(session).toEqual({ version: 1, tabs: s().tabs, activeId: s().activeId, mru: s().mru });
    expect(w.local.getItem(TABS_LAST_KEY)).toBe(w.session.getItem(TABS_SESSION_KEY));

    // A reload (the URL is the active tab's).
    const reloaded = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    expect(reloaded.getState().tabs).toEqual(s().tabs);
    expect(reloaded.getState().activeId).toBe(s().activeId);
    expect(reloaded.getState().mru).toEqual(s().mru);
    expect(activeTab(reloaded.getState()).title).toBe("repo · First");
  });

  it("a reload keeps the active tab when two tabs show the same path; open picks the most recently used one", () => {
    const w = windowStores();
    const store = createTabsStore({ ...w, initialPath: `${R}/graphs/build` });
    const s = () => store.getState();
    const a = s().activeId;
    const b = s().open(`${R}/graphs/build`, { activate: true, dedupe: false });
    expect(b).not.toBe(a);
    expect(s().activeId).toBe(b);

    const reloaded = createTabsStore({ ...w, initialPath: `${R}/graphs/build` });
    expect(reloaded.getState().activeId).toBe(b);
    expect(reloaded.getState().tabs).toEqual(s().tabs);

    // Another tab active: opening the shared path goes to the duplicate used last (b), not the first one.
    reloaded.getState().open("/", { activate: true });
    reloaded.getState().activate(a);
    reloaded.getState().activate(b);
    reloaded.getState().open("/", { activate: true });
    expect(reloaded.getState().open(`${R}/graphs/build`, { activate: true })).toBe(b);
  });

  it("corrupt storage gives just the page on Home; bad entries are dropped one by one", () => {
    const corrupt = ["{", JSON.stringify({ version: 2, tabs: [], activeId: "x", mru: [] }), JSON.stringify({ version: 1, tabs: [], activeId: "x", mru: [] })];
    const dup = { version: 1, tabs: [{ id: "a", path: "/" }, { id: "a", path: "/x" }], activeId: "a", mru: ["a"] };
    const foreign = { version: 1, tabs: [{ id: "a", path: "https://evil.example/" }], activeId: "a", mru: ["a"] };
    const tooMany = { version: 1, tabs: Array.from({ length: MAX_TABS + 1 }, (_, i) => ({ id: `t${i}`, path: `/x${i}` })), activeId: "t0", mru: [] };
    for (const raw of [...corrupt, JSON.stringify(dup), JSON.stringify(foreign), JSON.stringify(tooMany)]) {
      const w = windowStores();
      w.session.setItem(TABS_SESSION_KEY, raw);
      const store = createTabsStore(w);
      expect(store.getState().tabs).toEqual([{ id: PAGE_ID, path: "/" }]);
      expect(store.getState().activeId).toBe(PAGE_ID);
    }
    // Repairable: a missing active id and an incomplete MRU list.
    expect(parsePersistedTabs(JSON.stringify({ version: 1, tabs: [{ id: "a", path: "/x/" }, { id: "b", path: "/" }], activeId: "gone", mru: ["b", "zz"] }))).toEqual({
      tabs: [
        { id: PAGE_ID, path: "/" },
        { id: "a", path: "/x" },
      ],
      activeId: PAGE_ID,
      mru: [PAGE_ID, "a"],
    });
  });

  it("sessionStorage is per window: a new window is seeded from localStorage, which is never read again", () => {
    const local = new MemoryStorage();
    const w1 = windowStores(local);
    const one = createTabsStore({ ...w1, initialPath: `${R}/graphs/g1` });
    one.getState().open(`${R}/runs/r1`, { activate: false });

    // A second window starts without a session tab set: seeded with the first window's set.
    const w2 = windowStores(local);
    const two = createTabsStore({ ...w2, initialPath: `${R2}/graphs/x` });
    expect(paths(two)).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`, `${R2}/graphs/x`]);
    local.reads = [];
    two.getState().close(two.getState().tabs[1]!.id);
    two.getState().close(two.getState().tabs[1]!.id);
    expect(local.reads).toEqual([]);

    // Both reload in turn: each gets its own set back, whoever wrote localStorage last.
    const oneReloaded = createTabsStore({ ...w1, initialPath: `${R}/graphs/g1` });
    expect(paths(oneReloaded)).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`]);
    const twoReloaded = createTabsStore({ ...w2, initialPath: `${R2}/graphs/x` });
    expect(paths(twoReloaded)).toEqual(["/", `${R2}/graphs/x`]);
    const oneAgain = createTabsStore({ ...w1, initialPath: `${R}/graphs/g1` });
    expect(paths(oneAgain)).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`]);
    // The last writer seeds the next new window.
    expect(paths(createTabsStore(windowStores(local)))).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`]);
  });

  it("moves a tab to another strip position, keeping the active tab and the page first, and persists the order", () => {
    const stores = windowStores();
    const store = createTabsStore(stores);
    store.getState().open(`${R}/graphs/g1`, { activate: true });
    store.getState().open(`${R}/runs/r1`, { activate: false });
    const [, graphTab, runTab] = store.getState().tabs;

    store.getState().move(runTab!.id, 0);
    expect(paths(store)).toEqual(["/", `${R}/runs/r1`, `${R}/graphs/g1`]);
    expect(activePath(store)).toBe(`${R}/graphs/g1`);

    // Clamped; the page, unknown ids and no-op moves change nothing.
    store.getState().move(runTab!.id, 99);
    expect(paths(store)).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`]);
    const before = store.getState().tabs;
    store.getState().move(PAGE_ID, 1);
    store.getState().move(graphTab!.id, 0);
    store.getState().move("nope", 0);
    expect(store.getState().tabs).toBe(before);

    expect(paths(createTabsStore({ session: stores.session, local: null }))).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`]);
  });
});

describe("tab chats (DESIGN §21.11)", () => {
  const REPO = "repo-0123abcd";

  it("are persisted with the tab, kept while it stays in their repository and dropped when it leaves", () => {
    const w = windowStores();
    const store = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    const id = store.getState().activeId;
    store.getState().setChats(id, { repoId: REPO, ids: ["c1", "c2", "c1"], open: "c2" });
    expect(activeTab(store.getState()).chats).toEqual({ repoId: REPO, ids: ["c1", "c2"], open: "c2" });

    // A new window of the same session restores them.
    const again = createTabsStore({ session: w.session, local: new MemoryStorage() });
    expect(activeTab(again.getState()).chats).toEqual({ repoId: REPO, ids: ["c1", "c2"], open: "c2" });

    store.getState().navigate(id, `${R}/runs/r1`);
    expect(activeTab(store.getState()).chats?.ids).toEqual(["c1", "c2"]);
    store.getState().navigate(id, `${R2}/graphs/g2`);
    expect(activeTab(store.getState()).chats).toBeUndefined();
  });

  it("keep the newest MAX_TAB_CHATS, an open chat that is in the bar, and nothing for an empty bar", () => {
    const store = createTabsStore({ ...windowStores(), initialPath: R });
    const id = store.getState().activeId;
    expect(id).toBe(PAGE_ID);
    const ids = Array.from({ length: MAX_TAB_CHATS + 2 }, (_, i) => `c${i}`);
    store.getState().setChats(id, { repoId: REPO, ids, open: "gone" });
    expect(activeTab(store.getState()).chats).toEqual({ repoId: REPO, ids: ids.slice(2), open: null });
    store.getState().setChats(id, { repoId: REPO, ids: [], open: null });
    expect(activeTab(store.getState()).chats).toBeUndefined();
  });

  it("drops stored chats of another repository than the tab's path, and invalid ones", () => {
    const tabs = (chats: unknown) => JSON.stringify({ version: 1, tabs: [{ id: "a", path: `${R}/graphs/g1`, chats }], activeId: "a", mru: ["a"] });
    const tabA = (raw: string) => parsePersistedTabs(raw)?.tabs.find((t) => t.id === "a");
    expect(tabA(tabs({ repoId: "repo-9876fedc", ids: ["c1"], open: null }))?.chats).toBeUndefined();
    expect(tabA(tabs({ repoId: REPO, ids: "nope" }))).toEqual({ id: "a", path: `${R}/graphs/g1`, graph: G1 });
    expect(tabA(tabs({ repoId: REPO, ids: ["c1"], open: "c1" }))?.chats).toEqual({ repoId: REPO, ids: ["c1"], open: "c1" });
  });
});
