// @vitest-environment jsdom
import { DESKTOP_COMMANDS } from "@promptgraph/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { SessionBanners, SignedOut } from "../components/common/SessionBanners";
import { NodeCard } from "../components/nodes/NodeCard";
import type { PgFlowNode } from "../components/nodes/types";
import { TabStrip, WindowTitleBar } from "../components/tabs/TabStrip";
import { useDaemonStore } from "../store/daemon-store";
import { AUTO_RELOGIN_KEY, useReloginStore } from "../store/relogin-store";
import { createTabsStore, setTabsStore, type TabsStoreApi } from "../store/tabs-store";
import { createTestView } from "../store/view/test-view";
import { FakeSocket, REPO, installFakeDaemon, resetGlobals, summaryOf } from "../test-daemon";
import { linearGraph, nodeRunOf } from "../test-fixtures";
import {
  DESKTOP_RELOGIN_AFTER_MS,
  DESKTOP_RELOGIN_COOLDOWN_MS,
  createDesktopBridge,
  getDesktopBridge,
  inertDesktopBridge,
  installExternalLinkHandler,
  setDesktopBridge,
  type DesktopBridge,
  type DesktopWindowLike,
} from "./desktop";

vi.mock("../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

/** A fake `window.__TAURI__` (Tauri v2 global API) whose calls are spies. */
function fakeTauri(opts: { maximized?: boolean; customTitleBar?: boolean } = {}) {
  const win = {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => opts.maximized ?? false),
    close: vi.fn(async () => {}),
    startResizeDragging: vi.fn(async (_direction: string) => {}),
    setTitle: vi.fn(async (_title: string) => {}),
  };
  const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
  const openUrl = vi.fn(async (_url: string) => {});
  const globals: DesktopWindowLike = {
    __TAURI__: { core: { invoke: invoke as never }, window: { getCurrentWindow: () => win }, opener: { openUrl } },
    __PG_DESKTOP__: { customTitleBar: opts.customTitleBar ?? true },
  };
  return { globals, win, invoke, openUrl, bridge: createDesktopBridge(globals) };
}

/** A desktop bridge whose methods are spies (for components). */
function spyBridge(patch: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isDesktop: true,
    customTitleBar: true,
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    close: vi.fn(async () => {}),
    startResizeDragging: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    relogin: vi.fn(async () => {}),
    ...patch,
  };
}

let tabs: TabsStoreApi;
/** Teardowns of installed document listeners, run after each test even when it fails. */
const teardowns: Array<() => void> = [];
const track = (stop: () => void) => (teardowns.push(stop), stop);

