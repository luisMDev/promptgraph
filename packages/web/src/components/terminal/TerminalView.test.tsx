// @vitest-environment jsdom
import type { ServerMessage } from "@promptgraph/shared";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wsClient } from "../../api/ws";
import { inertDesktopBridge, setDesktopBridge } from "../../lib/desktop";
import { TerminalView } from "./TerminalView";

/** xterm needs a real canvas: a fake that records what the view does with it. */
const xterm = vi.hoisted(() => {
  type Listener<T> = (v: T) => void;
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    opened = false;
    calls: string[] = [];
    written: string[] = [];
    private resizeListeners = new Set<Listener<{ cols: number; rows: number }>>();
    constructor() {
      FakeTerminal.instances.push(this);
    }
    loadAddon(addon: { activate?: (t: FakeTerminal) => void }) {
      addon.activate?.(this);
    }
    open() {
      this.opened = true;
      this.calls.push("open");
    }
    write(data: string | Uint8Array) {
      this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    }
    reset() {}
    focus() {
      this.calls.push("focus");
    }
    dispose() {}
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      for (const l of this.resizeListeners) l({ cols, rows });
    }
    onData() {
      return { dispose() {} };
    }
    onResize(l: Listener<{ cols: number; rows: number }>) {
      this.resizeListeners.add(l);
      return { dispose: () => this.resizeListeners.delete(l) };
    }
  }
  /** Fits to 120×40 once opened (an unopened terminal cannot be measured). */
  class FakeFitAddon {
    term: FakeTerminal | null = null;
    activate(t: FakeTerminal) {
      this.term = t;
    }
    fit() {
      this.term!.calls.push("fit");
      if (!this.term!.opened) throw new Error("not opened");
      this.term!.resize(120, 40);
    }
  }
  /** Records the link handler each terminal was given. */
  class FakeWebLinksAddon {
    static handlers: Array<((event: MouseEvent, uri: string) => void) | undefined> = [];
    constructor(handler?: (event: MouseEvent, uri: string) => void) {
      FakeWebLinksAddon.handlers.push(handler);
    }
  }
  return { FakeTerminal, FakeFitAddon, FakeWebLinksAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: xterm.FakeWebLinksAddon }));

let listeners: ((msg: ServerMessage) => void)[];
let attach: ReturnType<typeof vi.spyOn>;
let resize: ReturnType<typeof vi.spyOn>;
let ptyData: ((bytes: Uint8Array) => void) | null;

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  xterm.FakeWebLinksAddon.handlers = [];
  listeners = [];
  ptyData = null;
  vi.spyOn(wsClient, "onMessage").mockImplementation((l) => {
    listeners.push(l);
    return () => void (listeners = listeners.filter((x) => x !== l));
  });
  attach = vi.spyOn(wsClient, "attachPty").mockImplementation((_id, onData) => {
    ptyData = onData;
    return () => undefined;
  });
  resize = vi.spyOn(wsClient, "resizePty").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  setDesktopBridge(null);
  vi.restoreAllMocks();
});

const emit = (msg: ServerMessage) => act(() => listeners.forEach((l) => l(msg)));

describe("TerminalView in a hidden tab (DESIGN §13.4)", () => {
  it("a hidden terminal attaches and receives output, but never opens, fits, focuses or resizes the PTY", () => {
    const view = render(<TerminalView ptyId="p1" visible={false} onState={() => undefined} />);
    const term = xterm.FakeTerminal.instances.at(-1)!;
    // Attached without a size: attaching with one would resize the PTY.
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0]![2]).toBeUndefined();
    emit({ type: "pty:attached", ptyId: "p1", live: true, cols: 100, rows: 30 });
    act(() => ptyData!(new TextEncoder().encode("output while hidden")));
    expect(term.written).toEqual(["output while hidden"]);
    expect(term.calls).toEqual([]);
    expect(resize).not.toHaveBeenCalled();

    // Shown: opened once, fitted, the PTY takes the view's size, focused.
    view.rerender(<TerminalView ptyId="p1" visible onState={() => undefined} />);
    expect(term.calls.filter((c) => c === "open")).toHaveLength(1);
    expect(term.calls).toContain("fit");
    expect(term.calls).toContain("focus");
    expect(resize).toHaveBeenCalledWith("p1", 120, 40);

    // Hidden again, then shown: no second open, no resize while hidden.
    resize.mockClear();
    view.rerender(<TerminalView ptyId="p1" visible={false} onState={() => undefined} />);
    emit({ type: "pty:attached", ptyId: "p1", live: true, cols: 90, rows: 20 });
    expect(resize).not.toHaveBeenCalled();
    view.rerender(<TerminalView ptyId="p1" visible onState={() => undefined} />);
    expect(term.calls.filter((c) => c === "open")).toHaveLength(1);
    expect(resize).toHaveBeenCalledWith("p1", 120, 40);
  });

  it("a visible terminal opens and fits before attaching, so the attach carries its size", () => {
    render(<TerminalView ptyId="p2" visible onState={() => undefined} />);
    const term = xterm.FakeTerminal.instances.at(-1)!;
    expect(term.calls.slice(0, 2)).toEqual(["open", "fit"]);
    expect(attach.mock.calls[0]![2]).toEqual({ cols: 120, rows: 40 });
  });
});

describe("TerminalView links (DESIGN §20.2)", () => {
  it("in the desktop window a terminal link goes to the system browser through the bridge", async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    setDesktopBridge({ ...inertDesktopBridge, isDesktop: true, openExternal });
    render(<TerminalView ptyId="p3" visible onState={() => undefined} />);
    const handler = xterm.FakeWebLinksAddon.handlers.at(-1);
    expect(handler).toBeTypeOf("function");
    handler!(new MouseEvent("click"), "https://github.com/acme/app/pull/7");
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/app/pull/7");
  });

  it("a failing openExternal is swallowed", async () => {
    const openExternal = vi.fn(async (_url: string) => {
      throw new Error("no capability");
    });
    setDesktopBridge({ ...inertDesktopBridge, isDesktop: true, openExternal });
    render(<TerminalView ptyId="p4" visible onState={() => undefined} />);
    xterm.FakeWebLinksAddon.handlers.at(-1)!(new MouseEvent("click"), "https://example.com/");
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("in a browser the addon keeps its default handler (a new tab)", () => {
    setDesktopBridge(inertDesktopBridge);
    render(<TerminalView ptyId="p5" visible onState={() => undefined} />);
    expect(xterm.FakeWebLinksAddon.handlers).toEqual([undefined]);
  });
});
