import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { wsClient } from "../../api/ws";
import { keepAlternateScreen } from "../../lib/terminal-replay";

export type PtyState = { phase: "connecting" } | { phase: "live" } | { phase: "replay"; exitCode?: number | null } | { phase: "error"; message: string };

/** Claude Code's TUI is designed for a dark terminal: keep it dark in both themes, in the near-black of the logo. */
const TERMINAL_BG = "#111113";

const THEME = {
  background: TERMINAL_BG,
  foreground: "#f4f4f5",
  cursor: "#f4f4f5",
  selectionBackground: "#3f3f46",
  black: "#1c1c1f",
  brightBlack: "#71717a",
};

/**
 * One xterm.js instance bound to a PTY over the shared WebSocket: replay + live output, keystrokes and
 * resizes go to the server while the process is live; otherwise read-only. A live terminal fits its
 * container (and drives the PTY size); a replay renders at the PTY's own cols/rows (from pty:attached),
 * since a full-screen TUI redrawn at another width is garbled, and scrolls inside the container instead.
 *
 * Hidden (a hidden tab, a collapsed drawer, another drawer tab; DESIGN §13.4): the terminal keeps its PTY
 * attachment and receives output, but is never opened or fitted, never focused and sends no `pty:resize`
 * (a hidden element measures 0×0, and the most recent resize drives a shared PTY's size). It opens on its
 * first visible render, and refits and catches the PTY up to its size whenever it is shown again.
 */
export function TerminalView({ ptyId, visible, onState }: { ptyId: string; visible: boolean; onState: (s: PtyState) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Replay: the PTY's size; the container scrolls instead of fitting. null = live (fit). */
  const [fixedSize, setFixedSize] = useState<{ cols: number; rows: number } | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** Live, and the size the PTY has as far as this view knows (from pty:attached and our resizes). */
  const ptyRef = useRef<{ live: boolean; cols: number; rows: number }>({ live: false, cols: 0, rows: 0 });
  const [term, setTerm] = useState<Terminal | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const t = new Terminal({
      theme: THEME,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      disableStdin: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(new WebLinksAddon());
    fitRef.current = fit;
    setTerm(t);
    return () => {
      fitRef.current = null;
      t.dispose();
      setTerm(null);
      setOpened(false);
    };
  }, []);

  /** Live and shown: the PTY takes this view's size. */
  const syncPtySize = useCallback(() => {
    const pty = ptyRef.current;
    if (!term || !visibleRef.current || !pty.live) return;
    if (term.cols === pty.cols && term.rows === pty.rows) return;
    pty.cols = term.cols;
    pty.rows = term.rows;
    wsClient.resizePty(ptyId, term.cols, term.rows);
  }, [term, ptyId]);

  // Opened on the first visible render only: xterm measures its container when it opens.
  useEffect(() => {
    const el = containerRef.current;
    if (!term || !el || !visible || opened) return;
    term.open(el);
    // Fit before the PTY is attached, so the attach carries the real size.
    if (fitRef.current) safeFit(fitRef.current);
    setOpened(true);
  }, [term, visible, opened]);

  useEffect(() => {
    if (!term) return;
    const setLive = (v: boolean) => {
      ptyRef.current.live = v;
      term.options.disableStdin = !v;
      term.options.cursorBlink = v;
    };
    onStateRef.current({ phase: "connecting" });
    const offMsg = wsClient.onMessage((msg) => {
      if (!("ptyId" in msg) || msg.ptyId !== ptyId) return;
      if (msg.type === "pty:attached") {
        term.reset();
        setLive(msg.live);
        ptyRef.current.cols = msg.cols;
        ptyRef.current.rows = msg.rows;
        if (msg.live) {
          setFixedSize(null);
          if (visibleRef.current && fitRef.current) safeFit(fitRef.current);
          syncPtySize();
        } else {
          setFixedSize({ cols: msg.cols, rows: msg.rows });
          term.resize(msg.cols, msg.rows);
        }
        onStateRef.current(msg.live ? { phase: "live" } : { phase: "replay" });
      } else if (msg.type === "pty:exit") {
        setLive(false);
        term.write(`\r\n\x1b[90m[process exited${msg.code === null ? "" : ` with code ${msg.code}`}]\x1b[0m\r\n`);
        onStateRef.current({ phase: "replay", exitCode: msg.code });
      } else if (msg.type === "pty:error") {
        onStateRef.current({ phase: "error", message: msg.message });
      }
    });
    // A hidden terminal attaches without a size: attaching with one resizes the PTY.
    const size = visibleRef.current ? { cols: term.cols, rows: term.rows } : undefined;
    const detach = wsClient.attachPty(ptyId, (bytes) => term.write(ptyRef.current.live ? bytes : keepAlternateScreen(bytes)), size);
    const inputSub = term.onData((data) => {
      if (ptyRef.current.live && visibleRef.current) wsClient.send({ type: "pty:input", ptyId, data });
    });
    const resizeSub = term.onResize(() => syncPtySize());
    return () => {
      offMsg();
      detach();
      inputSub.dispose();
      resizeSub.dispose();
    };
  }, [term, ptyId, syncPtySize]);

  // Shown: fit (live) and follow the container's size; the PTY catches up with this view's size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !visible || !opened) return;
    if (fixedSize) return;
    const refit = () => {
      if (fitRef.current) safeFit(fitRef.current);
      syncPtySize();
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    refit();
    return () => ro.disconnect();
  }, [visible, opened, fixedSize, syncPtySize]);

  useEffect(() => {
    if (visible && opened) term?.focus();
  }, [visible, opened, term]);

  return (
    <div className={`h-full w-full ${fixedSize ? "overflow-auto" : ""} ${visible ? "" : "hidden"}`} style={{ backgroundColor: TERMINAL_BG }}>
      <div ref={containerRef} className={`pg-terminal ${fixedSize ? "pg-terminal-fixed h-max w-max" : "h-full w-full"}`} />
    </div>
  );
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // Not measurable yet (hidden container); the ResizeObserver retries.
  }
}

