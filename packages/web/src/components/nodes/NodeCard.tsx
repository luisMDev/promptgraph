import { costLabel, isActiveNodeStatus, type GraphNode, type NodeRun, nodeDisplayLabel } from "@promptgraph/shared";
import { useRun } from "../../store/view/context";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, type ComponentProps } from "react";
import { elapsed, formatTokens, prLabel } from "../../lib/format";
import { NODE_TYPE_META, configPreview } from "../../lib/node-meta";
import { laneSwatch, type NodeLane } from "../../lib/lanes";
import { cardNote, type NoteTone } from "../../lib/run-view";
import { nodeRunStyle } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { GraceCountdown } from "../common/GraceCountdown";
import { Icons, NodeTypeIcon } from "../common/icons";
import { LaneBadge } from "../common/LaneBadge";
import type { PgFlowNode } from "./types";

const handleBase = "!size-2.5 !border-2 !border-card";

/** Canvas card for every node type: label, type icon, config preview; in run mode status, timing, activity, lane, usage. */
export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<PgFlowNode>) {
  const { node, nodeRun, lane, runMode, issues, phase, mergeInputs, highlighted } = data;
  const meta = NODE_TYPE_META[node.type];
  const style = runMode ? nodeRunStyle(nodeRun) : null;
  const hasErrors = !runMode && issues.errors.length > 0;
  const hasWarnings = !runMode && !hasErrors && issues.warnings.length > 0;
  const tooltip = [...issues.errors, ...issues.warnings].join("\n") || undefined;
  const mono = node.type === "shell" || node.type === "command";

  const border = style
    ? style.card
    : hasErrors
      ? "border-red-500 bg-card ring-1 ring-red-500/60"
      : hasWarnings
        ? "border-amber-500/80 bg-card"
        : "border-border bg-card";

  return (
    <div
      title={tooltip}
      className={`relative w-60 rounded-xl border-2 text-left shadow-soft transition-[color,background-color,border-color,box-shadow] hover:shadow-lifted ${border} ${selected ? "outline-2 outline-offset-2 outline-primary" : ""} ${highlighted ? "pg-highlight" : ""}`}
      data-highlighted={highlighted || undefined}
    >
      {lane && <span className="absolute top-2 bottom-2 -left-0.5 w-1 rounded-full" style={{ background: laneSwatch(lane.index).hex }} />}
      <Handle type="target" position={Position.Top} id="in" className={`${handleBase} !bg-stone-400`} isConnectable={!runMode} />

      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-lg text-[13px] ${meta.accent}`}>
          <NodeTypeIcon type={node.type} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-semibold text-foreground">{node.label?.trim() || <span className="text-muted-foreground italic">{nodeDisplayLabel(node)}</span>}</div>
          <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{meta.title}</div>
        </div>
        {(hasErrors || hasWarnings) && (
          <Icons.alert className={`shrink-0 text-sm ${hasErrors ? "text-red-600" : "text-amber-600"}`} />
        )}
      </div>

      <div className={`truncate px-3 pt-1.5 pb-2.5 text-xs text-muted-foreground ${mono ? "font-mono" : ""}`}>{configPreview(node)}</div>

      {mergeInputs.length > 1 && <MergeOrder inputs={mergeInputs} />}

      {runMode && <RunFooter node={node} nodeRun={nodeRun} lane={lane} />}

      {node.type === "condition" ? (
        <>
          <PortHandle id="true" left="30%" color="!bg-green-500" label="true" labelColor="text-green-600" runMode={runMode} taken={nodeRun?.output?.port === "true"} />
          <PortHandle id="false" left="70%" color="!bg-stone-400" label="false" labelColor="text-stone-500" runMode={runMode} taken={nodeRun?.output?.port === "false"} />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} id="out" className={`${handleBase} !bg-stone-400`} isConnectable={!runMode} />
      )}
      {phase === 2 && (
        <Handle
          type="source"
          position={Position.Right}
          id="error"
          title="Error port: drag to connect a node that runs when this one fails"
          className={`${handleBase} !bg-red-500 ${nodeRun?.status === "failed" ? "!size-3.5 ring-2 ring-red-400/60" : ""}`}
          isConnectable={!runMode}
        />
      )}
    </div>
  );
});

/**
 * Condition output port on the bottom edge, its label just below the card beside the handle (outside the card,
 * so the run footer never runs under it); in run mode the taken branch is highlighted.
 */
function PortHandle({ id, left, color, label, labelColor, runMode, taken }: { id: string; left: string; color: string; label: string; labelColor: string; runMode: boolean; taken: boolean }) {
  return (
    <>
      <Handle
        type="source"
        position={Position.Bottom}
        id={id}
        style={{ left }}
        title={`${label} branch: runs the target when the condition is ${label}`}
        className={`${handleBase} ${color} ${taken ? "!size-3.5 ring-2 ring-stone-900/25" : ""}`}
        isConnectable={!runMode}
      />
      <span
        className={`pointer-events-none absolute top-full mt-1 ml-2 rounded bg-card/90 px-1 text-[9px] font-semibold tracking-wide uppercase ${labelColor} ${runMode && !taken ? "opacity-50" : ""}`}
        style={{ left }}
      >
        {label}
      </span>
    </>
  );
}

/** Merge order (§18 Q4): the first input keeps its lane, the others are merged into it one at a time. */
function MergeOrder({ inputs }: { inputs: string[] }) {
  return (
    <ol className="space-y-0.5 px-3 pb-2.5 text-[11px] text-muted-foreground" title="Merge order: the first input keeps its lane, the others are merged into it one at a time">
      {inputs.map((label, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span className="w-3 text-right font-mono text-muted-foreground/80">{i + 1}</span>
          <span className="truncate">{label}</span>
          {i === 0 && <span className="ml-auto text-[10px] text-muted-foreground/80">base lane</span>}
        </li>
      ))}
    </ol>
  );
}

const NOTE_TONE: Record<NoteTone, string> = {
  amber: "bg-amber-500/15 text-amber-700",
  violet: "bg-violet-500/20 text-violet-700",
  green: "bg-green-500/10 text-green-700",
  red: "bg-red-500/15 text-red-700",
  blue: "bg-blue-500/15 text-blue-700",
  zinc: "bg-stone-200/70 text-stone-800",
};

function RunFooter({ node, nodeRun, lane }: { node: GraphNode; nodeRun: NodeRun | null; lane: NodeLane | null }) {
  const status = nodeRun?.status ?? "pending";
  const style = nodeRunStyle(nodeRun);
  const live = isActiveNodeStatus(status);
  const now = useNow(live);
  const billingMode = useRun((s) => s.detail?.run.billingMode);
  const time = nodeRun ? elapsed(nodeRun.startedAt, nodeRun.finishedAt, now) : null;
  const usage = nodeRun?.output?.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens : 0;
  const activity = nodeRun?.status === "waiting_input" ? (nodeRun.waitingReason?.message ?? "Needs input") : nodeRun?.activity;
  const note = cardNote(node, nodeRun);
  const prUrl = nodeRun?.output?.prUrl;

  return (
    <div className="space-y-1.5 border-t border-border px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className={`inline-block size-2 rounded-full ${style.dot} ${live ? "animate-pulse" : ""}`} />
        <span className={`font-medium ${style.text}`}>{style.label}</span>
        {time && <span className="ml-auto font-mono text-muted-foreground tabular-nums">{time}</span>}
      </div>
      <GraceCountdown nodeRun={nodeRun} compact />
      {note && <div className={`rounded px-1.5 py-1 text-[11px] leading-snug ${NOTE_TONE[note.tone]}`}>{note.text}</div>}
      {!note && activity && live && <div className="truncate font-mono text-[11px] text-muted-foreground" title={activity}>{activity}</div>}
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          className="nodrag nopan block truncate text-[11px] text-blue-600 hover:underline"
          title={prUrl}
          onClick={(e) => e.stopPropagation()}
        >
          {prLabel(prUrl)}
        </a>
      )}
      {/* A rejection's comment is already in the card note. */}
      {nodeRun?.error && status === "failed" && nodeRun.output?.approved !== false && <div className="line-clamp-2 text-[11px] text-red-700" title={nodeRun.error}>{nodeRun.error}</div>}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {lane && <LaneBadge id={lane.id} index={lane.index} title={`Lane ${lane.id}`} />}
        {nodeRun && nodeRun.iteration > 0 && (
          <Pill className="bg-violet-100 text-violet-700" title="Loop iteration (previous iterations are in the inspector)">
            iter {nodeRun.iteration + 1}
          </Pill>
        )}
        {nodeRun && nodeRun.attempt > 0 && <Pill className="bg-secondary text-secondary-foreground">try {nodeRun.attempt + 1}</Pill>}
        {nodeRun?.hold && <Pill className="bg-sky-100 text-sky-700">hold</Pill>}
        {nodeRun?.laneSetup === "running" && (
          <Pill className="animate-pulse bg-blue-100 text-blue-700" title="Workspace setup is running in the new worktree">
            setting up…
          </Pill>
        )}
        {nodeRun?.laneSetup === "failed" && (
          <Pill className="bg-red-100 text-red-700" title="Workspace setup failed; see its log in the inspector">
            setup failed
          </Pill>
        )}
        {usage && tokens > 0 && (
          <span
            className="ml-auto font-mono text-muted-foreground"
            title={`${usage.inputTokens} in · ${usage.outputTokens} out · ${usage.cacheCreationTokens} cache write · ${usage.cacheReadTokens} cache read\n${costLabel(usage.costUsd, billingMode).title}`}
          >
            {formatTokens(tokens)} tok · {costLabel(usage.costUsd, billingMode).text}
          </span>
        )}
      </div>
    </div>
  );
}

/** Small run-footer pill: a shadcn Badge sized like the lane badge next to it. */
function Pill({ className, ...props }: ComponentProps<typeof Badge>) {
  return <Badge className={cn("h-auto rounded border-0 px-1.5 py-0.5 text-[10px] font-normal", className)} {...props} />;
}

export const nodeTypes = { pg: NodeCard };
