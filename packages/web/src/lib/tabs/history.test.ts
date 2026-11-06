import { describe, expect, it } from "vitest";
import { activeTab, createTabsStore, type TabsStoreApi } from "../../store/tabs-store";
import { syncTabHistory, type TabHistoryWindow } from "./history";

const R = "/r/repo-0123abcd";

/** A browser history: entries, an index, popstate on back/forward. */
function fakeWindow() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "/" }];
  let index = 0;
  const listeners = new Set<(ev: PopStateEvent) => void>();
  const location = { pathname: "/", search: "", hash: "" };
  const setUrl = (url: string) => {
    const u = new URL(url, "http://127.0.0.1");
    location.pathname = u.pathname;
    location.search = u.search;
    location.hash = u.hash;
  };
  const win: TabHistoryWindow = {
    history: {
      pushState(state: unknown, _t: string, url?: string | URL | null) {
        entries.splice(index + 1);
        entries.push({ state, url: String(url) });
        index = entries.length - 1;
        setUrl(String(url));
      },
      replaceState(state: unknown, _t: string, url?: string | URL | null) {
        entries[index] = { state, url: String(url) };
        setUrl(String(url));
      },
    },
    location,
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  };
  const go = (delta: number) => {
    index += delta;
    const entry = entries[index]!;
    setUrl(entry.url);
    for (const l of listeners) l({ state: entry.state } as PopStateEvent);
  };
  return { win, entries, back: () => go(-1), forward: () => go(1), current: () => entries[index]!, url: () => location.pathname + location.search };
}

function setup(initialPath = "/") {
  const store: TabsStoreApi = createTabsStore({ session: null, local: null, initialPath });
  const w = fakeWindow();
  const stop = syncTabHistory(store, w.win);
  return { store, s: () => store.getState(), ...w, stop };
}

describe("tab history sync (DESIGN §13.2)", () => {
  it("navigating the active tab pushes {tabId, path}; replace navigations and tab switches replace", () => {
    const h = setup(`${R}/graphs/g1`);
    const a = h.s().activeId;
    expect(h.current().state).toEqual({ tabId: a, path: `${R}/graphs/g1` });
    h.s().navigate(a, `${R}/runs/r1`);
    expect(h.entries).toHaveLength(2);
    expect(h.current()).toEqual({ state: { tabId: a, path: `${R}/runs/r1` }, url: `${R}/runs/r1` });
    h.s().navigate(a, `${R}/runs/r1/nodes/n1`, { replace: true });
    expect(h.entries).toHaveLength(2);
    expect(h.url()).toBe(`${R}/runs/r1/nodes/n1`);
    // Navigating to the same path again adds nothing.
    h.s().navigate(a, `${R}/runs/r1/nodes/n1`);
    expect(h.entries).toHaveLength(2);

    const home = h.s().tabs[0]!.id;
    h.s().activate(home);
    expect(h.entries).toHaveLength(2);
    expect(h.current().state).toEqual({ tabId: home, path: "/" });
    // A background tab navigating (a hidden view redirecting) leaves the history alone.
    h.s().navigate(a, `${R}/graphs/g2`);
    expect(h.entries).toHaveLength(2);
    expect(h.url()).toBe("/");
  });

  it("back/forward re-applies the entry to its tab and activates it", () => {
    const h = setup(`${R}/graphs/g1`);
    const a = h.s().activeId;
    h.s().navigate(a, `${R}/runs/r1`);
    const b = h.s().open(`${R}/graphs/g2`, { activate: true });
    h.s().navigate(b, `${R}/runs/r2`);
    // Entries: {A, g1} · {B, g2} (opening B in the foreground replaced A's /runs/r1) · {B, r2}.
    h.back();
    expect(h.s().activeId).toBe(b);
    expect(activeTab(h.s()).path).toBe(`${R}/graphs/g2`);
    h.back();
    expect(h.s().activeId).toBe(a);
    expect(activeTab(h.s()).path).toBe(`${R}/graphs/g1`);
    expect(h.s().tabs.find((t) => t.id === b)!.path).toBe(`${R}/graphs/g2`);
    h.forward();
    expect(h.s().activeId).toBe(b);
    h.forward();
    expect(activeTab(h.s()).path).toBe(`${R}/runs/r2`);
    expect(h.s().tabs.find((t) => t.id === a)!.path).toBe(`${R}/graphs/g1`);
  });

  it("an entry whose tab was closed is skipped and changes no other tab", () => {
    const h = setup(`${R}/graphs/g1`);
    const a = h.s().activeId;
    const b = h.s().open(`${R}/graphs/g2`, { activate: true });
    h.s().navigate(b, `${R}/runs/r2`);
    h.s().navigate(b, `${R}/runs/r2/report`);
    h.s().activate(a);
    h.s().close(b);
    const before = structuredClone(h.s().tabs);
    expect(h.url()).toBe(`${R}/graphs/g1`);
    h.back();
    expect(h.s().tabs).toEqual(before);
    expect(h.s().activeId).toBe(a);
    // The window URL is put back to the active tab's path.
    expect(h.url()).toBe(`${R}/graphs/g1`);
    expect(h.current().state).toEqual({ tabId: a, path: `${R}/graphs/g1` });
  });

  it("an entry the app did not write opens or activates a tab for its URL", () => {
    const h = setup("/");
    h.entries.push({ state: null, url: `${R}/graphs/g9` });
    h.forward();
    const tab = activeTab(h.s());
    expect(tab.path).toBe(`${R}/graphs/g9`);
    expect(h.current().state).toEqual({ tabId: tab.id, path: `${R}/graphs/g9` });
    h.stop();
  });
});
