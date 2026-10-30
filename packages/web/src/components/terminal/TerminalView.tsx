import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { wsClient } from "../../api/ws";
import { keepAlternateScreen } from "../../lib/terminal-replay";

export type PtyState = { phase: "connecting" } | { phase: "live" } | { phase: "replay"; exitCode?: number | null } | { phase: "error"; message: string };

const THEME = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  brightBlack: "#52525b",
};

/**
 * One xterm.js instance bound to a PTY over the shared WebSocket: replay + live output, keystrokes and
 * resizes go to the server while the process is live; otherwise read-only.
 */
export function TerminalView({ ptyId, visible, onState }: { ptyId: string; visible: boolean; onState: (s: PtyState) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const [term, setTerm] = useState<Terminal | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
    t.open(el);
    fitRef.current = fit;
    safeFit(fit);
    setTerm(t);
    return () => {
      fitRef.current = null;
      t.dispose();
      setTerm(null);
    };
  }, []);

  useEffect(() => {
    if (!term) return;
    let live = false;
    const setLive = (v: boolean) => {
      live = v;
      term.options.disableStdin = !v;
      term.options.cursorBlink = v;
    };
    onStateRef.current({ phase: "connecting" });
    const offMsg = wsClient.onMessage((msg) => {
      if (!("ptyId" in msg) || msg.ptyId !== ptyId) return;
      if (msg.type === "pty:attached") {
        term.reset();
        setLive(msg.live);
        if (msg.live && (msg.cols !== term.cols || msg.rows !== term.rows)) wsClient.resizePty(ptyId, term.cols, term.rows);
        onStateRef.current(msg.live ? { phase: "live" } : { phase: "replay" });
      } else if (msg.type === "pty:exit") {
        setLive(false);
        term.write(`\r\n\x1b[90m[process exited${msg.code === null ? "" : ` with code ${msg.code}`}]\x1b[0m\r\n`);
        onStateRef.current({ phase: "replay", exitCode: msg.code });
      } else if (msg.type === "pty:error") {
        onStateRef.current({ phase: "error", message: msg.message });
      }
    });
    const detach = wsClient.attachPty(ptyId, (bytes) => term.write(live ? bytes : keepAlternateScreen(bytes)), { cols: term.cols, rows: term.rows });
    const inputSub = term.onData((data) => {
      if (live) wsClient.send({ type: "pty:input", ptyId, data });
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (live) wsClient.resizePty(ptyId, cols, rows);
    });
    return () => {
      offMsg();
      detach();
      inputSub.dispose();
      resizeSub.dispose();
    };
  }, [term, ptyId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !visible) return;
    const ro = new ResizeObserver(() => {
      if (fitRef.current) safeFit(fitRef.current);
    });
    ro.observe(el);
    if (fitRef.current) safeFit(fitRef.current);
    term?.focus();
    return () => ro.disconnect();
  }, [visible, term]);

  return <div ref={containerRef} className={`pg-terminal h-full w-full ${visible ? "" : "hidden"}`} />;
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // Not measurable yet (hidden container); the ResizeObserver retries.
  }
}

