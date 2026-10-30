import { formatCostUsd, isFinalRunStatus, type RunSummary } from "@promptgraph/shared";
import { formatDateTime, formatDuration } from "../../lib/format";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { cleanupRun } from "../../store/app-actions";
import { useRunStore } from "../../store/run-store";
import { Button, StatusDot } from "../common/ui";

/** Run history of the current graph: status, start, duration, cost; click opens the run read-only on the canvas. */
export function RunHistory() {
  const runs = useRunStore((s) => s.runs);
  const selectedRunId = useRunStore((s) => s.selectedRunId);

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={() => void useRunStore.getState().selectRun(null)}
        className={`mx-2 mt-2 rounded-md px-2 py-1.5 text-left text-[13px] ${selectedRunId === null ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60"}`}
      >
        Editor (current graph)
      </button>
      <div className="mt-2 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {runs.length === 0 && <p className="px-2 py-3 text-xs text-zinc-500">No runs yet.</p>}
        {runs.map((run) => (
          <RunRow key={run.id} run={run} selected={run.id === selectedRunId} />
        ))}
      </div>
    </div>
  );
}

function RunRow({ run, selected }: { run: RunSummary; selected: boolean }) {
  const final = isFinalRunStatus(run.status);
  const now = useNow(!final);
  const style = RUN_STATUS_STYLE[run.status];
  const attention = run.pendingApprovals + run.waitingInput;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void useRunStore.getState().selectRun(run.id)}
      onKeyDown={(e) => e.key === "Enter" && void useRunStore.getState().selectRun(run.id)}
      className={`group cursor-pointer rounded-md border px-2.5 py-2 text-xs ${selected ? "border-blue-500/60 bg-blue-500/10" : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50"}`}
    >
      <div className="flex items-center gap-2">
        <StatusDot className={`${style.dot} ${run.status === "running" ? "animate-pulse" : ""}`} />
        <span className={`font-medium ${style.text}`}>{style.label}</span>
        <span className="font-mono text-zinc-500">#{run.shortId}</span>
        {attention > 0 && <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-300">{attention} waiting</span>}
      </div>
      <div className="mt-1 flex items-center gap-2 text-zinc-400">
        <span>{formatDateTime(run.startedAt)}</span>
        <span className="text-zinc-600">·</span>
        <span className="tabular-nums">{formatDuration((run.finishedAt ?? now) - run.startedAt)}</span>
        <span className="ml-auto font-mono">{formatCostUsd(run.usage.costUsd)}</span>
      </div>
      {run.error && <div className="mt-1 line-clamp-2 text-red-300/90">{run.error}</div>}
      {final && !run.cleanedUp && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 -ml-2 hidden group-hover:inline-flex"
          title="Remove this run's worktrees and unpushed branches"
          onClick={(e) => {
            e.stopPropagation();
            void cleanupRun(run.id);
          }}
        >
          Clean up worktrees
        </Button>
      )}
    </div>
  );
}
