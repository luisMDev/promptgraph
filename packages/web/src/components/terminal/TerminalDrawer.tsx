import { Suspense, lazy, useCallback, useRef, useState, type PointerEvent } from "react";
import { closeTerminalTab, reopenSession } from "../../store/app-actions";
import { useRunStore } from "../../store/run-store";
import { clampDrawerHeight, useUiStore } from "../../store/ui-store";
import { GraceCountdown } from "../common/GraceCountdown";
import { Icons } from "../common/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Button } from "../common/ui";
import type { PtyState } from "./TerminalView";

/** Lazy: xterm.js is only needed once a terminal is opened. */
const TerminalView = lazy(() => import("./TerminalView").then((m) => ({ default: m.TerminalView })));

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
    <div className="flex shrink-0 flex-col border-t bg-background" style={{ height: open ? height : undefined }}>
      {open && (
        <div
          className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-stone-400/60"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="separator"
          aria-orientation="horizontal"
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-card/80 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 px-1.5 text-muted-foreground"
              onClick={() => useUiStore.getState().setDrawerOpen(!open)}
              aria-label={open ? "Collapse" : "Expand"}
            >
              <Icons.terminal />
              <Icons.chevronDown className={open ? "" : "rotate-180"} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{open ? "Collapse" : "Expand"}</TooltipContent>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((ptyId) => {
            const st = states[ptyId];
            const closeHint = ptyId.startsWith("reopen-") ? "Close and end this reopened session" : "Close terminal";
            // Plain buttons rather than Radix Tabs: a Radix trigger activates on mousedown and then takes focus,
            // which would steal it from the xterm instance that focuses itself when its tab becomes visible.
            return (
              <div
                key={ptyId}
                className={cn(
                  "group flex shrink-0 items-center gap-0.5 rounded-md pr-0.5 text-xs",
                  ptyId === active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1.5 pl-2.5 font-normal text-inherit hover:bg-transparent hover:text-inherit dark:hover:bg-transparent"
                  onClick={() => useUiStore.getState().setActiveTerminal(ptyId)}
                >
                  <span className={`size-1.5 rounded-full ${st?.phase === "live" ? "bg-green-500" : st?.phase === "error" ? "bg-red-500" : "bg-stone-400"}`} />
                  <span className="max-w-48 truncate">{meta[ptyId]?.title ?? ptyId}</span>
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close terminal"
                      className="size-5 text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-foreground"
                      onClick={() => void closeTerminalTab(ptyId)}
                    >
                      <Icons.x />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{closeHint}</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
        {active && activeMeta && <TabStatus state={activeState} nodeRunId={activeMeta.nodeRunId} title={activeMeta.title} />}
      </div>
      <div className={`relative min-h-0 flex-1 ${open ? "" : "hidden"}`}>
        {tabs.map((ptyId) => (
          <div key={ptyId} className={ptyId === active ? "absolute inset-0" : "hidden"}>
            <Suspense fallback={<p className="p-3 text-xs text-muted-foreground">Loading terminal…</p>}>
              <TerminalView ptyId={ptyId} visible={open && ptyId === active} onState={(s) => setState(ptyId, s)} />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabStatus({ state, nodeRunId, title }: { state: PtyState | undefined; nodeRunId: string | null; title: string }) {
  const nodeRun = useRunStore((s) => (nodeRunId ? s.detail?.nodeRuns.find((n) => n.id === nodeRunId) : undefined));
  // Any node with a Claude session, merges that resolved conflicts with Claude included.
  const canReopen = state?.phase !== "live" && !!nodeRun?.sessionId;
  return (
    <div className="flex shrink-0 items-center gap-2 pl-2 text-[11px]">
      <GraceCountdown nodeRun={nodeRun} compact />
      {state?.phase === "live" && <span className="text-green-600">Live — you can type</span>}
      {state?.phase === "replay" && <span className="text-muted-foreground">Read-only replay</span>}
      {state?.phase === "connecting" && <span className="text-muted-foreground">Connecting…</span>}
      {state?.phase === "error" && <span className="text-red-600">{state.message}</span>}
      {canReopen && nodeRunId && (
        <Button size="sm" onClick={() => void reopenSession(nodeRunId, title)} title="claude --resume in a new terminal (not part of the run)">
          Reopen session
        </Button>
      )}
    </div>
  );
}
