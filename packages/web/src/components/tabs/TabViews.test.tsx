// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../App";
import { dispatcher } from "../../store/live";
import { TABS_SESSION_KEY, activeTab, createTabsStore, setTabsStore, type TabsStoreApi } from "../../store/tabs-store";
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
    expect(await screen.findByRole("heading", { name: "Repositories" })).toBeTruthy();
    expect(mountedViews()).toEqual([home]);

    act(() => s().activate(other));
    expect(mountedViews().sort()).toEqual([home, other].sort());
    expect(viewOf(home).hidden).toBe(true);
    expect(viewOf(home).hasAttribute("inert")).toBe(true);
    expect(viewOf(other).hidden).toBe(false);
    expect(viewOf(other).hasAttribute("inert")).toBe(false);
    // The hidden Home view is still there (not rebuilt).
    const homeHeading = within(viewOf(home)).getByRole("heading", { name: "Repositories", hidden: true });
    act(() => s().activate(home));
    expect(within(viewOf(home)).getByRole("heading", { name: "Repositories" })).toBe(homeHeading);
  });

  it(`mounts at most ${MAX_MOUNTED} views: the least recently used is evicted and remounts from its path`, async () => {
    const first = s().activeId;
    act(() => s().navigate(first, "/nope-0"));
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
    const graphTab = s().activeId;
    act(() => s().navigate(graphTab, `${R}/graphs/g1`));
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
    const one = s().activeId;
    act(() => s().navigate(one, `${R}/runs/r1`));
    renderTabs();
    act(() => FakeSocket.last()!.open());
    await waitFor(() => expect(FakeSocket.allSent().filter((m) => m.type === "subscribe")).toHaveLength(1));
    const two = s().open("/", { activate: true, dedupe: false });
    act(() => s().navigate(two, `${R}/runs/r1`));
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
    const one = s().activeId;
    act(() => s().navigate(one, `${R}/graphs/g1`));
    renderTabs();
    await screen.findByText("Implement");
    const two = s().open("/", { activate: true, dedupe: false });
    act(() => s().navigate(two, `${R}/graphs/g1`));
    await waitFor(() => expect(within(viewOf(two)).getByText("Implement")).toBeTruthy());
    expect(daemon.calls.filter((c) => c === `GET /api/repos/${REPO}/graphs/g1`)).toHaveLength(1);

    const editor = findEditorStore(REPO, "g1")!;
    act(() => editor.getState().rename("Edited in two"));
    // Both views render the same store.
    expect(within(viewOf(one)).getByRole("button", { name: /Edited in two/, hidden: true })).toBeTruthy();
    expect(within(viewOf(two)).getByRole("button", { name: /Edited in two/ })).toBeTruthy();
    act(() => s().close(two));
    expect(findEditorStore(REPO, "g1")).toBe(editor);
    expect(puts()).toEqual([]);
    act(() => s().close(one));
    // Well before the debounce.
    await waitFor(() => expect(puts()).toEqual([`PUT /api/repos/${REPO}/graphs/g1?baseHash=h0`]), { timeout: AUTOSAVE_DELAY_MS / 2 });
    expect(daemon.bodies.find((b) => b.call.startsWith("PUT"))?.body).toMatchObject({ name: "Edited in two" });
    expect(s().tabs.map((t) => t.path)).toEqual(["/"]);
  });

  it("a Ctrl-click on a link opens a background tab; a middle click too", async () => {
    const first = s().activeId;
    act(() => s().navigate(first, "/nope"));
    renderTabs();
    const link = await screen.findByRole("link", { name: "Go to Home" });
    fireEvent.click(link, { ctrlKey: true });
    expect(s().tabs.map((t) => t.path)).toEqual(["/nope", "/"]);
    expect(s().activeId).toBe(first);
    fireEvent.click(link, { ctrlKey: true, shiftKey: true });
    expect(activeTab(s()).path).toBe("/");
    expect(s().tabs).toHaveLength(2);
  });

  it("a removed repository keeps its tabs, which show Repository removed and can be closed", async () => {
    const one = s().activeId;
    act(() => s().navigate(one, `${R}/graphs/g1`));
    const two = s().open(`${R}/graphs/g2`, { activate: false });
    renderTabs();
    await screen.findByText("Implement");
    act(() => dispatcher.handle({ type: "repo:removed", repoId: REPO }));
    expect(await screen.findByText("Repository removed")).toBeTruthy();
    expect(s().tabs.map((t) => t.id)).toEqual([one, two]);
    act(() => s().activate(two));
    expect(within(viewOf(two)).getByText("Repository removed")).toBeTruthy();
    fireEvent.click(within(viewOf(two)).getByRole("button", { name: "Close tab" }));
    expect(s().tabs.map((t) => t.id)).toEqual([one]);
  });
});

describe("tab strip (DESIGN §13.4)", () => {
  it("shows titles from the repository cache, closes with × and middle-click, and + opens Home", async () => {
    const one = s().activeId;
    act(() => s().navigate(one, `${R}/graphs/g1`));
    s().open(`${R}/graphs/g2`, { activate: false });
    s().open(`${R}/runs/r1`, { activate: false });
    renderTabs();
    // The graph list of every repository with a tab is loaded, mounted or not.
    expect(await strip().findByRole("tab", { name: /repo · Other/ })).toBeTruthy();
    expect(strip().getByRole("tab", { name: /repo · Graph 1/ }).getAttribute("aria-selected")).toBe("true");
    // An unmounted run tab: the route's shape, never its id.
    expect(strip().getByRole("tab", { name: /^Run/ })).toBeTruthy();
    expect(document.title).toBe("repo · Graph 1 · promptgraph");

    act(() => s().activate(s().tabs[2]!.id));
    expect(await strip().findByRole("tab", { name: /Graph 1 #ab12/ })).toBeTruthy();
    // The mounted view's title is persisted with the tab.
    expect(s().tabs[2]!.title).toBe("Graph 1 #ab12");

    fireEvent.click(screen.getByRole("button", { name: "Close repo · Other" }));
    expect(s().tabs).toHaveLength(2);
    fireEvent.mouseDown(strip().getByRole("tab", { name: /Graph 1 #ab12/ }), { button: 1 });
    fireEvent(strip().getByRole("tab", { name: /Graph 1 #ab12/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(s().tabs.map((t) => t.id)).toEqual([one]);

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(s().tabs.map((t) => t.path)).toEqual([`${R}/graphs/g1`, "/"]);
    expect(activeTab(s()).path).toBe("/");
    expect(document.title).toBe("promptgraph");
  });

  it("an attention dot shows on the tabs of a repository with nodes waiting for the user", async () => {
    act(() => s().navigate(s().activeId, `${R}/graphs/g1`));
    renderTabs();
    await screen.findByText("Implement");
    expect(screen.queryByLabelText("Needs attention")).toBeNull();
    act(() => dispatcher.handle({ type: "repo:status", repo: summaryOf({ waiting: { approval: 1, input: 0 } }) }));
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
  });

  it("arrow keys move the focus between tabs (roving tabindex); Enter activates", async () => {
    s().open("/nope", { activate: false });
    renderTabs();
    const [home, other] = await strip().findAllByRole("tab");
    expect(home!.tabIndex).toBe(0);
    expect(other!.tabIndex).toBe(-1);
    home!.focus();
    fireEvent.keyDown(home!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(other!, { key: "Enter" });
    expect(activeTab(s()).path).toBe("/nope");
  });
});
