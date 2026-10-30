import { isClaudeNode } from "@promptgraph/shared";
import { useCallback, useRef, useState, type PointerEvent } from "react";
import { closeTerminalTab, reopenSession } from "../../store/app-actions";
import { useRunStore } from "../../store/run-store";
import { clampDrawerHeight, useUiStore } from "../../store/ui-store";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";
import { TerminalView, type PtyState } from "./TerminalView";

/** Bottom drawer: resizable, one tab per open terminal; all terminals stay mounted to keep their state. */
export function TerminalDrawer() {
  const tabs = useUiStore((s) => s.terminalTabs);
  const active = useUiStore((s) => s.activeTerminal);
  const meta = useUiStore((s) => s.tabMeta);
  const open = useUiStore((s) => s.drawerOpen);
  const height = useUiStore((s) => s.drawerHeight);
  const [states, setStates] = useState<Record<string, PtyState>>({});
  const dragStart = useRef<{ y: number; h: number } | null>(null);

  const setState = useCallback((ptyId: string, s: PtyState) => setStates((prev) => ({ ...prev, [ptyId]: s })), []);

  if (tabs.length === 0) return null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragStart.current = { y: e.clientY, h: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    const next = dragStart.current.h + (dragStart.current.y - e.clientY);
    useUiStore.getState().setDrawerHeight(clampDrawerHeight(next, window.innerHeight));
  };
  const onPointerUp = () => {
    dragStart.current = null;
  };

  const activeState = active ? states[active] : undefined;
  const activeMeta = active ? meta[active] : undefined;

  return (
    <div className="flex shrink-0 flex-col border-t border-zinc-800 bg-zinc-950" style={{ height: open ? height : undefined }}>
      {open && (
        <div
          className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-blue-500/50"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="separator"
          aria-orientation="horizontal"
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-2">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-100"
          onClick={() => useUiStore.getState().setDrawerOpen(!open)}
          title={open ? "Collapse" : "Expand"}
        >
          <Icons.terminal />
          <Icons.chevronDown className={open ? "" : "rotate-180"} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((ptyId) => {
            const st = states[ptyId];
            return (
              <div
                key={ptyId}
                className={`group flex shrink-0 items-center gap-1.5 rounded-md py-1 pr-1 pl-2.5 text-xs ${ptyId === active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60"}`}
              >
                <button type="button" className="flex items-center gap-1.5" onClick={() => useUiStore.getState().setActiveTerminal(ptyId)}>
                  <span className={`size-1.5 rounded-full ${st?.phase === "live" ? "bg-green-500" : st?.phase === "error" ? "bg-red-500" : "bg-zinc-500"}`} />
                  <span className="max-w-48 truncate">{meta[ptyId]?.title ?? ptyId}</span>
                </button>
                <button
                  type="button"
                  aria-label="Close terminal"
                  className="rounded p-0.5 text-zinc-500 opacity-60 group-hover:opacity-100 hover:bg-zinc-700 hover:text-zinc-100"
                  title={ptyId.startsWith("reopen-") ? "Close and end this reopened session" : "Close terminal"}
                  onClick={() => void closeTerminalTab(ptyId)}
                >
                  <Icons.x />
                </button>
              </div>
            );
          })}
        </div>
        {active && activeMeta && <TabStatus state={activeState} nodeRunId={activeMeta.nodeRunId} title={activeMeta.title} />}
      </div>
      <div className={`relative min-h-0 flex-1 ${open ? "" : "hidden"}`}>
        {tabs.map((ptyId) => (
          <div key={ptyId} className={ptyId === active ? "absolute inset-0" : "hidden"}>
            <TerminalView ptyId={ptyId} visible={open && ptyId === active} onState={(s) => setState(ptyId, s)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TabStatus({ state, nodeRunId, title }: { state: PtyState | undefined; nodeRunId: string | null; title: string }) {
  const nodeRun = useRunStore((s) => (nodeRunId ? s.detail?.nodeRuns.find((n) => n.id === nodeRunId) : undefined));
  const node = useRunStore((s) => (nodeRun ? s.detail?.run.graphSnapshot.nodes.find((n) => n.id === nodeRun.nodeId) : undefined));
  const canReopen = state?.phase !== "live" && !!nodeRun?.sessionId && !!node && isClaudeNode(node);
  return (
    <div className="flex shrink-0 items-center gap-2 pl-2 text-[11px]">
      {state?.phase === "live" && <span className="text-green-400">Live — you can type</span>}
      {state?.phase === "replay" && <span className="text-zinc-500">Read-only replay</span>}
      {state?.phase === "connecting" && <span className="text-zinc-500">Connecting…</span>}
      {state?.phase === "error" && <span className="text-red-400">{state.message}</span>}
      {canReopen && nodeRunId && (
        <Button size="sm" onClick={() => void reopenSession(nodeRunId, title)} title="claude --resume in a new terminal (not part of the run)">
          Reopen session
        </Button>
      )}
    </div>
  );
}
