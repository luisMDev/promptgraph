import {
  formatCostUsd,
  isFinalRunStatus,
  type ChangeStats,
  type ReportLane,
  type ReportNode,
  type ReportStall,
  type RunReportResponse,
  type RunStatus,
} from "@promptgraph/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../../api/rest";
import { formatDateTime, formatDuration, formatTokens, prLabel } from "../../lib/format";
import { NODE_TYPE_META } from "../../lib/node-meta";
import { nodeRunStyle, RUN_STATUS_STYLE } from "../../lib/status-style";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { Icons, NodeTypeIcon } from "../common/icons";
import { LaneBadge } from "../common/LaneBadge";
import { Button, StatusDot } from "../common/ui";

/** Re-fetch at most this often while the run changes (run:update arrives on every node status change). */
const REFRESH_MS = 1000;

/**
 * Run report (§13.1): what happened while you were away. Result per node, what each node and lane
 * changed, commits, PRs, cost, duration, and where the run stopped or waited for you. Replaces the
 * editor view until closed; follows the run live.
 */
export function RunReport({ runId }: { runId: string }) {
  const [report, setReport] = useState<RunReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRunVersion(runId);
  /** Run of the last load: the first load of a run is immediate, refreshes are batched. */
  const loadedRun = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () =>
        api.runReport(runId).then(
          (r) => {
            if (cancelled) return;
            loadedRun.current = runId;
            setReport(r);
            setError(null);
          },
          (err: unknown) => !cancelled && setError(errorMessage(err)),
        ),
      loadedRun.current === runId ? REFRESH_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, version]);

  const close = () => useUiStore.getState().openReport(null);
  const showOnCanvas = (nodeId?: string) => {
    close();
    void useRunStore
      .getState()
      .selectRun(runId)
      .then(() => nodeId && useRunStore.getState().selectNode(nodeId));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-zinc-100">Run report</h1>
            {report && (
              <p className="text-xs text-zinc-500">
                {report.run.graphName} · run <span className="font-mono">#{report.run.shortId}</span> · started {formatDateTime(report.run.startedAt)}
              </p>
            )}
          </div>
          <Button size="sm" onClick={() => showOnCanvas()}>
            Show on canvas
          </Button>
          <Button size="sm" variant="ghost" onClick={close} aria-label="Close report">
            <Icons.x />
          </Button>
        </div>

        {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-200">Could not load the report: {error}</p>}
        {!report && !error && <p className="text-sm text-zinc-500">Loading report…</p>}
        {report && (
          <>
            <Summary report={report} />
            {report.stalls.length > 0 && <Stalls stalls={report.stalls} status={report.run.status} onShow={(nodeId) => showOnCanvas(nodeId)} nodes={report.nodes} />}
            {report.prs.length > 0 && (
              <ReportSection title="Pull requests">
                <ul className="space-y-1 text-sm">
                  {report.prs.map((pr) => (
                    <li key={pr.nodeRunId}>
                      <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-blue-400 hover:underline">
                        <Icons.pr /> {prLabel(pr.url)} <Icons.externalLink className="text-[10px]" />
                      </a>
                      <span className="ml-2 text-xs text-zinc-500">{pr.label}</span>
                    </li>
                  ))}
                </ul>
              </ReportSection>
            )}
            <Nodes nodes={report.nodes} onShow={showOnCanvas} />
            <Lanes runId={runId} lanes={report.lanes} />
          </>
        )}
      </div>
    </div>
  );
}

/** Changes whenever the run's summary changes (status, cost, waits, cleanup); drives report refreshes. */
function useRunVersion(runId: string): string {
  return useRunStore((s) => {
    const run = s.detail?.run.id === runId ? s.detail.run : s.runs.find((r) => r.id === runId);
    if (!run) return "";
    const nodes = s.detail?.run.id === runId ? s.detail.nodeRuns.map((n) => `${n.id}:${n.status}:${n.snapshotEnd ?? ""}`).join(",") : "";
    return `${run.status}|${run.finishedAt}|${run.cleanedUp}|${run.usage.costUsd}|${run.waitingInput}|${run.pendingApprovals}|${nodes}`;
  });
}

