import { useAppStore } from "../../store/app-store";
import { useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { SettingsMenu } from "../settings/SettingsMenu";
import { GraphSelector } from "./GraphSelector";
import { PendingApprovals, RunControls, RunSelector } from "./RunControls";

/** Top bar (§13): graph selector, run selector, save state, Run/Cancel, pending approvals, settings. */
export function Header() {
  const repo = useAppStore((s) => s.repo);
  const connected = useAppStore((s) => s.connected);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3">
      <div className="flex items-center gap-2 pr-1">
        <Logo />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">promptgraph</span>
        {repo && <span className="hidden max-w-40 truncate text-xs text-zinc-500 lg:inline" title={repo.path}>{repo.name}</span>}
      </div>
      <div className="h-5 w-px bg-zinc-800" />
      <GraphSelector />
      <RunSelector />
      <SaveState />
      <div className="ml-auto flex items-center gap-2">
        {!connected && <span className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">Reconnecting…</span>}
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
  return <span className="text-xs text-zinc-500">{saving || dirty ? "Saving…" : "Saved"}</span>;
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
