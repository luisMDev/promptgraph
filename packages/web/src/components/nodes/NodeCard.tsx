import { formatCostUsd, isActiveNodeStatus, type GraphNode, type NodeRun } from "@promptgraph/shared";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { elapsed, formatTokens, prLabel } from "../../lib/format";
import { NODE_TYPE_META, configPreview } from "../../lib/node-meta";
import { laneSwatch, type NodeLane } from "../../lib/lanes";
import { cardNote, type NoteTone } from "../../lib/run-view";
import { nodeRunStyle } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { Icons, NodeTypeIcon } from "../common/icons";
import { LaneBadge } from "../common/LaneBadge";
import type { PgFlowNode } from "./types";

const handleBase = "!size-2.5 !border-2 !border-zinc-950";

/** Canvas card for every node type: label, type icon, config preview; in run mode status, timing, activity, lane, usage. */
export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<PgFlowNode>) {
  const { node, nodeRun, lane, runMode, issues, phase, mergeInputs } = data;
  const meta = NODE_TYPE_META[node.type];
  const style = runMode ? nodeRunStyle(nodeRun) : null;
  const hasErrors = !runMode && issues.errors.length > 0;
  const hasWarnings = !runMode && !hasErrors && issues.warnings.length > 0;
  const tooltip = [...issues.errors, ...issues.warnings].join("\n") || undefined;
  const mono = node.type === "shell" || node.type === "command";
  // Room for the true/false port labels on the right edge.
  const portPad = node.type === "condition" ? "pr-12" : "";

  const border = style
    ? style.card
    : hasErrors
      ? "border-red-500 bg-zinc-900 ring-1 ring-red-500/60"
      : hasWarnings
        ? "border-amber-500/80 bg-zinc-900"
        : "border-zinc-700 bg-zinc-900";

  return (
    <div
      title={tooltip}
      className={`relative w-60 rounded-lg border-2 text-left shadow-lg shadow-black/30 transition-colors ${border} ${selected ? "outline-2 outline-offset-2 outline-blue-400" : ""}`}
    >
      {lane && <span className="absolute top-2 bottom-2 -left-0.5 w-1 rounded-full" style={{ background: laneSwatch(lane.index).hex }} />}
      <Handle type="target" position={Position.Left} id="in" className={`${handleBase} !bg-zinc-400`} isConnectable={!runMode} />

      <div className={`flex items-center gap-2 px-3 pt-2.5 ${portPad}`}>
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-md text-[13px] ${meta.accent}`}>
          <NodeTypeIcon type={node.type} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-semibold text-zinc-100">{node.label || <span className="text-zinc-500 italic">Untitled</span>}</div>
          <div className="text-[10px] tracking-wide text-zinc-500 uppercase">{meta.title}</div>
        </div>
        {(hasErrors || hasWarnings) && (
          <Icons.alert className={`shrink-0 text-sm ${hasErrors ? "text-red-400" : "text-amber-400"}`} />
        )}
      </div>

      <div className={`truncate px-3 pt-1.5 pb-2.5 text-xs text-zinc-400 ${mono ? "font-mono" : ""} ${portPad}`}>{configPreview(node)}</div>

      {mergeInputs.length > 1 && <MergeOrder inputs={mergeInputs} />}

      {runMode && <RunFooter node={node} nodeRun={nodeRun} lane={lane} />}

      {node.type === "condition" ? (
        <>
          <PortHandle id="true" top="28px" color="!bg-green-500" label="true" labelColor="text-green-400" runMode={runMode} taken={nodeRun?.output?.port === "true"} />
          <PortHandle id="false" top="52px" color="!bg-zinc-400" label="false" labelColor="text-zinc-400" runMode={runMode} taken={nodeRun?.output?.port === "false"} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} id="out" className={`${handleBase} !bg-zinc-300`} isConnectable={!runMode} />
      )}
      {phase === 2 && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="error"
          title="Error port: drag to connect a node that runs when this one fails"
          className={`${handleBase} !bg-red-500 ${nodeRun?.status === "failed" ? "!size-3.5 ring-2 ring-red-300/60" : ""}`}
          isConnectable={!runMode}
        />
      )}
    </div>
  );
});

/**
 * Condition output port with its label inside the card edge (fixed offsets beside the header, so the run
 * footer below never runs under the labels); in run mode the taken branch is highlighted.
 */
function PortHandle({ id, top, color, label, labelColor, runMode, taken }: { id: string; top: string; color: string; label: string; labelColor: string; runMode: boolean; taken: boolean }) {
  return (
    <>
      <Handle
        type="source"
        position={Position.Right}
        id={id}
        style={{ top }}
        title={`${label} branch: runs the target when the condition is ${label}`}
        className={`${handleBase} ${color} ${taken ? "!size-3.5 ring-2 ring-white/60" : ""}`}
        isConnectable={!runMode}
      />
      <span
        className={`pointer-events-none absolute right-2.5 -translate-y-1/2 rounded bg-zinc-950/80 px-1 text-[9px] font-semibold tracking-wide uppercase ${labelColor} ${runMode && !taken ? "opacity-50" : ""}`}
        style={{ top }}
      >
        {label}
      </span>
    </>
  );
}

/** Merge order (§18 Q4): the first input keeps its lane, the others are merged into it one at a time. */
function MergeOrder({ inputs }: { inputs: string[] }) {
  return (
    <ol className="space-y-0.5 px-3 pb-2.5 text-[11px] text-zinc-400" title="Merge order: the first input keeps its lane, the others are merged into it one at a time">
      {inputs.map((label, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span className="w-3 text-right font-mono text-zinc-500">{i + 1}</span>
          <span className="truncate">{label}</span>
          {i === 0 && <span className="ml-auto text-[10px] text-zinc-500">base lane</span>}
        </li>
      ))}
    </ol>
  );
}

const NOTE_TONE: Record<NoteTone, string> = {
  amber: "bg-amber-500/15 text-amber-200",
  violet: "bg-violet-500/20 text-violet-200",
  green: "bg-green-500/10 text-green-300",
  red: "bg-red-500/15 text-red-200",
  blue: "bg-blue-500/15 text-blue-200",
  zinc: "bg-zinc-700/40 text-zinc-200",
};

function RunFooter({ node, nodeRun, lane }: { node: GraphNode; nodeRun: NodeRun | null; lane: NodeLane | null }) {
  const status = nodeRun?.status ?? "pending";
  const style = nodeRunStyle(nodeRun);
  const live = isActiveNodeStatus(status);
  const now = useNow(live);
  const time = nodeRun ? elapsed(nodeRun.startedAt, nodeRun.finishedAt, now) : null;
  const usage = nodeRun?.output?.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens : 0;
  const activity = nodeRun?.status === "waiting_input" ? (nodeRun.waitingReason?.message ?? "Needs input") : nodeRun?.activity;
  const note = cardNote(node, nodeRun);
  const prUrl = nodeRun?.output?.prUrl;

  return (
    <div className="space-y-1.5 border-t border-white/5 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className={`inline-block size-2 rounded-full ${style.dot} ${live ? "animate-pulse" : ""}`} />
        <span className={`font-medium ${style.text}`}>{style.label}</span>
        {time && <span className="ml-auto font-mono text-zinc-400 tabular-nums">{time}</span>}
      </div>
      {note && <div className={`rounded px-1.5 py-1 text-[11px] leading-snug ${NOTE_TONE[note.tone]}`}>{note.text}</div>}
      {!note && activity && live && <div className="truncate font-mono text-[11px] text-zinc-400" title={activity}>{activity}</div>}
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          className="nodrag nopan block truncate text-[11px] text-blue-400 hover:underline"
          title={prUrl}
          onClick={(e) => e.stopPropagation()}
        >
          {prLabel(prUrl)}
        </a>
      )}
      {/* A rejection's comment is already in the card note. */}
      {nodeRun?.error && status === "failed" && nodeRun.output?.approved !== false && <div className="line-clamp-2 text-[11px] text-red-300" title={nodeRun.error}>{nodeRun.error}</div>}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {lane && <LaneBadge id={lane.id} index={lane.index} title={`Lane ${lane.id}`} />}
        {nodeRun && nodeRun.iteration > 0 && (
          <span className="rounded bg-violet-900/50 px-1.5 py-0.5 text-violet-200" title="Loop iteration (previous iterations are in the inspector)">
            iter {nodeRun.iteration + 1}
          </span>
        )}
        {nodeRun && nodeRun.attempt > 0 && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">try {nodeRun.attempt + 1}</span>}
        {nodeRun?.hold && <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-sky-200">hold</span>}
        {nodeRun?.laneSetup === "running" && (
          <span className="animate-pulse rounded bg-blue-900/60 px-1.5 py-0.5 text-blue-200" title="Workspace setup is running in the new worktree">
            setting up…
          </span>
        )}
        {nodeRun?.laneSetup === "failed" && (
          <span className="rounded bg-red-900/60 px-1.5 py-0.5 text-red-200" title="Workspace setup failed; see its log in the inspector">
            setup failed
          </span>
        )}
        {usage && tokens > 0 && (
          <span className="ml-auto font-mono text-zinc-400" title={`${usage.inputTokens} in · ${usage.outputTokens} out · ${usage.cacheCreationTokens} cache write · ${usage.cacheReadTokens} cache read`}>
            {formatTokens(tokens)} tok · {formatCostUsd(usage.costUsd)}
          </span>
        )}
      </div>
    </div>
  );
}

export const nodeTypes = { pg: NodeCard };