function Summary({ report }: { report: RunReportResponse }) {
  const { run } = report;
  const style = RUN_STATUS_STYLE[run.status];
  const counts = new Map<string, number>();
  for (const n of report.nodes) counts.set(n.nodeRun.status, (counts.get(n.nodeRun.status) ?? 0) + 1);
  const waited = report.nodes.reduce((sum, n) => sum + n.waitingMs, 0);
  const tokens = run.usage.inputTokens + run.usage.outputTokens + run.usage.cacheCreationTokens + run.usage.cacheReadTokens;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <Stat label="Result">
        <span className={`flex items-center gap-2 ${style.text}`}>
          <StatusDot className={style.dot} /> {style.label}
        </span>
      </Stat>
      <Stat label="Duration">{formatDuration(report.durationMs)}</Stat>
      <Stat label="Waiting for you" hint="Time steps spent idle, waiting for input or for approval">
        {waited > 0 ? formatDuration(waited) : "None"}
      </Stat>
      <Stat label="Estimated cost" hint={`${formatTokens(tokens)} tokens`}>
        {formatCostUsd(run.usage.costUsd)}
      </Stat>
      <Stat label="Steps">
        <span className="text-sm">
          {[...counts].map(([status, n]) => `${n} ${status.replace("_", " ")}`).join(" · ")}
        </span>
      </Stat>
      {run.error && <p className="col-span-full rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-200">{run.error}</p>}
    </div>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5" title={hint}>
      <div className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-base font-medium text-zinc-100 tabular-nums">{children}</div>
    </div>
  );
}

const STALL_STYLE: Record<ReportStall["kind"], { label: string; className: string }> = {
  failed: { label: "Failed", className: "bg-red-500/15 text-red-200" },
  interrupted: { label: "Interrupted", className: "bg-orange-500/15 text-orange-200" },
  cancelled: { label: "Cancelled", className: "bg-zinc-700/50 text-zinc-200" },
  waiting: { label: "Waiting for you", className: "bg-amber-500/15 text-amber-200" },
  slow_wait: { label: "Long wait", className: "bg-sky-500/15 text-sky-200" },
};

