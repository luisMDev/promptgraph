import { costLabel, isFinalRunStatus, webRoutes, type RunSummary } from "@promptgraph/shared";
import { useState } from "react";
import { formatDateTime, formatDuration, prLabel } from "../../lib/format";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { Link } from "../../lib/router/Link";
import { cleanupRun } from "../../store/view/actions";
import { useEditor, useRun, useView } from "../../store/view/context";
import { Icons } from "../common/icons";
import { LaneBadge } from "../common/LaneBadge";
import { Button, ButtonLink, StatusDot } from "../common/ui";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Run history of the current graph: status, start, duration, cost; expand for lanes, branches, pushed state
 * and PR links; "Clean up" removes worktrees. Each row links to the run (read-only on the canvas) and to its
 * report, so Ctrl-click opens them in a new tab.
 */
export function RunHistory() {
  const view = useView();
  const runs = useRun((s) => s.runs);
  const selectedRunId = useRun((s) => s.selectedRunId);
  const graphId = useEditor((s) => s.graphId);

  return (
    <div className="flex h-full flex-col">
      {graphId && (
        <ButtonLink
          variant="ghost"
          to={webRoutes.graph(view.repoId, graphId)}
          aria-current={selectedRunId === null || undefined}
          className={`mx-2 mt-2 justify-start px-2 text-[13px] font-normal ${selectedRunId === null ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
        >
          Editor (current graph)
        </ButtonLink>
      )}
      <div className="mt-2 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {runs.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No runs yet.</p>}
        {runs.map((run) => (
          <RunRow key={run.id} run={run} selected={run.id === selectedRunId} />
        ))}
      </div>
    </div>
  );
}

function RunRow({ run, selected }: { run: RunSummary; selected: boolean }) {
  const view = useView();
  const final = isFinalRunStatus(run.status);
  // A paused run (e.g. the server stopped) does not keep counting.
  const now = useNow(!final && run.status !== "paused");
  const style = RUN_STATUS_STYLE[run.status];
  const attention = run.pendingApprovals + run.waitingInput;
  const [expanded, setExpanded] = useState(false);
  const expandLabel = expanded ? "Hide lanes and PRs" : "Show lanes, branches and PRs";
  const [cleaning, setCleaning] = useState(false);
  const runPath = webRoutes.run(view.repoId, run.id);
  return (
    // The card is clickable for the mouse; keyboard and screen readers use the header link, so the
    // nested controls (expand, Clean up) are not inside another interactive element.
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        if (next) void view.run.getState().loadRunInfo(run.id);
        setExpanded(next);
      }}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        if (e.ctrlKey || e.metaKey) view.openInNewTab(runPath, { activate: e.shiftKey });
        else view.navigate(runPath);
      }}
      className={`cursor-pointer rounded-md border px-2.5 py-2 text-xs ${selected ? "border-primary/30 bg-primary/5" : "hover:border-ring/40 hover:bg-accent/50"}`}
    >
      <div className="flex items-center gap-2">
        <ButtonLink
          variant="ghost"
          size="xs"
          to={runPath}
          aria-current={selected || undefined}
          aria-label={`Open run #${run.shortId} (${style.label})`}
          className="h-auto gap-2 px-0 text-xs font-normal hover:bg-transparent dark:hover:bg-transparent"
          onClick={(e) => e.stopPropagation()}
        >
          <StatusDot className={`${style.dot} ${run.status === "running" ? "animate-pulse" : ""}`} />
          <span className={`font-medium ${style.text}`}>{style.label}</span>
          <span className="font-mono text-muted-foreground">#{run.shortId}</span>
        </ButtonLink>
        {attention > 0 && <Badge className="h-4 bg-amber-500/20 px-1.5 text-[10px] font-normal text-amber-700">{attention} waiting</Badge>}
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={expandLabel}
                className="ml-auto text-muted-foreground"
                // The card behind opens the run; expanding must not.
                onClick={(e) => e.stopPropagation()}
              >
                <Icons.chevronDown className={expanded ? "rotate-180" : ""} />
              </Button>
            </CollapsibleTrigger>
          </TooltipTrigger>
          <TooltipContent>{expandLabel}</TooltipContent>
        </Tooltip>
      </div>
      <div className="mt-1 flex items-center gap-2 text-muted-foreground">
        <span className="whitespace-nowrap">{formatDateTime(run.startedAt)}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="whitespace-nowrap tabular-nums">{formatDuration((run.finishedAt ?? now) - run.startedAt)}</span>
        <span className="ml-auto font-mono" title={costLabel(run.usage.costUsd, run.billingMode).title}>
          {costLabel(run.usage.costUsd, run.billingMode).text}
        </span>
      </div>
      {run.error && <div className={`mt-1 line-clamp-2 ${run.status === "paused" ? "text-amber-700/90" : "text-red-700/90"}`}>{run.error}</div>}
      <CollapsibleContent>
        <RunRowDetails runId={run.id} />
      </CollapsibleContent>
      <div className="mt-1.5 flex items-center gap-2">
        <ButtonLink
          size="sm"
          variant="ghost"
          className="-ml-2"
          to={webRoutes.report(view.repoId, run.id)}
          title="Results, changes, commits, cost and where the run stopped"
          onClick={(e) => e.stopPropagation()}
        >
          Report
        </ButtonLink>
        {final &&
          (run.cleanedUp ? (
            <span className="text-[11px] text-muted-foreground">Worktrees cleaned up</span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={cleaning}
              title="Remove this run's worktrees and its unpushed branches without commits (branches with commits are kept)"
              onClick={async (e) => {
                e.stopPropagation();
                setCleaning(true);
                await cleanupRun(view, run.id);
                setCleaning(false);
              }}
            >
              <Icons.trash /> {cleaning ? "Cleaning up…" : "Clean up"}
            </Button>
          ))}
      </div>
    </Collapsible>
  );
}

/** Lanes (colour, branch, state, pushed) and PR links of a run. */
function RunRowDetails({ runId }: { runId: string }) {
  const info = useRun((s) => s.runInfo[runId]);
  if (!info) return <p className="mt-1.5 text-[11px] text-muted-foreground">Loading…</p>;
  return (
    <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
      <Separator className="mb-1.5" />
      {info.prs.map((pr) => (
        <a key={pr.nodeId} href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-blue-600 hover:underline" title={`${pr.label}: ${pr.url}`}>
          <Icons.pr className="shrink-0" />
          <span className="truncate">{prLabel(pr.url)}</span>
          <Icons.externalLink className="shrink-0 text-[10px]" />
        </a>
      ))}
      {info.lanes.length === 0 && <p className="text-[11px] text-muted-foreground">No lanes.</p>}
      {info.lanes.map((lane) => (
        <div key={lane.id} className="flex items-center gap-1.5">
          <LaneBadge id={lane.id} index={lane.index} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85" title={lane.branch}>
            {lane.branch}
          </span>
          {lane.pushed && <Badge className="h-4 rounded-sm bg-indigo-500/20 px-1 text-[10px] font-normal text-indigo-700">pushed</Badge>}
          <span className="text-[10px] text-muted-foreground">{lane.status}</span>
        </div>
      ))}
    </div>
  );
}
