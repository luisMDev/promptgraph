import { describe, expect, it } from "vitest";
import { MAX_CLOSED_TABS, MAX_TABS, TABS_LAST_KEY, TABS_SESSION_KEY, activeTab, createTabsStore, parsePersistedTabs, runTabAction, type TabsStoreApi } from "./tabs-store";

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

function windowStores(local = new MemoryStorage()) {
  return { session: new MemoryStorage(), local };
}

function paths(store: TabsStoreApi): string[] {
  return store.getState().tabs.map((t) => t.path);
}

function activePath(store: TabsStoreApi): string {
  return activeTab(store.getState()).path;
}

describe("tabs store (DESIGN §13.4)", () => {
  it("starts with one Home tab, then opens or activates a tab for the window URL", () => {
    const fresh = createTabsStore(windowStores());
    expect(paths(fresh)).toEqual(["/"]);

    const atGraph = createTabsStore({ ...windowStores(), initialPath: `${R}/graphs/g1` });
    expect(paths(atGraph)).toEqual(["/", `${R}/graphs/g1`]);
    expect(activePath(atGraph)).toBe(`${R}/graphs/g1`);
  });

  it("open dedupes on the normalised path; background opens keep the active tab", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const a = s().open(`${R}/graphs/g%31/`, { activate: true });
    expect(activePath(store)).toBe(`${R}/graphs/g1`);
    // Same path, other spellings: the same tab.
    expect(s().open(`${R}/graphs/g1`, { activate: false })).toBe(a);
    expect(s().open(`${R}/graphs/%67%31`, { activate: true })).toBe(a);
    expect(paths(store)).toEqual(["/", `${R}/graphs/g1`]);

    const b = s().open(`${R}/runs/r1`, { activate: false });
    expect(s().activeId).toBe(a);
    expect(s().mru).toEqual([a, expect.any(String), b]);
    // "+" adds a Home tab even though one exists.
    s().open("/", { activate: true, dedupe: false });
    expect(paths(store)).toEqual(["/", `${R}/graphs/g1`, `${R}/runs/r1`, "/"]);
  });

  it("open('/r/<id>') activates the most recently used tab of that repository", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const g1 = s().open(`${R}/graphs/g1`, { activate: true });
    const run = s().open(`${R}/runs/r1`, { activate: true });
    s().open(`${R2}/graphs/x`, { activate: true });
    expect(s().open(R, { activate: true })).toBe(run);
    expect(s().activeId).toBe(run);
    s().activate(g1);
    s().activate(s().tabs[0]!.id);
    expect(s().open(R, { activate: true })).toBe(g1);
    // A repository without a tab gets one.
    const other = s().open("/r/repo-55555555", { activate: true });
    expect(activeTab(s()).id).toBe(other);
    expect(activePath(store)).toBe("/r/repo-55555555");
  });

  it("navigate may create duplicates and drops the stale title", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const a = s().open(`${R}/graphs/g1`, { activate: true });
    const home = s().tabs[0]!.id;
    s().setTitle(home, "Home");
    s().navigate(home, `${R}/graphs/g1`);
    expect(paths(store)).toEqual([`${R}/graphs/g1`, `${R}/graphs/g1`]);
    expect(s().tabs[0]!.title).toBeUndefined();
    expect(s().lastNavigation).toEqual({ tabId: home, path: `${R}/graphs/g1`, replace: false });
    expect(s().activeId).toBe(a);
    // Unsafe paths never become a tab's path.
    s().navigate(home, "//evil.example/x");
    expect(s().tabs[0]!.path).toBe("/");
  });

  it("closing the last tab leaves a Home tab; closing the active one activates its neighbour", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const [home] = s().tabs;
    const a = s().open(`${R}/graphs/a`, { activate: false });
    const b = s().open(`${R}/graphs/b`, { activate: true });
    s().activate(a);
    s().close(a);
    expect(s().activeId).toBe(b);
    s().close(b);
    expect(s().activeId).toBe(home!.id);
    s().close(home!.id);
    expect(paths(store)).toEqual(["/"]);
    expect(s().tabs[0]!.id).not.toBe(home!.id);
  });

  it("reopenClosed restores closed tabs in reverse order, at their position, at most 10", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    const a = s().open(`${R}/graphs/a`, { activate: true });
    s().setTitle(a, "repo · A");
    s().open(`${R}/graphs/b`, { activate: true });
    s().close(a);
    s().close(activeTab(s()).id);
    expect(paths(store)).toEqual(["/"]);
    s().reopenClosed();
    expect(paths(store)).toEqual(["/", `${R}/graphs/b`]);
    s().reopenClosed();
    expect(paths(store)).toEqual(["/", `${R}/graphs/a`, `${R}/graphs/b`]);
    expect(activeTab(s()).title).toBe("repo · A");
    s().reopenClosed();
    expect(paths(store)).toHaveLength(3);

    for (let i = 0; i < MAX_CLOSED_TABS + 5; i++) s().close(s().open(`${R}/graphs/n${i}`, { activate: true }));
    expect(s().closed).toHaveLength(MAX_CLOSED_TABS);
    expect(s().closed.at(-1)!.path).toBe(`${R}/graphs/n${MAX_CLOSED_TABS + 4}`);
  });

  it("next, goto and the shortcut actions", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    for (const g of ["a", "b", "c"]) s().open(`${R}/graphs/${g}`, { activate: false });
    s().goto(0);
    s().next(-1);
    expect(activePath(store)).toBe(`${R}/graphs/c`);
    s().next(1);
    expect(activePath(store)).toBe("/");
    runTabAction(store, { type: "gotoTab", n: 2 });
    expect(activePath(store)).toBe(`${R}/graphs/a`);
    runTabAction(store, { type: "gotoTab", n: 8 });
    expect(activePath(store)).toBe(`${R}/graphs/a`);
    runTabAction(store, { type: "lastTab" });
    expect(activePath(store)).toBe(`${R}/graphs/c`);
    runTabAction(store, { type: "prevTab" });
    expect(activePath(store)).toBe(`${R}/graphs/b`);
    runTabAction(store, { type: "closeTab" });
    expect(paths(store)).toEqual(["/", `${R}/graphs/a`, `${R}/graphs/c`]);
    runTabAction(store, { type: "reopenClosed" });
    expect(activePath(store)).toBe(`${R}/graphs/b`);
    runTabAction(store, { type: "newTab" });
    expect(paths(store)).toHaveLength(5);
    expect(activePath(store)).toBe("/");
  });

  it("keeps at most 30 tabs, dropping the least recently used onto the closed stack", () => {
    const store = createTabsStore(windowStores());
    const s = () => store.getState();
    for (let i = 0; i < MAX_TABS + 1; i++) s().open(`${R}/graphs/g${i}`, { activate: true });
    expect(s().tabs).toHaveLength(MAX_TABS);
    expect(paths(store)).not.toContain("/");
    expect(paths(store)).not.toContain(`${R}/graphs/g0`);
    expect(s().closed.map((c) => c.path)).toEqual(["/", `${R}/graphs/g0`]);
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
    expect(paths(store)).toContain(`${R}/graphs/new`);
    expect(s().activeId).toBe(active);
    // The Home tab of the start was the least recently used.
    expect(s().closed.map((c) => c.path)).toEqual(["/"]);
  });

  it("caps titles and paths so one long value never invalidates the saved set", () => {
    const w = windowStores();
    const store = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    const s = () => store.getState();
    s().setTitle(s().activeId, "x".repeat(301));
    expect(activeTab(s()).title).toHaveLength(300);
    s().open(`/${"y".repeat(2100)}`, { activate: false });
    expect(paths(store)).toEqual(["/", `${R}/graphs/g1`]);

    const reloaded = createTabsStore({ ...w, initialPath: `${R}/graphs/g1` });
    expect(paths(reloaded)).toEqual(["/", `${R}/graphs/g1`]);
    expect(activeTab(reloaded.getState()).title).toHaveLength(300);

    // A stored set written before the caps: the bad title and the bad tab are dropped, the rest is kept.
    const raw = { version: 1, tabs: [{ id: "a", path: "/", title: "z".repeat(301) }, { id: "b", path: `/${"y".repeat(2100)}` }, { id: "c", path: `${R}/graphs/g1`, title: "ok" }], activeId: "c", mru: ["c", "b", "a"] };
    expect(parsePersistedTabs(JSON.stringify(raw))).toEqual({
      tabs: [
        { id: "a", path: "/" },
        { id: "c", path: `${R}/graphs/g1`, title: "ok" },
      ],
      activeId: "c",
      mru: ["c", "a"],
    });
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

  it("corrupt storage gives one Home tab; bad entries are dropped one by one", () => {
    const corrupt = ["{", JSON.stringify({ version: 2, tabs: [], activeId: "x", mru: [] }), JSON.stringify({ version: 1, tabs: [], activeId: "x", mru: [] })];
    const dup = { version: 1, tabs: [{ id: "a", path: "/" }, { id: "a", path: "/x" }], activeId: "a", mru: ["a"] };
    const foreign = { version: 1, tabs: [{ id: "a", path: "https://evil.example/" }], activeId: "a", mru: ["a"] };
    const tooMany = { version: 1, tabs: Array.from({ length: MAX_TABS + 1 }, (_, i) => ({ id: `t${i}`, path: `/x${i}` })), activeId: "t0", mru: [] };
    for (const raw of [...corrupt, JSON.stringify(dup), JSON.stringify(foreign), JSON.stringify(tooMany)]) {
      const w = windowStores();
      w.session.setItem(TABS_SESSION_KEY, raw);
      expect(paths(createTabsStore(w))).toEqual(["/"]);
    }
    // Repairable: a missing active id and an incomplete MRU list.
    expect(parsePersistedTabs(JSON.stringify({ version: 1, tabs: [{ id: "a", path: "/x/" }, { id: "b", path: "/" }], activeId: "gone", mru: ["b", "zz"] }))).toEqual({
      tabs: [
        { id: "a", path: "/x" },
        { id: "b", path: "/" },
      ],
      activeId: "b",
      mru: ["b", "a"],
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

  it("moves a tab to another strip position, keeping the active tab, and persists the order", () => {
    const stores = windowStores();
    const store = createTabsStore(stores);
    store.getState().open(`${R}/graphs/g1`, { activate: true });
    store.getState().open(`${R}/runs/r1`, { activate: false });
    const [home, graphTab, runTab] = store.getState().tabs;

    store.getState().move(runTab!.id, 0);
    expect(paths(store)).toEqual([`${R}/runs/r1`, "/", `${R}/graphs/g1`]);
    expect(activePath(store)).toBe(`${R}/graphs/g1`);

    // Clamped; unknown ids and no-op moves change nothing.
    store.getState().move(home!.id, 99);
    expect(paths(store)).toEqual([`${R}/runs/r1`, `${R}/graphs/g1`, "/"]);
    const before = store.getState().tabs;
    store.getState().move(graphTab!.id, 1);
    store.getState().move("nope", 0);
    expect(store.getState().tabs).toBe(before);

    expect(paths(createTabsStore({ session: stores.session, local: null }))).toEqual([`${R}/runs/r1`, `${R}/graphs/g1`, "/"]);
  });
});