function Stalls({ stalls, status, nodes, onShow }: { stalls: ReportStall[]; status: RunStatus; nodes: ReportNode[]; onShow: (nodeId: string) => void }) {
  const nodeIdOf = (nodeRunId: string) => nodes.find((n) => n.nodeRun.id === nodeRunId)?.nodeRun.nodeId;
  return (
    <ReportSection title={isFinalRunStatus(status) ? "Where it stopped or waited" : "Needs attention / waited"}>
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/60">
        {stalls.map((s) => {
          const nodeId = nodeIdOf(s.nodeRunId);
          return (
            <li key={`${s.kind}-${s.nodeRunId}`} className="flex items-start gap-3 px-3 py-2 text-sm">
              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STALL_STYLE[s.kind].className}`}>{STALL_STYLE[s.kind].label}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-zinc-100">{s.label}</div>
                <div className="text-xs whitespace-pre-wrap text-zinc-400">{s.message}</div>
              </div>
              {s.waitingMs > 0 && <span className="shrink-0 font-mono text-xs text-zinc-400 tabular-nums" title="Time spent waiting for you">{formatDuration(s.waitingMs)}</span>}
              {nodeId && (
                <Button size="sm" variant="ghost" onClick={() => onShow(nodeId)}>
                  Show
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </ReportSection>
  );
}

function Nodes({ nodes, onShow }: { nodes: ReportNode[]; onShow: (nodeId: string) => void }) {
  return (
    <ReportSection title="Steps">
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-900 text-[10px] tracking-wider text-zinc-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-semibold">Step</th>
              <th className="px-3 py-2 font-semibold">Result</th>
              <th className="px-3 py-2 text-right font-semibold">Duration</th>
              <th className="px-3 py-2 text-right font-semibold">Waited</th>
              <th className="px-3 py-2 font-semibold">Changes</th>
              <th className="px-3 py-2 text-right font-semibold">Cost</th>
              <th className="px-3 py-2 font-semibold">Output</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 bg-zinc-900/40">
            {nodes.map((n) => (
              <NodeRow key={n.nodeRun.id} node={n} onShow={onShow} />
            ))}
          </tbody>
        </table>
      </div>
    </ReportSection>
  );
}

function NodeRow({ node, onShow }: { node: ReportNode; onShow: (nodeId: string) => void }) {
  const nr = node.nodeRun;
  const style = nodeRunStyle(nr);
  const o = nr.output;
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <button type="button" className="flex items-center gap-2 text-left hover:underline" onClick={() => onShow(nr.nodeId)} title="Show on canvas">
          <span className={`flex size-5 shrink-0 items-center justify-center rounded text-[11px] ${NODE_TYPE_META[node.type].accent}`}>
            <NodeTypeIcon type={node.type} />
          </span>
          <span className="font-medium text-zinc-100">{node.label}</span>
        </button>
        {node.attempts > 1 && <span className="ml-7 text-[10px] text-zinc-500">{node.attempts} attempts</span>}
      </td>
      <td className="px-3 py-2">
        <span className={`flex items-center gap-1.5 whitespace-nowrap ${style.text}`}>
          <StatusDot className={style.dot} /> {style.label}
        </span>
      </td>
      <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-300 tabular-nums">{node.durationMs === null ? "—" : formatDuration(node.durationMs)}</td>
      <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-400 tabular-nums">{node.waitingMs > 0 ? formatDuration(node.waitingMs) : "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {node.changes ? (
          <button
            type="button"
            className="rounded hover:bg-zinc-800 disabled:cursor-default disabled:hover:bg-transparent"
            disabled={node.changes.files === 0}
            onClick={() => useUiStore.getState().openDiff({ kind: "node", nodeRunId: nr.id, title: `Changes · ${node.label}` })}
            title={node.changes.files ? "Show what this step changed" : "This step changed no files"}
          >
            <Stats changes={node.changes} />
          </button>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-300">{o?.usage ? formatCostUsd(o.usage.costUsd) : "—"}</td>
      <td className="max-w-80 px-3 py-2 text-zinc-300">
        {o?.prUrl && (
          <a href={o.prUrl} target="_blank" rel="noreferrer" className="block text-blue-400 hover:underline">
            {prLabel(o.prUrl)}
          </a>
        )}
        {o?.sha && (
          <span className="block truncate" title={o.message}>
            <span className="font-mono text-zinc-400">{o.sha.slice(0, 8)}</span> {o.message?.split("\n")[0]}
          </span>
        )}
        {o?.noop && <span className="block text-zinc-500">Nothing to commit</span>}
        {o?.approved !== undefined && <span className="block">{o.approved ? "Approved" : "Rejected"}{o.comment ? ` — ${o.comment}` : ""}</span>}
        {o?.port && <span className="block">Branch: {o.port}</span>}
        {o?.exitCode !== undefined && o.exitCode !== 0 && <span className="block text-red-300">Exit code {o.exitCode ?? "killed"}</span>}
        {nr.error && nr.status === "failed" && <span className="line-clamp-2 block text-red-300" title={nr.error}>{nr.error}</span>}
        {!o?.sha && !o?.prUrl && o?.text && nr.status !== "failed" && <span className="line-clamp-2 block text-zinc-400" title={o.text}>{o.text}</span>}
      </td>
    </tr>
  );
}

function Lanes({ runId, lanes }: { runId: string; lanes: ReportLane[] }) {
  if (lanes.length === 0) return null;
  return (
    <ReportSection title="Lanes">
      <div className="grid gap-3 md:grid-cols-2">
        {lanes.map(({ lane, changes, commits, head }) => (
          <div key={lane.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs">
            <div className="flex items-center gap-2">
              <LaneBadge id={lane.id} index={lane.index} />
              <span className="min-w-0 flex-1 truncate font-mono text-zinc-200" title={lane.branch}>
                {lane.branch}
              </span>
              {lane.pushed && <span className="rounded bg-indigo-500/20 px-1 text-[10px] text-indigo-200">pushed</span>}
              <span className="text-[10px] text-zinc-500">{lane.status}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Stats changes={changes} />
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={!head}
                onClick={() => useUiStore.getState().openDiff({ kind: "lane", runId, laneId: lane.id, title: `Lane ${lane.id} · ${lane.branch}` })}
              >
                View diff
              </Button>
            </div>
            {commits.length > 0 ? (
              <ul className="mt-2 space-y-0.5 border-t border-zinc-800 pt-2">
                {commits.map((c) => (
                  <li key={c.sha} className={`flex gap-2 ${c.checkpoint ? "text-zinc-500" : "text-zinc-300"}`} title={c.checkpoint ? "Automatic checkpoint (§9.3)" : undefined}>
                    <span className="font-mono text-zinc-500">{c.sha.slice(0, 8)}</span>
                    <span className="truncate">{c.subject}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 border-t border-zinc-800 pt-2 text-zinc-500">No commits.</p>
            )}
          </div>
        ))}
      </div>
    </ReportSection>
  );
}

function Stats({ changes }: { changes: ChangeStats }) {
  if (changes.files === 0) return <span className="text-zinc-500">No changes</span>;
  return (
    <span className="font-mono tabular-nums">
      {changes.files} file{changes.files === 1 ? "" : "s"} <span className="text-green-400">+{changes.additions}</span>{" "}
      <span className="text-red-400">−{changes.deletions}</span>
    </span>
  );
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Opens the report when the run shown on the canvas finishes while you watch (or come back to the tab):
 * the moment to see what happened.
 */
export function useAutoOpenReport(): void {
  const runId = useRunStore((s) => s.detail?.run.id ?? null);
  const status = useRunStore((s) => s.detail?.run.status ?? null);
  const seen = useRef<{ id: string; status: RunStatus } | null>(null);
  useEffect(() => {
    if (!runId || !status) return;
    const prev = seen.current;
    seen.current = { id: runId, status };
    if (prev?.id === runId && !isFinalRunStatus(prev.status) && isFinalRunStatus(status)) useUiStore.getState().openReport(runId);
  }, [runId, status]);
}
