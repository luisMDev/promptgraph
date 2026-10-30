import {
  formatCostUsd,
  isActiveNodeStatus,
  isClaudeNode,
  isFinalRunStatus,
  type GraphNode,
  type GraphNodeOf,
  type Lane,
  type NodeRun,
  type RunStatus,
} from "@promptgraph/shared";
import { elapsed, formatTime, formatTokens } from "../../lib/format";
import { mergeInputLabels } from "../../lib/lanes";
import { NODE_TYPE_META, configPreview } from "../../lib/node-meta";
import type { IterationEntry } from "../../lib/run-view";
import { nodeRunStyle } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { nodeControl, openNodeTerminal, openSetupTerminal, reopenSession } from "../../store/app-actions";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { Icons, NodeTypeIcon } from "../common/icons";
import { LaneBadge } from "../common/LaneBadge";
import { Button, DetailRow, Field, Section, StatusDot } from "../common/ui";

/** Run-mode inspector for one node: status, session, branch, timings, output, usage, manual controls. */
export function NodeRunDetails({
  node,
  nodeRun,
  lane,
  runStatus,
  iterations = [],
  historical = false,
}: {
  node: GraphNode;
  nodeRun: NodeRun | null;
  lane: Lane | null;
  runStatus: RunStatus;
  /** Every iteration of the node (latest attempt each); a selector is shown when there are several. */
  iterations?: readonly IterationEntry[];
  /** `nodeRun` belongs to a previous loop iteration: read-only (no controls besides its terminal). */
  historical?: boolean;
}) {
  const label = node.label || NODE_TYPE_META[node.type].title;
  const attempts = iterations.find((e) => e.nodeRun.id === nodeRun?.id)?.attempts ?? 1;
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <span className={`flex size-7 items-center justify-center rounded-md ${NODE_TYPE_META[node.type].accent}`}>
          <NodeTypeIcon type={node.type} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{label}</div>
          <div className="text-[11px] text-zinc-500">{NODE_TYPE_META[node.type].title}</div>
        </div>
      </div>
      {!nodeRun ? (
        <p className="px-4 py-4 text-sm text-zinc-500">This node has not been scheduled yet.</p>
      ) : (
        <>
          {iterations.length > 1 && <IterationSelector iterations={iterations} shown={nodeRun.iteration} historical={historical} label={label} />}
          <StatusSection node={node} nodeRun={nodeRun} lane={lane} attempts={attempts} />
          <Controls node={node} nodeRun={nodeRun} label={iterations.length > 1 ? `${label} #${nodeRun.iteration + 1}` : label} runFinal={isFinalRunStatus(runStatus)} historical={historical} />
          {node.type === "condition" && <ConditionResult node={node} nodeRun={nodeRun} />}
          <OutputSection nodeRun={nodeRun} reasonShown={node.type === "condition"} />
          {nodeRun.output?.usage && <UsageSection usage={nodeRun.output.usage} />}
        </>
      )}
    </div>
  );
}

