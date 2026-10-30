import { formatCostUsd, isFinalRunStatus, type RunSummary } from "@promptgraph/shared";
import { useState } from "react";
import { formatDateTime, formatDuration, prLabel } from "../../lib/format";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { cleanupRun } from "../../store/app-actions";
import { useRunStore } from "../../store/run-store";
import { Icons } from "../common/icons";
import { LaneBadge } from "../common/LaneBadge";
import { Button, StatusDot } from "../common/ui";

/**
 * Run history of the current graph: status, start, duration, cost; expand for lanes, branches, pushed state
 * and PR links; "Clean up" removes worktrees. Click opens the run read-only on the canvas.
 */
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
  const [expanded, setExpanded] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const open = () => void useRunStore.getState().selectRun(run.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
      className={`cursor-pointer rounded-md border px-2.5 py-2 text-xs ${selected ? "border-blue-500/60 bg-blue-500/10" : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50"}`}
    >
      <div className="flex items-center gap-2">
        <StatusDot className={`${style.dot} ${run.status === "running" ? "animate-pulse" : ""}`} />
        <span className={`font-medium ${style.text}`}>{style.label}</span>
        <span className="font-mono text-zinc-500">#{run.shortId}</span>
        {attention > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-300">{attention} waiting</span>}
        <button
          type="button"
          aria-expanded={expanded}
          title={expanded ? "Hide lanes and PRs" : "Show lanes, branches and PRs"}
          className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
          onClick={(e) => {
            e.stopPropagation();
            if (!expanded) void useRunStore.getState().loadRunInfo(run.id);
            setExpanded(!expanded);
          }}
        >
          <Icons.chevronDown className={expanded ? "rotate-180" : ""} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 text-zinc-400">
        <span className="whitespace-nowrap">{formatDateTime(run.startedAt)}</span>
        <span className="text-zinc-600">·</span>
        <span className="whitespace-nowrap tabular-nums">{formatDuration((run.finishedAt ?? now) - run.startedAt)}</span>
        <span className="ml-auto font-mono">{formatCostUsd(run.usage.costUsd)}</span>
      </div>
      {run.error && <div className="mt-1 line-clamp-2 text-red-300/90">{run.error}</div>}
      {expanded && <RunRowDetails runId={run.id} />}
      {final && (
        <div className="mt-1.5 flex items-center gap-2">
          {run.cleanedUp ? (
            <span className="text-[11px] text-zinc-500">Worktrees cleaned up</span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2"
              disabled={cleaning}
              title="Remove this run's worktrees and its unpushed branches without commits (branches with commits are kept)"
              onClick={async (e) => {
                e.stopPropagation();
                setCleaning(true);
                await cleanupRun(run.id);
                setCleaning(false);
              }}
            >
              <Icons.trash /> {cleaning ? "Cleaning up…" : "Clean up"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lanes (colour, branch, state, pushed) and PR links of a run. */
function RunRowDetails({ runId }: { runId: string }) {
  const info = useRunStore((s) => s.runInfo[runId]);
  if (!info) return <p className="mt-1.5 text-[11px] text-zinc-500">Loading…</p>;
  return (
    <div className="mt-1.5 space-y-1 border-t border-zinc-800 pt-1.5" onClick={(e) => e.stopPropagation()}>
      {info.prs.map((pr) => (
        <a key={pr.nodeId} href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-400 hover:underline" title={`${pr.label}: ${pr.url}`}>
          <Icons.pr className="shrink-0" />
          <span className="truncate">{prLabel(pr.url)}</span>
          <Icons.externalLink className="shrink-0 text-[10px]" />
        </a>
      ))}
      {info.lanes.length === 0 && <p className="text-[11px] text-zinc-500">No lanes.</p>}
      {info.lanes.map((lane) => (
        <div key={lane.id} className="flex items-center gap-1.5">
          <LaneBadge id={lane.id} index={lane.index} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300" title={lane.branch}>
            {lane.branch}
          </span>
          {lane.pushed && <span className="rounded bg-indigo-500/20 px-1 text-[10px] text-indigo-200">pushed</span>}
          <span className="text-[10px] text-zinc-500">{lane.status}</span>
        </div>
      ))}
    </div>
  );
}
