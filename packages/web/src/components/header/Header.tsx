import { useAppStore } from "../../store/app-store";
import { useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { Separator } from "../ui/separator";
import { SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { SettingsMenu } from "../settings/SettingsMenu";
import { GraphSelector } from "./GraphSelector";
import { PendingApprovals, RunControls, RunSelector } from "./RunControls";

/** Top bar (§13): sidebar toggle, graph selector, run selector, save state, Run/Cancel, pending approvals, settings. */
export function Header() {
  const repo = useAppStore((s) => s.repo);
  const connected = useAppStore((s) => s.connected);
  const sessionExpired = useAppStore((s) => s.sessionExpired);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-3">
      <div className="flex items-center gap-2 pr-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger aria-label="Toggle sidebar" className="-ml-1" />
          </TooltipTrigger>
          <TooltipContent>Toggle sidebar</TooltipContent>
        </Tooltip>
        <Logo />
        <span className="text-sm font-semibold tracking-tight text-foreground">promptgraph</span>
        {repo && <span className="hidden max-w-40 truncate text-xs text-muted-foreground lg:inline" title={repo.path}>{repo.name}</span>}
      </div>
      <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />
      <GraphSelector />
      <RunSelector />
      <SaveState />
      <div className="ml-auto flex items-center gap-2">
        {sessionExpired ? (
          <span role="alert" className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">
            The promptgraph server was restarted: open the new URL it printed in your terminal.
          </span>
        ) : (
          !connected && <span className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">Reconnecting…</span>
        )}
        <RunControls />
        <PendingApprovals />
        <SettingsMenu />
      </div>
    </header>
  );
}

function SaveState() {
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const saveError = useEditorStore((s) => s.saveError);
  const hasGraph = useEditorStore((s) => s.graph !== null);
  const runMode = useRunStore((s) => s.selectedRunId !== null);
  if (!hasGraph || runMode) return null;
  if (saveError) return <span className="max-w-64 truncate text-xs text-red-300" title={saveError}>{saveError}</span>;
  return <span className="text-xs text-muted-foreground">{saving || dirty ? "Saving…" : "Saved"}</span>;
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="2" y="3" width="8" height="6" rx="1.5" fill="#3b82f6" />
      <rect x="14" y="9" width="8" height="6" rx="1.5" fill="#8b5cf6" />
      <rect x="2" y="15" width="8" height="6" rx="1.5" fill="#22c55e" />
      <path d="M10 6h2a2 2 0 0 1 2 2v2M10 18h2a2 2 0 0 0 2-2v-2" stroke="#71717a" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