function StatusSection({ node, nodeRun, lane, attempts }: { node: GraphNode; nodeRun: NodeRun; lane: Lane | null; attempts: number }) {
  const style = nodeRunStyle(nodeRun);
  const mergeShell = node.type === "merge" && nodeRun.waitingReason?.kind === "merge_conflict";
  const snapshot = useRunStore((s) => s.detail?.run.graphSnapshot);
  const mergeOrder = node.type === "merge" && snapshot ? mergeInputLabels(snapshot, node.id) : [];
  const now = useNow(isActiveNodeStatus(nodeRun.status));
  return (
    <Section title="Status">
      <div className="flex items-center gap-2 text-sm">
        <StatusDot className={style.dot} />
        <span className={`font-medium ${style.text}`}>{style.label}</span>
        {nodeRun.hold && <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] text-sky-200">hold</span>}
      </div>
      {nodeRun.waitingReason && <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">{nodeRun.waitingReason.message}</p>}
      {nodeRun.activity && isActiveNodeStatus(nodeRun.status) && <p className="truncate font-mono text-xs text-zinc-400">{nodeRun.activity}</p>}
      <div className="space-y-1.5">
        {lane ? (
          <DetailRow label="Lane">
            <LaneBadge id={lane.id} index={lane.index} /> <span className="font-mono">{lane.branch}</span>
            {lane.pushed && <span className="ml-1.5 text-[10px] text-indigo-300">pushed</span>}
          </DetailRow>
        ) : (
          nodeRun.laneId && <DetailRow label="Lane">{nodeRun.laneId}</DetailRow>
        )}
        {lane && <DetailRow label="Worktree"><span className="font-mono text-[11px]">{lane.worktreePath}</span></DetailRow>}
        {nodeRun.sessionId && (
          <DetailRow label="Session">
            <span className="font-mono text-[11px] select-all">{nodeRun.sessionId}</span>
          </DetailRow>
        )}
        {nodeRun.startedAt && <DetailRow label="Started">{formatTime(nodeRun.startedAt)}</DetailRow>}
        {nodeRun.finishedAt && <DetailRow label="Finished">{formatTime(nodeRun.finishedAt)}</DetailRow>}
        {nodeRun.startedAt && <DetailRow label="Duration">{elapsed(nodeRun.startedAt, nodeRun.finishedAt, now)}</DetailRow>}
        {attempts > 1 && <DetailRow label="Attempt">{`${nodeRun.attempt + 1} of ${attempts}`}</DetailRow>}
        {nodeRun.laneSetup && <DetailRow label="Lane setup">{nodeRun.laneSetup}</DetailRow>}
        {mergeOrder.length > 1 && (
          <DetailRow label="Merge order">
            {mergeOrder.map((l, i) => (
              <span key={i} className="block">
                {i + 1}. {l}
              </span>
            ))}
          </DetailRow>
        )}
      </div>
      {mergeShell && (
        <p className="text-[11px] text-zinc-400">Resolve the conflicts in the merge shell (edit, then <span className="font-mono">git add</span>), then click Done.</p>
      )}
      {nodeRun.error && <pre className="rounded-md bg-red-500/10 px-2 py-1.5 text-xs whitespace-pre-wrap text-red-200">{nodeRun.error}</pre>}
    </Section>
  );
}

function Controls({ node, nodeRun, label, runFinal, historical }: { node: GraphNode; nodeRun: NodeRun; label: string; runFinal: boolean; historical: boolean }) {
  const s = nodeRun.status;
  // A previous iteration is history: only its terminal log and session can be opened.
  const live = !historical;
  const active = live && isActiveNodeStatus(s);
  // A failure handled downstream (failure/always edge, loop back-edge) already moved the flow on.
  const handled = s === "failed" && !!nodeRun.output?.failureHandled;
  // Failed because its loop reached the limit: a retry would fail the same way (skip continues past the loop).
  const canRetry = live && !runFinal && !handled && !nodeRun.output?.loopExhausted && (s === "failed" || s === "interrupted" || s === "cancelled");
  // A condition has no single port to "treat as success": retry it, or skip the branch to follow.
  const canSkip = live && !runFinal && !handled && node.type !== "condition" && (s === "failed" || s === "interrupted" || s === "pending" || s === "ready");
  const canDone = live && (s === "idle" || s === "waiting_input" || (s === "running" && isClaudeNode(node)));
  const canHold = live && isClaudeNode(node) && !runFinal && (active || s === "pending" || s === "ready");
  // Any node with a Claude session: prompt/command nodes, and merges that resolved conflicts with Claude.
  const canReopen = !!nodeRun.sessionId && !isActiveNodeStatus(s);
  const canReview = live && s === "waiting_approval";
  const mergeShell = node.type === "merge" && nodeRun.waitingReason?.kind === "merge_conflict";
  if (!(canDone || active || canHold || canRetry || canSkip || canReview || nodeRun.ptyId || canReopen || nodeRun.laneSetup)) return null;
  const id = nodeRun.id;
  return (
    <Section title="Controls">
      <div className="flex flex-wrap gap-1.5">
        {canDone && (
          <Button size="sm" variant="primary" onClick={() => void nodeControl(id, "done")} title="Mark the node as succeeded">
            Done
          </Button>
        )}
        {active && (
          <Button size="sm" variant="danger" onClick={() => void nodeControl(id, "fail")} title="Mark the node as failed">
            Fail
          </Button>
        )}
        {canHold && (
          <Button size="sm" onClick={() => void nodeControl(id, nodeRun.hold ? "release" : "hold")} title="Hold: the current turn behaves as manual completion">
            {nodeRun.hold ? "Release hold" : "Hold"}
          </Button>
        )}
        {canRetry && (
          <Button size="sm" onClick={() => void nodeControl(id, "retry")}>
            Retry
          </Button>
        )}
        {canSkip && (
          <Button size="sm" onClick={() => void nodeControl(id, "skip")} title="Treat as succeeded and continue">
            Skip
          </Button>
        )}
        {canReview && (
          <Button size="sm" variant="primary" onClick={() => useUiStore.getState().openApproval(id)}>
            Review…
          </Button>
        )}
        {nodeRun.ptyId && (
          <Button size="sm" variant="ghost" onClick={() => openNodeTerminal(nodeRun, mergeShell ? `${label} (merge shell)` : label)}>
            <Icons.terminal /> {mergeShell ? "Merge shell" : "Terminal"}
          </Button>
        )}
        {nodeRun.laneSetup && (
          <Button size="sm" variant="ghost" onClick={() => openSetupTerminal(nodeRun, label)} title="Output of the graph's workspace setup in this new worktree">
            <Icons.terminal /> Setup log
          </Button>
        )}
        {canReopen && (
          <Button size="sm" variant="ghost" onClick={() => void reopenSession(id, label)} title="claude --resume in a new terminal (not part of the run)">
            Reopen session
          </Button>
        )}
      </div>
    </Section>
  );
}

function OutputSection({ nodeRun, reasonShown }: { nodeRun: NodeRun; reasonShown: boolean }) {
  const o = nodeRun.output;
  if (!o) return null;
  const text = reasonShown ? undefined : o.text;
  const hasAny = text || o.stdoutTail || o.sha || o.prUrl || o.exitCode !== undefined || o.conflictedFiles?.length || o.approved !== undefined;
  if (!hasAny) return null;
  return (
    <Section title="Output">
      <div className="space-y-1.5">
        {o.exitCode !== undefined && <DetailRow label="Exit code">{o.exitCode === null ? "killed" : o.exitCode}{o.timedOut ? " (timed out)" : ""}</DetailRow>}
        {o.sha && <DetailRow label="Commit"><span className="font-mono">{o.sha.slice(0, 12)}</span>{o.noop ? " (nothing to commit)" : ""}</DetailRow>}
        {o.noop && !o.sha && <DetailRow label="Commit">Nothing to commit</DetailRow>}
        {o.message && <DetailRow label="Message"><span className="whitespace-pre-wrap">{o.message}</span></DetailRow>}
        {o.prUrl && (
          <DetailRow label="PR">
            <a href={o.prUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
              {o.prUrl}
            </a>
          </DetailRow>
        )}
        {o.approved !== undefined && <DetailRow label="Approval">{o.approved ? "Approved" : "Rejected"}{o.comment ? ` — ${o.comment}` : ""}</DetailRow>}
        {o.port && !reasonShown && <DetailRow label="Branch taken">{o.port}</DetailRow>}
        {o.conflictedFiles?.length ? <DetailRow label="Conflicts"><span className="font-mono text-[11px]">{o.conflictedFiles.join(", ")}</span></DetailRow> : null}
      </div>
      {text && <pre className="max-h-80 overflow-auto rounded-md bg-zinc-950 p-2 text-xs leading-relaxed whitespace-pre-wrap text-zinc-200 ring-1 ring-zinc-800">{text}</pre>}
      {o.stdoutTail && <pre className="max-h-80 overflow-auto rounded-md bg-zinc-950 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-300 ring-1 ring-zinc-800">{o.stdoutTail}</pre>}
    </Section>
  );
}

export function UsageSection({ usage, title = "Usage" }: { usage: NonNullable<NonNullable<NodeRun["output"]>["usage"]>; title?: string }) {
  return (
    <Section title={title}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-zinc-500">Input</span>
        <span className="text-right font-mono">{formatTokens(usage.inputTokens)}</span>
        <span className="text-zinc-500">Output</span>
        <span className="text-right font-mono">{formatTokens(usage.outputTokens)}</span>
        <span className="text-zinc-500">Cache write</span>
        <span className="text-right font-mono">{formatTokens(usage.cacheCreationTokens)}</span>
        <span className="text-zinc-500">Cache read</span>
        <span className="text-right font-mono">{formatTokens(usage.cacheReadTokens)}</span>
        <span className="font-medium text-zinc-300">Estimated cost</span>
        <span className="text-right font-mono font-medium text-zinc-100">{formatCostUsd(usage.costUsd)}</span>
      </div>
      {usage.model && <p className="text-[11px] text-zinc-500">Model: {usage.model}</p>}
    </Section>
  );
}

/** Iteration selector (§15.4): browse previous loop iterations of a node (output, terminal log, timings). */
function IterationSelector({ iterations, shown, historical, label }: { iterations: readonly IterationEntry[]; shown: number; historical: boolean; label: string }) {
  const latest = iterations[iterations.length - 1]!.iteration;
  const select = (iteration: number | null) => {
    useRunStore.getState().selectIteration(iteration);
    // The drawer follows the selection when it shows this node's terminal (one of its iterations).
    const ui = useUiStore.getState();
    const activeRunId = ui.activeTerminal ? ui.tabMeta[ui.activeTerminal]?.nodeRunId : null;
    const target = iterations.find((e) => e.iteration === (iteration ?? latest))?.nodeRun;
    if (ui.drawerOpen && target?.ptyId && iterations.some((e) => e.nodeRun.id === activeRunId)) {
      openNodeTerminal(target, `${label} #${target.iteration + 1}`);
    }
  };
  return (
    <Section
      title={`Iteration ${shown + 1} of ${latest + 1}`}
      actions={
        historical ? (
          <Button size="sm" variant="ghost" onClick={() => select(null)} title="Follow the latest iteration">
            Latest
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Loop iterations">
        {iterations.map((e) => {
          const style = nodeRunStyle(e.nodeRun);
          const active = e.iteration === shown;
          return (
            <button
              key={e.iteration}
              type="button"
              role="tab"
              aria-selected={active}
              title={`Iteration ${e.iteration + 1}: ${style.label}${e.attempts > 1 ? ` (${e.attempts} attempts)` : ""}`}
              onClick={() => select(e.iteration === latest ? null : e.iteration)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs tabular-nums ring-1 ${
                active ? "bg-zinc-700 text-zinc-100 ring-zinc-500" : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800"
              }`}
            >
              <StatusDot className={style.dot} />#{e.iteration + 1}
            </button>
          );
        })}
      </div>
      {historical && <p className="text-[11px] text-zinc-500">Previous iteration: read-only.</p>}
    </Section>
  );
}

/** Condition node in run mode: evaluator, result and reason (§15.2). */
function ConditionResult({ node, nodeRun }: { node: GraphNodeOf<"condition">; nodeRun: NodeRun }) {
  const o = nodeRun.output;
  const result = o?.result ?? (o?.port ? o.port === "true" : undefined);
  return (
    <Section title="Condition">
      <div className="space-y-1.5">
        <DetailRow label="Evaluator">
          <span className={node.config.evaluator.kind === "judge" ? "" : "font-mono"}>{configPreview(node)}</span>
        </DetailRow>
        <DetailRow label="Result">
          {result === undefined ? (
            <span className="text-zinc-500">{isActiveNodeStatus(nodeRun.status) ? "Evaluating…" : "Not evaluated"}</span>
          ) : (
            <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${result ? "bg-green-500/15 text-green-300" : "bg-zinc-700/50 text-zinc-200"}`}>
              {result ? "true" : "false"}
            </span>
          )}
        </DetailRow>
      </div>
      {o?.text && (
        <Field label="Reason">
          <pre className="max-h-60 overflow-auto rounded-md bg-zinc-950 p-2 text-xs leading-relaxed whitespace-pre-wrap text-zinc-200 ring-1 ring-zinc-800">{o.text}</pre>
        </Field>
      )}
    </Section>
  );
}
