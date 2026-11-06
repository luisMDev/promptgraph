import { costLabel, isFinalRunStatus, webRoutes } from "@promptgraph/shared";
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
import { Link } from "../../lib/router/Link";
import { installUndoKeys } from "../../lib/undo-keys";
import { cancelRun, resumeRun, startRun } from "../../store/view/actions";
import { useEditor, useRepo, useRun, useTabActive, useView } from "../../store/view/context";
import { canRedo, canUndo } from "../../store/view/editor-store";
import { Icons } from "../common/icons";
import { ConfirmDialog } from "../common/PromptDialog";
import { Button, ButtonLink, StatusDot } from "../common/ui";

/**
 * Undo / Redo of the editor's local edits, left of Run. Always shown while a graph is open, so the row never
 * shifts; disabled while there is nothing to undo or redo, while the graph is read-only and while a run is shown.
 */
export function UndoRedoControls() {
  const { editor } = useView();
  const runMode = useRun((s) => s.selectedRunId !== null);
  const undoable = useEditor((s) => !runMode && canUndo(s));
  const redoable = useEditor((s) => !runMode && canRedo(s));
  return (
    <div role="group" aria-label="History" className="flex items-center rounded-lg bg-card shadow-soft ring-1 ring-border">
      <IconAction label="Undo" shortcut="Ctrl+Z" disabled={!undoable} onClick={() => editor.getState().undo()}>
        <Undo2Icon />
      </IconAction>
      <IconAction label="Redo" shortcut="Ctrl+Shift+Z" disabled={!redoable} onClick={() => editor.getState().redo()}>
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

/** Installs the undo / redo shortcuts for the visible view's editor (hidden tab views install none). */
export function useUndoRedoShortcuts() {
  const { editor } = useView();
  const active = useTabActive();
  const runMode = useRun((s) => s.selectedRunId !== null);
  useEffect(() => {
    if (!active || runMode) return;
    return installUndoKeys(window, (action) => (action === "undo" ? editor.getState().undo() : editor.getState().redo()));
  }, [editor, active, runMode]);
}

/** Run / Cancel, validation summary, and the total cost of the shown run. Floats over the canvas, top right. */
export function RunControls() {
  const view = useView();
  const graph = useEditor((s) => s.graph);
  const errors = useEditor((s) => s.validation.errors.length);
  const warnings = useEditor((s) => s.validation.warnings.length);
  const activeRunId = useEditor((s) => s.activeRunId);
  const detail = useRun((s) => s.detail);
  const activeRun = useRun((s) => s.runs.find((r) => r.id === activeRunId) ?? null);
  const currentByNode = useRun((s) => s.currentByNode);
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
          onClick={() => view.editor.getState().setSelection([], [])}
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
        <span className="rounded-md bg-card px-2 py-1 font-mono text-xs text-muted-foreground shadow-soft ring-1 ring-border" title={`${shownRun.usage.inputTokens + shownRun.usage.outputTokens} input+output tokens. ${costLabel(shownRun.usage.costUsd, shownRun.billingMode).title}`}>
          {costLabel(shownRun.usage.costUsd, shownRun.billingMode).text}
        </span>
      )}
      {shownRun && (
        <ButtonLink to={webRoutes.report(view.repoId, shownRun.id)} title="Results, changes, commits, cost and where the run stopped">
          Report
        </ButtonLink>
      )}
      {resumable && (
        <Button variant="primary" onClick={() => void resumeRun(view, activeRun.id)} title="Continue the paused run">
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
            await startRun(view);
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
          onConfirm={() => void cancelRun(view, activeRunId)}
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
  const pending = useEditor((s) => s.saving || s.dirty);
  const saveError = useEditor((s) => s.saveError);
  const hasGraph = useEditor((s) => s.graph !== null);
  const runMode = useRun((s) => s.selectedRunId !== null);
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

/** Switch between the editor and live/historical runs of the current graph; every entry is a link. */
export function RunSelector() {
  const view = useView();
  const runs = useRun((s) => s.runs);
  const selectedRunId = useRun((s) => s.selectedRunId);
  const graph = useEditor((s) => s.graph);
  const graphId = useEditor((s) => s.graphId);
  if (!graph || !graphId) return null;
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
          <DropdownMenuRadioItem value={EDITOR_VALUE} className="gap-2 py-1.5 pl-3" asChild>
            <Link to={webRoutes.graph(view.repoId, graphId)}>
              <Icons.edit className="text-muted-foreground" />
              <span>Editor</span>
            </Link>
          </DropdownMenuRadioItem>
          <div className="max-h-80 overflow-y-auto">
            {runs.map((r) => (
              <DropdownMenuRadioItem key={r.id} value={r.id} className="gap-2 py-1.5 pl-3" asChild>
                <Link to={webRoutes.run(view.repoId, r.id)}>
                  <StatusDot className={RUN_STATUS_STYLE[r.status].dot} />
                  <span className="font-mono text-xs">#{r.shortId}</span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(r.startedAt)}</span>
                  <span className={`text-xs ${RUN_STATUS_STYLE[r.status].text}`}>{isFinalRunStatus(r.status) ? RUN_STATUS_STYLE[r.status].label : "live"}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground" title={costLabel(r.usage.costUsd, r.billingMode).title}>
                    {costLabel(r.usage.costUsd, r.billingMode).text}
                  </span>
                </Link>
              </DropdownMenuRadioItem>
            ))}
          </div>
        </DropdownMenuRadioGroup>
        {runs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="px-3 py-1.5 text-xs text-muted-foreground" onSelect={() => view.ui.getState().setLeftPanel("history")}>
              Open run history…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Header counter of approvals waiting across all runs of the repo. Each entry links to its node run (DESIGN
 * §13.2) and, on a plain click, opens the approval dialog there.
 */
export function PendingApprovals() {
  const view = useView();
  const pending = useRepo((s) => s.pending);
  const runs = useRepo((s) => s.pendingRuns);
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
            <DropdownMenuItem key={nr.id} className="gap-2 px-3 py-2" asChild>
              <Link
                to={webRoutes.nodeRun(view.repoId, nr.runId, nr.id)}
                onClick={(e) => {
                  if (!(e.ctrlKey || e.metaKey) && e.button === 0) view.ui.getState().openApproval(nr.id);
                }}
              >
                <StatusDot className="bg-status-waiting-approval" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{info?.nodeLabels[nr.nodeId] ?? nr.nodeId}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{info ? `${info.graphName} · run #${info.shortId}` : `run ${nr.runId}`}</span>
                </span>
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
