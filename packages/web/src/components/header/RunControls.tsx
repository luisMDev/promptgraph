import { formatCostUsd, isFinalRunStatus } from "@promptgraph/shared";
import { Loader2Icon, Redo2Icon, Undo2Icon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime } from "../../lib/format";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { cancelRun, resumeRun, startRun } from "../../store/app-actions";
import { useAppStore } from "../../store/app-store";
import { canRedo, canUndo, useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { Icons } from "../common/icons";
import { ConfirmDialog } from "../common/PromptDialog";
import { Button, StatusDot } from "../common/ui";

/**
 * Undo / Redo of the editor's local edits. Always shown next to the run controls so the row never shifts; disabled
 * while there is nothing to undo or redo, while the graph is read-only and while a run is shown.
 */
export function UndoRedoControls() {
  const runMode = useRunStore((s) => s.selectedRunId !== null);
  const undoable = useEditorStore((s) => !runMode && canUndo(s));
  const redoable = useEditorStore((s) => !runMode && canRedo(s));
  const hasGraph = useEditorStore((s) => s.graph !== null);
  if (!hasGraph) return null;
  return (
    <div className="flex items-center rounded-lg bg-card shadow-soft ring-1 ring-border">
      <IconAction label="Undo" shortcut="Ctrl+Z" disabled={!undoable} onClick={() => useEditorStore.getState().undo()}>
        <Undo2Icon />
      </IconAction>
      <IconAction label="Redo" shortcut="Ctrl+Shift+Z" disabled={!redoable} onClick={() => useEditorStore.getState().redo()}>
        <Redo2Icon />
      </IconAction>
    </div>
  );
}

function IconAction({ label, shortcut, disabled, onClick, children }: { label: string; shortcut: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events: the wrapper keeps the tooltip working. */}
        <span className="inline-flex">
          <Button variant="ghost" size="icon" aria-label={label} disabled={disabled} onClick={onClick}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {label} <span className="text-muted-foreground">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo; ignored while typing in a field or a terminal. */
export function useUndoRedoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || isTextTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const redo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
      if (!redo && !(key === "z" && !e.shiftKey)) return;
      e.preventDefault();
      const editor = useEditorStore.getState();
      if (redo) editor.redo();
      else editor.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** Run / Cancel, validation summary, and the total cost of the shown run. Floats over the canvas, top right. */
export function RunControls() {
  const graph = useEditorStore((s) => s.graph);
  const errors = useEditorStore((s) => s.validation.errors.length);
  const warnings = useEditorStore((s) => s.validation.warnings.length);
  const activeRunId = useEditorStore((s) => s.activeRunId);
  const detail = useRunStore((s) => s.detail);
  const activeRun = useRunStore((s) => s.runs.find((r) => r.id === activeRunId) ?? null);
  const currentByNode = useRunStore((s) => s.currentByNode);
  const [starting, setStarting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (!graph) return null;

  const shownRun = detail?.run ?? null;
  const cancellable = activeRunId !== null;
  // A paused run with nothing to retry or skip (e.g. stopped while lanes were being created) resumes as is.
  const resumable =
    activeRun?.status === "paused" &&
    (detail?.run.id !== activeRun.id ||
      !Object.values(currentByNode).some((nr) => nr.status === "failed" || nr.status === "interrupted" || nr.status === "cancelled"));
  const runDisabled = errors > 0 || starting || activeRunId !== null || graph.nodes.length === 0;
  const runTitle = errors
    ? `Fix ${errors} validation error${errors > 1 ? "s" : ""} first`
    : activeRunId
      ? "A run of this graph is already active"
      : graph.nodes.length === 0
        ? "Add nodes first"
        : warnings
          ? `${warnings} warning${warnings > 1 ? "s" : ""} (non-blocking)`
          : "Run the graph";

  return (
    <div className="flex items-center gap-2">
      {(errors > 0 || warnings > 0) && !detail && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useEditorStore.getState().setSelection([], [])}
          title="Show problems in the inspector"
          className={`gap-1 text-xs shadow-soft ring-1 ring-border ${errors ? "bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-700 dark:bg-red-950 dark:hover:bg-red-900" : "bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-700 dark:bg-amber-950 dark:hover:bg-amber-900"}`}
        >
          <Icons.alert />
          {errors > 0 && `${errors} error${errors > 1 ? "s" : ""}`}
          {errors > 0 && warnings > 0 && " · "}
          {warnings > 0 && `${warnings} warning${warnings > 1 ? "s" : ""}`}
        </Button>
      )}
      {shownRun && (
        <span className="rounded-md bg-card px-2 py-1 font-mono text-xs text-muted-foreground shadow-soft ring-1 ring-border" title={`${shownRun.usage.inputTokens + shownRun.usage.outputTokens} input+output tokens (estimated cost)`}>
          {formatCostUsd(shownRun.usage.costUsd)}
        </span>
      )}
      {shownRun && (
        <Button onClick={() => useUiStore.getState().openReport(shownRun.id)} title="Results, changes, commits, cost and where the run stopped">
          Report
        </Button>
      )}
      {resumable && (
        <Button variant="primary" onClick={() => void resumeRun(activeRun.id)} title="Continue the paused run">
          <Icons.play /> Resume
        </Button>
      )}
      <UndoRedoControls />
      {cancellable ? (
        <Button variant="danger" onClick={() => setConfirmCancel(true)}>
          <Icons.stop /> Cancel
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={runDisabled}
          title={runTitle}
          onClick={async () => {
            setStarting(true);
            await startRun();
            setStarting(false);
          }}
        >
          <Icons.play /> Run
        </Button>
      )}
      {confirmCancel && activeRunId && (
        <ConfirmDialog
          title="Cancel run"
          message={`Cancel run${activeRun ? ` #${activeRun.shortId}` : ""}? Running Claude sessions will be asked to exit and unfinished nodes are cancelled.`}
          confirmLabel="Cancel run"
          onConfirm={() => void cancelRun(activeRunId)}
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}

/**
 * Autosave indicator next to the run controls: a spinner while an edit is pending or being written, the error if
 * the last save failed, and nothing once the graph is saved.
 */
export function SaveIndicator() {
  const pending = useEditorStore((s) => s.saving || s.dirty);
  const saveError = useEditorStore((s) => s.saveError);
  const hasGraph = useEditorStore((s) => s.graph !== null);
  const runMode = useRunStore((s) => s.selectedRunId !== null);
  if (!hasGraph || runMode) return null;
  if (saveError) {
    return (
      <span role="alert" className="flex max-w-64 items-center gap-1.5 rounded-md bg-card px-2 py-1 text-xs text-red-700 shadow-soft ring-1 ring-border" title={saveError}>
        <Icons.alert className="shrink-0" />
        <span className="truncate">{saveError}</span>
      </span>
    );
  }
  if (!pending) return null;
  return (
    <span role="status" className="flex items-center gap-1.5 rounded-md bg-card px-2 py-1 text-xs text-muted-foreground shadow-soft ring-1 ring-border">
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
      Saving…
    </span>
  );
}

/** Value of the editor entry in the run selector's radio group (run ids are never empty). */
const EDITOR_VALUE = "";

/** Switch between the editor and live/historical runs of the current graph. */
export function RunSelector() {
  const runs = useRunStore((s) => s.runs);
  const selectedRunId = useRunStore((s) => s.selectedRunId);
  const graph = useEditorStore((s) => s.graph);
  if (!graph) return null;
  const selected = runs.find((r) => r.id === selectedRunId);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button className="gap-2 px-2.5 font-normal">
          {selected ? (
            <>
              <StatusDot className={RUN_STATUS_STYLE[selected.status].dot} />
              <span>Run #{selected.shortId}</span>
              <span className="text-xs text-muted-foreground">{isFinalRunStatus(selected.status) ? "history" : "live"}</span>
            </>
          ) : selectedRunId ? (
            <span>Run</span>
          ) : (
            <>
              <Icons.edit className="text-muted-foreground" />
              <span>Editor</span>
            </>
          )}
          <Icons.chevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuRadioGroup value={selectedRunId ?? EDITOR_VALUE}>
          <DropdownMenuRadioItem value={EDITOR_VALUE} className="gap-2 py-1.5 pl-3" onSelect={() => void useRunStore.getState().selectRun(null)}>
            <Icons.edit className="text-muted-foreground" />
            <span>Editor</span>
          </DropdownMenuRadioItem>
          <div className="max-h-80 overflow-y-auto">
            {runs.map((r) => (
              <DropdownMenuRadioItem key={r.id} value={r.id} className="gap-2 py-1.5 pl-3" onSelect={() => void useRunStore.getState().selectRun(r.id)}>
                <StatusDot className={RUN_STATUS_STYLE[r.status].dot} />
                <span className="font-mono text-xs">#{r.shortId}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(r.startedAt)}</span>
                <span className={`text-xs ${RUN_STATUS_STYLE[r.status].text}`}>{isFinalRunStatus(r.status) ? RUN_STATUS_STYLE[r.status].label : "live"}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{formatCostUsd(r.usage.costUsd)}</span>
              </DropdownMenuRadioItem>
            ))}
          </div>
        </DropdownMenuRadioGroup>
        {runs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="px-3 py-1.5 text-xs text-muted-foreground" onSelect={() => useUiStore.getState().setLeftPanel("history")}>
              Open run history…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Header counter of approvals waiting across all runs of the repo; click one to review it. */
export function PendingApprovals() {
  const pending = useAppStore((s) => s.pending);
  const runs = useAppStore((s) => s.pendingRuns);
  const count = pending.length;
  const label = count ? `${count} approval${count > 1 ? "s" : ""} pending` : "No pending approvals";

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={label} className={`relative ${count ? "text-violet-700" : "text-muted-foreground"}`}>
              <Icons.bell />
              {count > 0 && (
                <Badge className="absolute -top-0.5 -right-0.5 h-4 min-w-4 bg-violet-500 px-1 text-[10px] font-semibold text-white">{count}</Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        {count === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No approvals pending.</p>}
        {pending.map((nr) => {
          const info = runs[nr.runId];
          return (
            <DropdownMenuItem key={nr.id} className="gap-2 px-3 py-2" onSelect={() => useUiStore.getState().openApproval(nr.id)}>
              <StatusDot className="bg-status-waiting-approval" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{info?.nodeLabels[nr.nodeId] ?? nr.nodeId}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{info ? `${info.graphName} · run #${info.shortId}` : `run ${nr.runId}`}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
