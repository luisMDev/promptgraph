import { formatCostUsd, isFinalRunStatus } from "@promptgraph/shared";
import { useRef, useState, type ReactNode } from "react";
import { formatDateTime } from "../../lib/format";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { cancelRun, resumeRun, startRun } from "../../store/app-actions";
import { useAppStore } from "../../store/app-store";
import { useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { Icons } from "../common/icons";
import { ConfirmDialog } from "../common/PromptDialog";
import { Button, StatusDot, useDismiss } from "../common/ui";

/** Run / Cancel, validation summary, and the total cost of the shown run. */
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
        <button
          type="button"
          onClick={() => useEditorStore.getState().setSelection([], [])}
          title="Show problems in the inspector"
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${errors ? "bg-red-500/10 text-red-300" : "bg-amber-500/10 text-amber-300"}`}
        >
          <Icons.alert />
          {errors > 0 && `${errors} error${errors > 1 ? "s" : ""}`}
          {errors > 0 && warnings > 0 && " · "}
          {warnings > 0 && `${warnings} warning${warnings > 1 ? "s" : ""}`}
        </button>
      )}
      {shownRun && (
        <span className="font-mono text-xs text-zinc-400" title={`${shownRun.usage.inputTokens + shownRun.usage.outputTokens} input+output tokens (estimated cost)`}>
          {formatCostUsd(shownRun.usage.costUsd)}
        </span>
      )}
      {resumable && (
        <Button variant="primary" onClick={() => void resumeRun(activeRun.id)} title="Continue the paused run">
          <Icons.play /> Resume
        </Button>
      )}
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

/** Switch between the editor and live/historical runs of the current graph. */
export function RunSelector() {
  const runs = useRunStore((s) => s.runs);
  const selectedRunId = useRunStore((s) => s.selectedRunId);
  const graph = useEditorStore((s) => s.graph);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  if (!graph) return null;
  const selected = runs.find((r) => r.id === selectedRunId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-zinc-300 ring-1 ring-zinc-800 ring-inset hover:bg-zinc-800"
      >
        {selected ? (
          <>
            <StatusDot className={RUN_STATUS_STYLE[selected.status].dot} />
            <span>Run #{selected.shortId}</span>
            <span className="text-xs text-zinc-500">{isFinalRunStatus(selected.status) ? "history" : "live"}</span>
          </>
        ) : selectedRunId ? (
          <span>Run</span>
        ) : (
          <>
            <Icons.edit className="text-zinc-500" />
            <span>Editor</span>
          </>
        )}
        <Icons.chevronDown className="text-zinc-500" />
      </button>
      {open && (
        <div className="absolute top-10 left-0 z-40 w-80 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl">
          <SelectorItem
            active={selectedRunId === null}
            onClick={() => {
              setOpen(false);
              void useRunStore.getState().selectRun(null);
            }}
          >
            <Icons.edit className="text-zinc-500" />
            <span>Editor</span>
          </SelectorItem>
          <div className="max-h-80 overflow-y-auto">
            {runs.map((r) => (
              <SelectorItem
                key={r.id}
                active={r.id === selectedRunId}
                onClick={() => {
                  setOpen(false);
                  void useRunStore.getState().selectRun(r.id);
                }}
              >
                <StatusDot className={RUN_STATUS_STYLE[r.status].dot} />
                <span className="font-mono text-xs">#{r.shortId}</span>
                <span className="text-xs text-zinc-400">{formatDateTime(r.startedAt)}</span>
                <span className={`text-xs ${RUN_STATUS_STYLE[r.status].text}`}>{isFinalRunStatus(r.status) ? RUN_STATUS_STYLE[r.status].label : "live"}</span>
                <span className="ml-auto font-mono text-xs text-zinc-500">{formatCostUsd(r.usage.costUsd)}</span>
              </SelectorItem>
            ))}
          </div>
          {runs.length > 0 && (
            <button
              type="button"
              className="w-full rounded-md px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              onClick={() => {
                setOpen(false);
                useUiStore.getState().setLeftPanel("history");
              }}
            >
              Open run history…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SelectorItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 ${active ? "bg-zinc-800/70" : ""}`}
    >
      {children}
    </button>
  );
}

/** Header counter of approvals waiting across all runs of the repo; click one to review it. */
export function PendingApprovals() {
  const pending = useAppStore((s) => s.pending);
  const runs = useAppStore((s) => s.pendingRuns);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const count = pending.length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={count ? `${count} approval${count > 1 ? "s" : ""} pending` : "No pending approvals"}
        onClick={() => setOpen(!open)}
        className={`relative flex size-8 items-center justify-center rounded-md hover:bg-zinc-800 ${count ? "text-violet-300" : "text-zinc-500"}`}
      >
        <Icons.bell />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-500 px-1 text-[10px] font-semibold text-white">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-10 right-0 z-40 w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl">
          {count === 0 && <p className="px-3 py-2 text-xs text-zinc-500">No approvals pending.</p>}
          {pending.map((nr) => {
            const info = runs[nr.runId];
            return (
              <button
                key={nr.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  useUiStore.getState().openApproval(nr.id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
              >
                <StatusDot className="bg-status-waiting-approval" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{info?.nodeLabels[nr.nodeId] ?? nr.nodeId}</span>
                  <span className="block truncate text-[11px] text-zinc-500">{info ? `${info.graphName} · run #${info.shortId}` : `run ${nr.runId}`}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