beforeEach(() => {
  resetGlobals();
  vi.stubGlobal("WebSocket", FakeSocket);
  installFakeDaemon({ repos: {}, summaries: [summaryOf()] });
  tabs = createTabsStore({ session: null, local: null });
  setTabsStore(tabs);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  for (const stop of teardowns.splice(0)) stop();
  cleanup();
  setTabsStore(null);
  setDesktopBridge(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DesktopBridge (DESIGN §20.2)", () => {
  it("maps every method to the Tauri global API", async () => {
    const { bridge, win, invoke, openUrl } = fakeTauri();
    expect(bridge.isDesktop).toBe(true);
    expect(bridge.customTitleBar).toBe(true);
    await bridge.minimize();
    await bridge.toggleMaximize();
    await bridge.close();
    await bridge.startResizeDragging("SouthEast");
    await bridge.setTitle("Graph · promptgraph");
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.startResizeDragging).toHaveBeenCalledWith("SouthEast");
    expect(win.setTitle).toHaveBeenCalledWith("Graph · promptgraph");
    win.isMaximized.mockResolvedValueOnce(true);
    expect(await bridge.isMaximized()).toBe(true);

    await bridge.relogin(`/r/${REPO}/runs/r1`);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.relogin, { next: `/r/${REPO}/runs/r1` });

    await bridge.openExternal("https://github.com/o/r/pull/1");
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/pull/1");
    // https only.
    for (const url of ["http://example.com/", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) await bridge.openExternal(url);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("relogin rejects with the shell's error", async () => {
    const { bridge, invoke } = fakeTauri();
    invoke.mockRejectedValueOnce("promptgraph CLI not found");
    await expect(bridge.relogin("/")).rejects.toBe("promptgraph CLI not found");
  });

  it("customTitleBar follows __PG_DESKTOP__ (native decorations: false)", () => {
    expect(fakeTauri({ customTitleBar: false }).bridge.customTitleBar).toBe(false);
    const { globals } = fakeTauri();
    expect(createDesktopBridge({ __TAURI__: globals.__TAURI__ }).customTitleBar).toBe(false);
  });

  it("is inert in a browser", async () => {
    expect(createDesktopBridge({})).toBe(inertDesktopBridge);
    expect(createDesktopBridge({ __TAURI__: {}, __PG_DESKTOP__: { customTitleBar: true } })).toBe(inertDesktopBridge);
    const bridge = getDesktopBridge();
    expect(bridge.isDesktop).toBe(false);
    expect(bridge.customTitleBar).toBe(false);
    await expect(bridge.minimize()).resolves.toBeUndefined();
    await expect(bridge.isMaximized()).resolves.toBe(false);
    await expect(bridge.openExternal("https://example.com")).resolves.toBeUndefined();
    await expect(bridge.relogin("/")).rejects.toThrow();
  });

  it("getDesktopBridge reads window.__TAURI__", () => {
    const { globals } = fakeTauri();
    Object.assign(window, globals);
    try {
      setDesktopBridge(null);
      expect(getDesktopBridge().isDesktop).toBe(true);
    } finally {
      delete (window as DesktopWindowLike).__TAURI__;
      delete (window as DesktopWindowLike).__PG_DESKTOP__;
      setDesktopBridge(null);
    }
  });
});

describe("external link handler (DESIGN §13.2)", () => {
  const prUrl = "https://github.com/o/r/pull/7";

  function renderNodeCard() {
    const graph = linearGraph();
    const props = {
      id: "a",
      type: "pg",
      selected: false,
      data: {
        node: graph.nodes[0]!,
        nodeRun: nodeRunOf({ id: "na", nodeId: graph.nodes[0]!.id, status: "succeeded", output: { prUrl } }),
        lane: null,
        mergeInputs: [],
        runMode: true,
        issues: { errors: [], warnings: [] },
        phase: 1,
      },
    } as unknown as NodeProps<PgFlowNode>;
    createTestView().render(
      <ReactFlowProvider>
        <NodeCard {...props} />
      </ReactFlowProvider>,
    );
    return screen.getByTitle(prUrl);
  }

  it("sends a NodeCard PR link to the system browser in the desktop window", () => {
    const bridge = spyBridge();
    const stop = track(installExternalLinkHandler(bridge));
    const link = renderNodeCard();
    expect(fireEvent.click(link)).toBe(false); // default prevented: the webview does not navigate
    expect(bridge.openExternal).toHaveBeenCalledWith(prUrl);
    // Middle-click too (a webview has no tabs).
    expect(fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(bridge.openExternal).toHaveBeenCalledTimes(2);
    stop();
    fireEvent.click(link);
    expect(bridge.openExternal).toHaveBeenCalledTimes(2);
  });

  it("blocks http:// links to other origins and leaves same-origin links alone", () => {
    const bridge = spyBridge();
    const stop = track(installExternalLinkHandler(bridge));
    render(
      <div>
        <a href="http://example.com/x">plain http</a>
        <a href="http://127.0.0.1:9999/">other port</a>
        <a href="/r/x/graphs/g">
          <span>in-app</span>
        </a>
        <a href="/docs" target="_blank">
          same-origin blank
        </a>
        <a href="https://docs.example.com/" target="_blank">
          <strong>docs</strong>
        </a>
      </div>,
    );
    expect(fireEvent.click(screen.getByText("plain http"))).toBe(false);
    expect(fireEvent.click(screen.getByText("other port"))).toBe(false);
    expect(bridge.openExternal).not.toHaveBeenCalled();

    // Same-origin: not prevented by the handler (a later listener stops jsdom's navigation).
    const seen: boolean[] = [];
    const record = (e: Event) => {
      seen.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener("click", record);
    fireEvent.click(screen.getByText("in-app"));
    document.removeEventListener("click", record);
    expect(seen).toEqual([false]);
    expect(bridge.openExternal).not.toHaveBeenCalled();
    // A right click is never handled.
    expect(fireEvent(screen.getByText("docs"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }))).toBe(true);

    // target=_blank never opens a webview window: same-origin ones are dropped (not https).
    expect(fireEvent.click(screen.getByText("same-origin blank"))).toBe(false);
    expect(bridge.openExternal).not.toHaveBeenCalled();
    expect(fireEvent.click(screen.getByText("docs"))).toBe(false);
    expect(bridge.openExternal).toHaveBeenCalledWith("https://docs.example.com/");
    stop();
  });
});

describe("TabStrip as the title bar (DESIGN §20.2)", () => {
  const dragRegions = () => [...document.querySelectorAll("[data-tauri-drag-region]")];

  it("custom title bar: drag regions on the strip and the spacer only, window controls and edges", async () => {
    const bridge = spyBridge();
    render(<TabStrip bridge={bridge} />);
    const strip = document.querySelector("[data-pg-tabstrip]")!;
    const spacer = document.querySelector("[data-pg-tabstrip-spacer]")!;
    expect(dragRegions()).toEqual([strip, spacer]);
    expect(screen.getByRole("tablist").hasAttribute("data-tauri-drag-region")).toBe(false);
    for (const tab of screen.getAllByRole("tab")) expect(tab.hasAttribute("data-tauri-drag-region")).toBe(false);
    // No double-click handler of its own: Tauri's drag script maximises.
    fireEvent.doubleClick(spacer);
    expect(bridge.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(bridge.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(bridge.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(bridge.close).toHaveBeenCalledTimes(1);

    const edges = [...document.querySelectorAll<HTMLElement>("[data-pg-resize-edge]")];
    expect(edges.map((e) => e.dataset.pgResizeEdge).sort()).toEqual(["East", "North", "NorthEast", "NorthWest", "South", "SouthEast", "SouthWest", "West"]);
    fireEvent.mouseDown(edges.find((e) => e.dataset.pgResizeEdge === "SouthEast")!, { button: 0 });
    expect(bridge.startResizeDragging).toHaveBeenCalledWith("SouthEast");

    // The window title follows the active tab.
    await act(async () => {});
    expect(bridge.setTitle).toHaveBeenLastCalledWith("promptgraph");
  });

  it("re-queries isMaximized on resize: Restore, and no edge handles while maximised", async () => {
    let maximized = false;
    const bridge = spyBridge({ isMaximized: vi.fn(async () => maximized) });
    render(<TabStrip bridge={bridge} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    maximized = true;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(document.querySelector("[data-pg-resize-edge]")).toBeNull();
  });

  it("native decorations: no controls, drag regions or edges; the window title still follows the tab", async () => {
    const bridge = spyBridge({ customTitleBar: false });
    render(<TabStrip bridge={bridge} />);
    await act(async () => {});
    expect(dragRegions()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull();
    expect(document.querySelector("[data-pg-resize-edge]")).toBeNull();
    expect(bridge.setTitle).toHaveBeenCalledWith("promptgraph");
  });

  it("a failing window call (no capability, IPC error) is swallowed, not an unhandled rejection", async () => {
    // Plain functions, not vi.fn: a mock observes the promises it returns, which marks them handled.
    const calls: string[] = [];
    const fail = (name: string) => () => {
      calls.push(name);
      return Promise.reject(new Error("not allowed"));
    };
    const bridge = spyBridge({ minimize: fail("minimize"), toggleMaximize: fail("toggleMaximize"), close: fail("close") });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      render(<TabStrip bridge={bridge} />);
      for (const name of ["Minimize", "Maximize", "Close window"]) fireEvent.click(screen.getByRole("button", { name }));
      await act(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(calls).toEqual(["minimize", "toggleMaximize", "close"]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("WindowTitleBar: drag region and controls only with a custom title bar", () => {
    const { unmount } = render(<WindowTitleBar bridge={spyBridge()} />);
    expect(dragRegions().length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
    unmount();
    render(<WindowTitleBar bridge={spyBridge({ customTitleBar: false })} />);
    render(<WindowTitleBar />);
    expect(dragRegions()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
  });

  it("in a browser: nothing desktop-specific", () => {
    render(<TabStrip />);
    expect(dragRegions()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(1);
  });
});

describe("App in the desktop window", () => {
  it("handles the Ctrl shortcuts (bridge.isDesktop) and installs the external link handler", async () => {
    const bridge = spyBridge();
    setDesktopBridge(bridge);
    render(<App />);
    await act(async () => {});
    expect(tabs.getState().tabs).toHaveLength(1);
    fireEvent.keyDown(window, { code: "KeyT", key: "t", ctrlKey: true });
    expect(tabs.getState().tabs).toHaveLength(2);

    const link = document.createElement("a");
    link.href = "https://github.com/o/r/pull/9";
    link.textContent = "pr";
    document.body.append(link);
    fireEvent.click(link);
    expect(bridge.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/9");
    link.remove();
  });

  it("in a browser Ctrl+T is left to the browser", async () => {
    render(<App />);
    await act(async () => {});
    fireEvent.keyDown(window, { code: "KeyT", key: "t", ctrlKey: true });
    expect(tabs.getState().tabs).toHaveLength(1);
    fireEvent.keyDown(window, { code: "KeyT", key: "t", altKey: true });
    expect(tabs.getState().tabs).toHaveLength(2);
  });
});

describe("automatic relogin (DESIGN §13.5)", () => {
  it("signed out: calls relogin once with the current path, then offers Sign in again", async () => {
    window.history.replaceState(null, "", `/r/${REPO}/graphs/g1`);
    const relogin = vi.fn(async (_next: string) => {
      throw "the daemon did not answer";
    });
    const bridge = spyBridge({ relogin });
    const first = render(<SignedOut bridge={bridge} />);
    await act(async () => {});
    expect(relogin).toHaveBeenCalledTimes(1);
    expect(relogin).toHaveBeenCalledWith(`/r/${REPO}/graphs/g1`);
    expect(screen.getByText("the daemon did not answer")).toBeTruthy();
    // Remounting does not try again by itself.
    first.unmount();
    render(<SignedOut bridge={bridge} />);
    await act(async () => {});
    expect(relogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await act(async () => {});
    expect(relogin).toHaveBeenCalledTimes(2);
  });

  it("signed out in a browser: no relogin, the terminal hint", async () => {
    render(<SignedOut />);
    await act(async () => {});
    expect(screen.getByText(/to sign this browser in again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(useReloginStore.getState().tried.signedOut).toBe(false);
  });

  it("the AppShell renders the desktop signed-out view on a 401", async () => {
    const bridge = spyBridge();
    setDesktopBridge(bridge);
    render(<App />);
    await act(async () => {
      useDaemonStore.getState().setSignedOut();
    });
    expect(bridge.relogin).toHaveBeenCalledTimes(1);
    expect(bridge.relogin).toHaveBeenCalledWith("/");
  });

  it("the desktop signed-out view keeps a title bar with the window controls (custom decorations only)", async () => {
    const bridge = spyBridge({ relogin: vi.fn(async () => Promise.reject(new Error("no"))) });
    setDesktopBridge(bridge);
    const { unmount } = render(<App />);
    await act(async () => {
      useDaemonStore.getState().setSignedOut();
    });
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(document.querySelector("[data-pg-tabstrip]")).toBeNull();
    expect(document.querySelector("[data-pg-titlebar]")!.hasAttribute("data-tauri-drag-region")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
    unmount();

    setDesktopBridge(spyBridge({ customTitleBar: false }));
    render(<App />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(document.querySelector("[data-pg-titlebar]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
  });

  it("signed out again on the page a successful relogin loaded: no second automatic call within the cooldown", async () => {
    const bridge = spyBridge();
    const first = render(<SignedOut bridge={bridge} />);
    await act(async () => {});
    expect(bridge.relogin).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(AUTO_RELOGIN_KEY)!)).toHaveProperty("signedOut");
    first.unmount();

    // The relogin navigated: a new page has a fresh store but the same sessionStorage.
    useReloginStore.setState({ pending: false, error: null, tried: { signedOut: false, unreachable: false } });
    const second = render(<SignedOut bridge={bridge} />);
    await act(async () => {});
    expect(bridge.relogin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    second.unmount();

    // Once the cooldown is over, a later sign-out relogins by itself again.
    sessionStorage.setItem(AUTO_RELOGIN_KEY, JSON.stringify({ signedOut: Date.now() - DESKTOP_RELOGIN_COOLDOWN_MS }));
    useReloginStore.setState({ tried: { signedOut: false, unreachable: false } });
    render(<SignedOut bridge={bridge} />);
    await act(async () => {});
    expect(bridge.relogin).toHaveBeenCalledTimes(2);
  });

  it("unreachable: relogin once after 10 s without a connection, then Retry", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", `/r/${REPO}/runs/r1`);
    const relogin = vi.fn(async (_next: string) => {
      throw "promptgraph CLI not found";
    });
    const bridge = spyBridge({ relogin });
    render(<SessionBanners bridge={bridge} />);
    act(() => useDaemonStore.setState({ connection: "open" }));
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS - 1);
    });
    expect(relogin).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(relogin).toHaveBeenCalledTimes(1);
    expect(relogin).toHaveBeenCalledWith(`/r/${REPO}/runs/r1`);

    // Still down, then unreachable: no second automatic attempt; the banner offers Retry.
    act(() => useDaemonStore.setState({ connection: "unreachable" }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(relogin).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/promptgraph CLI not found/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(relogin).toHaveBeenCalledTimes(2);
  });

  it("a failed relogin, then the socket opens: the next outage relogins automatically again", async () => {
    vi.useFakeTimers();
    const relogin = vi.fn(async (_next: string) => {
      throw "promptgraph did not answer within 30 s";
    });
    const bridge = spyBridge({ relogin });
    render(<SessionBanners bridge={bridge} />);
    act(() => useDaemonStore.setState({ connection: "open" }));
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS);
    });
    expect(relogin).toHaveBeenCalledTimes(1);

    // The user starts the daemon on the same port: the page stays and its socket opens again.
    act(() => useDaemonStore.setState({ connection: "open" }));
    expect(useReloginStore.getState().tried.unreachable).toBe(false);
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS - 1);
    });
    expect(relogin).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(relogin).toHaveBeenCalledTimes(2);
  });

  it("a socket that never opens after a page load counts as down: relogin after 10 s, not after unreachable + 10 s", async () => {
    vi.useFakeTimers();
    const bridge = spyBridge();
    render(<SessionBanners bridge={bridge} />);
    expect(useDaemonStore.getState().connection).toBe("connecting");
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS / 2);
    });
    // connecting → unreachable directly (the client only reports `reconnecting` after an open socket).
    act(() => useDaemonStore.setState({ connection: "unreachable" }));
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS / 2);
    });
    expect(bridge.relogin).toHaveBeenCalledTimes(1);
  });

  it("unreachable on the page a relogin loaded: no second automatic call; the record is dropped once connected", async () => {
    vi.useFakeTimers();
    const bridge = spyBridge();
    const first = render(<SessionBanners bridge={bridge} />);
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS);
    });
    expect(bridge.relogin).toHaveBeenCalledTimes(1);
    first.unmount();

    useReloginStore.setState({ pending: false, error: null, tried: { signedOut: false, unreachable: false } });
    render(<SessionBanners bridge={bridge} />);
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS * 2);
    });
    expect(bridge.relogin).toHaveBeenCalledTimes(1);
    act(() => useDaemonStore.setState({ connection: "open" }));
    expect(JSON.parse(sessionStorage.getItem(AUTO_RELOGIN_KEY)!)).not.toHaveProperty("unreachable");
  });

  it("a connection back within 10 s cancels the countdown", async () => {
    vi.useFakeTimers();
    const bridge = spyBridge();
    render(<SessionBanners bridge={bridge} />);
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS - 1000);
    });
    act(() => useDaemonStore.setState({ connection: "open" }));
    await act(async () => {
      vi.advanceTimersByTime(DESKTOP_RELOGIN_AFTER_MS * 2);
    });
    expect(bridge.relogin).not.toHaveBeenCalled();
  });

  it("in a browser the unreachable banner has no Retry and nothing calls relogin", async () => {
    vi.useFakeTimers();
    render(<SessionBanners />);
    act(() => useDaemonStore.setState({ connection: "unreachable" }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/is not reachable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
