// @vitest-environment jsdom
import type { ServerMessage } from "@promptgraph/shared";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wsClient } from "../../api/ws";
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
  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

let listeners: ((msg: ServerMessage) => void)[];
let attach: ReturnType<typeof vi.spyOn>;
let resize: ReturnType<typeof vi.spyOn>;
let ptyData: ((bytes: Uint8Array) => void) | null;

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
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
