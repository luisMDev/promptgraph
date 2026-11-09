// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../App";
import { dispatcher } from "../../store/live";
import { PAGE_ID, TABS_SESSION_KEY, activeTab, createTabsStore, setTabsStore, stripTabs, type TabsStoreApi } from "../../store/tabs-store";
import { AUTOSAVE_DELAY_MS, findEditorStore } from "../../store/view/editor-store";
import { FakeSocket, REPO, installFakeDaemon, resetGlobals, summaryOf, type FakeDaemon } from "../../test-daemon";
import { linearGraph, nodeRunOf, runDetailOf } from "../../test-fixtures";
import { MAX_MOUNTED } from "../../lib/tabs/keep-alive";
import { Modal } from "../common/ui";
import { installKeymap } from "../../lib/keymap";
import { runTabAction } from "../../store/tabs-store";
import { useTabContext } from "./tab-context";
import { TabStrip } from "./TabStrip";
import { TabViews } from "./TabViews";

vi.mock("../terminal/TerminalView", () => ({ TerminalView: ({ ptyId }: { ptyId: string }) => <div data-testid={`terminal-${ptyId}`} /> }));

const graph = linearGraph();
const R = `/r/${REPO}`;
let daemon: FakeDaemon;
let store: TabsStoreApi;
const s = () => store.getState();

function newStore(session: Storage | null = null): TabsStoreApi {
  store = createTabsStore({ session, local: null });
  setTabsStore(store);
  return store;
}

function renderTabs() {
  return render(
    <AppShell strip={<TabStrip />}>
      <TabViews />
    </AppShell>,
  );
}

/** Ids of the mounted tab views, and the hidden ones. */
function mountedViews(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-tab-view]")].map((el) => el.dataset.tabView!);
}

function viewOf(tabId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-tab-view="${tabId}"]`)!;
}

const strip = () => within(screen.getByRole("tablist", { name: "Tabs" }));
/** Paths of the strip's tabs (diagrams; the page is not one). */
const stripPaths = () => stripTabs(s()).map((t) => t.path);

const puts = () => daemon.calls.filter((c) => c.startsWith("PUT "));

beforeEach(() => {
  resetGlobals();
  vi.stubGlobal("WebSocket", FakeSocket);
  const detail = runDetailOf(graph, [nodeRunOf({ id: "na", nodeId: "a", status: "running", ptyId: "pty-na" })]);
  daemon = installFakeDaemon({
    repos: {
      [REPO]: {
        info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: ["main"] },
        graphs: {
          g1: { graph, hash: "h0", modifiedOutside: false, activeRunId: null },
          g2: { graph: { ...graph, id: "g2", name: "Other" }, hash: "h2", modifiedOutside: false, activeRunId: null },
        },
        runs: { r1: detail },
      },
    },
    summaries: [summaryOf()],
  });
  newStore();
});

afterEach(() => {
  cleanup();
  setTabsStore(null);
  vi.unstubAllGlobals();
});

describe("tab views: keep-alive (DESIGN §13.4)", () => {
  it("only the active tab mounts at first; an inactive view stays mounted, hidden and inert", async () => {
    const home = s().activeId;
    const other = s().open("/nope-1", { activate: false });
    renderTabs();
    expect(await screen.findByRole("heading", { name: "All graphs" })).toBeTruthy();
    expect(mountedViews()).toEqual([home]);

    act(() => s().activate(other));
    expect(mountedViews().sort()).toEqual([home, other].sort());
    expect(viewOf(home).hidden).toBe(true);
    expect(viewOf(home).hasAttribute("inert")).toBe(true);
    expect(viewOf(other).hidden).toBe(false);
    expect(viewOf(other).hasAttribute("inert")).toBe(false);
    // The hidden Home view is still there (not rebuilt).
    const homeHeading = within(viewOf(home)).getByRole("heading", { name: "All graphs", hidden: true });
    act(() => s().activate(home));
    expect(within(viewOf(home)).getByRole("heading", { name: "All graphs" })).toBe(homeHeading);
  });

  it(`mounts at most ${MAX_MOUNTED} views: the least recently used is evicted and remounts from its path`, async () => {
    const first = s().open("/nope-0", { activate: true });
    renderTabs();
    await screen.findAllByText("Not found");
    const ids = [first];
    for (let i = 1; i <= MAX_MOUNTED; i++) act(() => void ids.push(s().open(`/nope-${i}`, { activate: true })));
    expect(mountedViews()).toHaveLength(MAX_MOUNTED);
    expect(mountedViews()).not.toContain(first);
    // Its descriptor stays; activating it remounts it from its path (and evicts the next least recent).
    expect(s().tabs.map((t) => t.id)).toContain(first);
    act(() => s().activate(first));
    expect(mountedViews()).toContain(first);
    expect(mountedViews()).not.toContain(ids[1]);
    expect(within(viewOf(first)).getByText("Not found")).toBeTruthy();
  });

  it("never evicts a view whose editor has unsaved changes", async () => {
    const graphTab = s().open(`${R}/graphs/g1`, { activate: true });
    renderTabs();
    expect(await screen.findByText("Implement")).toBeTruthy();
    act(() => findEditorStore(REPO, "g1")!.getState().rename("Unsaved"));
    const ids: string[] = [];
    for (let i = 1; i <= MAX_MOUNTED; i++) act(() => void ids.push(s().open(`/nope-${i}`, { activate: true })));
    // The graph tab is the least recently used, but dirty: the next one goes instead.
    expect(mountedViews()).toContain(graphTab);
    expect(mountedViews()).not.toContain(ids[0]);
    expect(mountedViews()).toHaveLength(MAX_MOUNTED);
    expect(puts()).toEqual([]);
  });

  it("after a reload only the active view mounts, with the window's tabs restored", async () => {
    const session = window.sessionStorage;
    session.clear();
    const before = newStore(session);
    const a = before.getState().open("/nope-a", { activate: true });
    before.getState().open("/nope-b", { activate: true });
    before.getState().activate(a);
    expect(JSON.parse(session.getItem(TABS_SESSION_KEY)!).activeId).toBe(a);

    newStore(session);
    expect(s().tabs.map((t) => t.path)).toEqual(["/", "/nope-a", "/nope-b"]);
    renderTabs();
    await screen.findAllByText("Not found");
    expect(mountedViews()).toEqual([a]);
    session.clear();
  });
});

describe("tab views: overlays of hidden views (DESIGN §13.4)", () => {
  /** A view that keeps a dialog open (tab A only). */
  function DialogProbe({ tabId }: { tabId: string }) {
    const tab = useTabContext();
    return tab?.tabId === tabId ? (
      <Modal title="Approve the plan" onClose={() => {}}>
        <input aria-label="Comment" />
      </Modal>
    ) : (
      <p>Other view</p>
    );
  }

  it("a dialog of a hidden view is not shown, and shows again when its tab is activated", async () => {
    const a = s().activeId;
    const b = s().open("/nope-b", { activate: false });
    render(
      <AppShell strip={<TabStrip />}>
        <TabViews>
          <DialogProbe tabId={a} />
        </TabViews>
      </AppShell>,
    );
    expect(await screen.findByRole("dialog", { name: "Approve the plan" })).toBeTruthy();
    act(() => s().activate(b));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Other view")).toBeTruthy();
    act(() => s().activate(a));
    expect(await screen.findByRole("dialog", { name: "Approve the plan" })).toBeTruthy();
  });

  it("tab shortcuts wait while a dialog is open", async () => {
    const a = s().activeId;
    s().open("/nope-b", { activate: false });
    const stop = installKeymap(window, { desktop: () => false, onAction: (action) => runTabAction(store, action) });
    try {
      render(
        <AppShell strip={<TabStrip />}>
          <TabViews>
            <DialogProbe tabId={a} />
          </TabViews>
        </AppShell>,
      );
      await screen.findByRole("dialog", { name: "Approve the plan" });
      fireEvent.keyDown(window, { code: "PageDown", altKey: true });
      expect(s().activeId).toBe(a);
    } finally {
      stop();
    }
  });
});

describe("tab views: shared stores (DESIGN §13.4)", () => {
  it("two tabs on the same run subscribe once; closing one keeps the subscription", async () => {
    const one = s().open(`${R}/runs/r1`, { activate: true });
    renderTabs();
    act(() => FakeSocket.last()!.open());
    await waitFor(() => expect(FakeSocket.allSent().filter((m) => m.type === "subscribe")).toHaveLength(1));
    // A duplicate tab (dedupe off) on the same run.
    let two = "";
    act(() => void (two = s().open(`${R}/runs/r1`, { activate: true, dedupe: false })));
    await waitFor(() => expect(within(viewOf(two)).getAllByText("Implement").length).toBeGreaterThan(0));
    expect(FakeSocket.allSent().filter((m) => m.type === "subscribe")).toEqual([{ type: "subscribe", runId: "r1" }]);
    expect(FakeSocket.allSent().filter((m) => m.type === "repo:subscribe")).toEqual([{ type: "repo:subscribe", repoId: REPO }]);

    act(() => s().close(one));
    expect(mountedViews()).toEqual([two]);
    expect(FakeSocket.allSent().filter((m) => m.type === "unsubscribe")).toEqual([]);
    act(() => s().close(two));
    await waitFor(() => expect(FakeSocket.allSent().filter((m) => m.type === "unsubscribe")).toEqual([{ type: "unsubscribe", runId: "r1" }]));
  });

  it("two tabs on the same graph share one editor store; closing the last one during the debounce flushes the save", async () => {
    const one = s().open(`${R}/graphs/g1`, { activate: true });
    renderTabs();
    await screen.findByText("Implement");
    // A duplicate tab (dedupe off) on the same graph.
    let two = "";
    act(() => void (two = s().open(`${R}/graphs/g1`, { activate: true, dedupe: false })));
    await waitFor(() => expect(within(viewOf(two)).getByText("Implement")).toBeTruthy());
    expect(daemon.calls.filter((c) => c === `GET /api/repos/${REPO}/graphs/g1`)).toHaveLength(1);

    const editor = findEditorStore(REPO, "g1")!;
    act(() => editor.getState().rename("Edited in two"));
    // Both views render the same store.
    expect(within(viewOf(one)).getByDisplayValue("Edited in two")).toBeTruthy();
    expect(within(viewOf(two)).getByDisplayValue("Edited in two")).toBeTruthy();
    act(() => s().close(two));
    expect(findEditorStore(REPO, "g1")).toBe(editor);
    expect(puts()).toEqual([]);
    act(() => s().close(one));
    // Well before the debounce.
    await waitFor(() => expect(puts()).toEqual([`PUT /api/repos/${REPO}/graphs/g1?baseHash=h0`]), { timeout: AUTOSAVE_DELAY_MS / 2 });
    expect(daemon.bodies.find((b) => b.call.startsWith("PUT"))?.body).toMatchObject({ name: "Edited in two" });
    // The last tab closed: the page shows the repository's graph list.
    expect(s().tabs.map((t) => t.path)).toEqual([R]);
    expect(s().activeId).toBe(PAGE_ID);
  });

  it("a Ctrl-click on a diagram link opens a background tab; Ctrl+Shift a foreground one; a page link shows in the page", async () => {
    act(() => s().navigate(PAGE_ID, R));
    renderTabs();
    const link = await screen.findByRole("link", { name: "Open Graph 1" });
    fireEvent.click(link, { ctrlKey: true });
    expect(stripPaths()).toEqual([`${R}/graphs/g1`]);
    expect(s().activeId).toBe(PAGE_ID);
    // The graph has a tab: Ctrl+Shift activates it rather than adding one.
    fireEvent.click(link, { ctrlKey: true, shiftKey: true });
    expect(activeTab(s()).path).toBe(`${R}/graphs/g1`);
    expect(stripPaths()).toHaveLength(1);
    // A middle click on another graph: a background tab too.
    act(() => s().activate(PAGE_ID));
    fireEvent(await screen.findByRole("link", { name: "Open Other" }), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(stripPaths()).toEqual([`${R}/graphs/g1`, `${R}/graphs/g2`]);
    expect(s().activeId).toBe(PAGE_ID);
  });

  it("a run tab belongs to the run's graph: its view reports it, and opening the graph from the list reuses the tab", async () => {
    const run = s().open(`${R}/runs/r1`, { activate: true });
    renderTabs();
    await waitFor(() => expect(s().tabs.find((t) => t.id === run)!.graph).toBe(`${REPO}/g1`));
    act(() => s().navigate(run, R));
    expect(s().activeId).toBe(PAGE_ID);
    fireEvent.click(await within(viewOf(PAGE_ID)).findByRole("link", { name: "Open Graph 1" }));
    expect(s().activeId).toBe(run);
    expect(stripPaths()).toEqual([`${R}/graphs/g1`]);
  });

  it("a removed repository keeps its tabs, which show Repository removed and can be closed", async () => {
    const one = s().open(`${R}/graphs/g1`, { activate: true });
    const two = s().open(`${R}/graphs/g2`, { activate: false });
    renderTabs();
    await screen.findByText("Implement");
    act(() => dispatcher.handle({ type: "repo:removed", repoId: REPO }));
    expect(await screen.findByText("Repository removed")).toBeTruthy();
    expect(s().tabs.map((t) => t.id)).toEqual([PAGE_ID, one, two]);
    act(() => s().activate(two));
    expect(within(viewOf(two)).getByText("Repository removed")).toBeTruthy();
    fireEvent.click(within(viewOf(two)).getByRole("button", { name: "Close tab" }));
    expect(s().tabs.map((t) => t.id)).toEqual([PAGE_ID, one]);
  });
});

describe("tab strip (DESIGN §13.4)", () => {
  it("shows titles from the repository cache and closes with × and middle-click; there is no new-tab button", async () => {
    const one = s().open(`${R}/graphs/g1`, { activate: true });
    s().open(`${R}/graphs/g2`, { activate: false });
    const run = s().open(`${R}/runs/r1`, { activate: false });
    renderTabs();
    // The graph list of every repository with a tab is loaded, mounted or not.
    expect(await strip().findByRole("tab", { name: /repo · Other/ })).toBeTruthy();
    expect(strip().getByRole("tab", { name: /repo · Graph 1/ }).getAttribute("aria-selected")).toBe("true");
    // An unmounted run tab: the route's shape, never its id.
    expect(strip().getByRole("tab", { name: /^Run/ })).toBeTruthy();
    expect(strip().getAllByRole("tab")).toHaveLength(3);
    expect(document.title).toBe("repo · Graph 1 · promptgraph");

    act(() => s().activate(run));
    expect(await strip().findByRole("tab", { name: /Graph 1 #ab12/ })).toBeTruthy();
    // The mounted view's title is persisted with the tab.
    expect(s().tabs.find((t) => t.id === run)!.title).toBe("Graph 1 #ab12");

    fireEvent.click(screen.getByRole("button", { name: "Close repo · Other" }));
    expect(stripPaths()).toHaveLength(2);
    fireEvent.mouseDown(strip().getByRole("tab", { name: /Graph 1 #ab12/ }), { button: 1 });
    fireEvent(strip().getByRole("tab", { name: /Graph 1 #ab12/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(s().tabs.map((t) => t.id)).toEqual([PAGE_ID, one]);
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
  });

  it("an attention dot shows on the tabs of a repository with nodes waiting for the user", async () => {
    act(() => s().navigate(s().activeId, `${R}/graphs/g1`));
    renderTabs();
    await screen.findByText("Implement");
    expect(screen.queryByLabelText("Needs attention")).toBeNull();
    act(() => dispatcher.handle({ type: "repo:status", repo: summaryOf({ waiting: { approval: 1, input: 0 } }) }));
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
  });

  it("the logo comes first in the strip and shows Home in the page, whatever the page showed", async () => {
    s().open(`${R}/graphs/g1`, { activate: true });
    s().navigate(PAGE_ID, R);
    renderTabs();
    await screen.findByText("Implement");
    const logo = screen.getByRole("button", { name: "promptgraph Home" });
    expect(logo.parentElement?.firstElementChild).toBe(logo);

    fireEvent.click(logo);
    expect(s().activeId).toBe(PAGE_ID);
    expect(activeTab(s()).path).toBe("/");
    expect(await screen.findByRole("heading", { name: "All graphs" })).toBeTruthy();
    expect(document.title).toBe("promptgraph");
    // The diagram tab stays, no longer selected.
    expect(stripPaths()).toEqual([`${R}/graphs/g1`]);
    expect(strip().getByRole("tab").getAttribute("aria-selected")).toBe("false");
  });

  it("dragging a tab past the others reorders the strip; a short press only activates", async () => {
    for (const p of ["/a", "/b", "/c"]) s().open(p, { activate: false });
    renderTabs();
    const tabs = await strip().findAllByRole("tab");
    // jsdom has no layout: 100px-wide tabs side by side.
    tabs.forEach((tab, i) => (tab.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect));
    const [a, b, c] = tabs;

    fireEvent.pointerDown(a!, { button: 0, isPrimary: true, pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 52 });
    expect(a!.hasAttribute("data-dragging")).toBe(false);
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);

    // While dragging the order is unchanged: the tab follows the pointer (clamped to the strip) and the
    // tabs it passed slide aside.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260 });
    expect(a!.getAttribute("data-dragging")).toBe("true");
    expect(document.documentElement.hasAttribute("data-pg-tab-dragging")).toBe(true);
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
    expect(a!.style.transform).toBe("translateX(200px)");
    expect(b!.style.transform).toBe("translateX(-100px)");
    expect(c!.style.transform).toBe("translateX(-100px)");

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260 });
    expect(stripPaths()).toEqual(["/b", "/c", "/a"]);
    expect(s().tabs[0]!.id).toBe(PAGE_ID);
    expect(a!.hasAttribute("data-dragging")).toBe(false);
    expect(document.documentElement.hasAttribute("data-pg-tab-dragging")).toBe(false);
    // Dropped exactly on its new slot: nothing left to slide.
    expect(a!.style.transform).toBe("");
    expect(b!.style.transform).toBe("");

    // Moves after the release do nothing.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 });
    expect(stripPaths()).toEqual(["/b", "/c", "/a"]);

    // The close button never starts a drag.
    fireEvent.pointerDown(within(b!).getByRole("button"), { button: 0, isPrimary: true, pointerId: 2, clientX: 150 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 400 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 400 });
    expect(stripPaths()).toEqual(["/b", "/c", "/a"]);
  });

  it("dragging activates the tab; Escape slides it back without reordering", async () => {
    for (const p of ["/a", "/b", "/c"]) s().open(p, { activate: false });
    renderTabs();
    const tabs = await strip().findAllByRole("tab");
    tabs.forEach((tab, i) => (tab.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect));
    const [a, b, c] = tabs;

    fireEvent.pointerDown(c!, { button: 0, isPrimary: true, pointerId: 1, clientX: 250 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120 });
    expect(activeTab(s()).path).toBe("/c");
    expect(c!.style.transform).toBe("translateX(-130px)");
    expect(b!.style.transform).toBe("translateX(100px)");
    expect(a!.style.transform).toBe("");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
    expect(c!.hasAttribute("data-dragging")).toBe(false);
    expect(c!.style.transform).toBe("");
    expect(b!.style.transform).toBe("");
    // The release after a cancel does nothing.
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 120 });
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
  });

  it("Ctrl+Shift+Left/Right move the focused tab", async () => {
    s().open("/a", { activate: false });
    s().open("/b", { activate: false });
    renderTabs();
    const [a] = await strip().findAllByRole("tab");
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(stripPaths()).toEqual(["/b", "/a"]);
    fireEvent.keyDown(a!, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(stripPaths()).toEqual(["/a", "/b"]);
  });

  it("arrow keys move the focus between tabs (roving tabindex); Enter activates", async () => {
    s().open("/nope", { activate: false });
    s().open("/nope-2", { activate: false });
    renderTabs();
    // The page is shown, so no tab is active: the first one takes the roving focus.
    const [first, other] = await strip().findAllByRole("tab");
    expect(first!.tabIndex).toBe(0);
    expect(other!.tabIndex).toBe(-1);
    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(other!, { key: "Enter" });
    expect(activeTab(s()).path).toBe("/nope-2");
    expect(other!.tabIndex).toBe(0);
    expect(first!.tabIndex).toBe(-1);
  });
});
