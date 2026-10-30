import { formatCostUsd, isActiveNodeStatus, type NodeRun } from "@promptgraph/shared";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { elapsed, formatTokens } from "../../lib/format";
import { NODE_TYPE_META, configPreview } from "../../lib/node-meta";
import { NODE_STATUS_STYLE, laneColor } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { Icons, NodeTypeIcon } from "../common/icons";
import type { PgFlowNode } from "./types";

const handleBase = "!size-2.5 !border-2 !border-zinc-950";

/** Canvas card for every node type: label, type icon, config preview; in run mode status, timing, activity, lane, usage. */
export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<PgFlowNode>) {
  const { node, nodeRun, lane, runMode, issues, phase } = data;
  const meta = NODE_TYPE_META[node.type];
  const status = runMode ? (nodeRun?.status ?? "pending") : null;
  const style = status ? NODE_STATUS_STYLE[status] : null;
  const hasErrors = !runMode && issues.errors.length > 0;
  const hasWarnings = !runMode && !hasErrors && issues.warnings.length > 0;
  const tooltip = [...issues.errors, ...issues.warnings].join("\n") || undefined;
  const mono = node.type === "shell" || node.type === "command";

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
      <Handle type="target" position={Position.Left} id="in" className={`${handleBase} !bg-zinc-400`} isConnectable={!runMode} />

      <div className="flex items-center gap-2 px-3 pt-2.5">
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

      <div className={`truncate px-3 pt-1.5 pb-2.5 text-xs text-zinc-400 ${mono ? "font-mono" : ""}`}>{configPreview(node)}</div>

      {runMode && <RunFooter nodeRun={nodeRun} laneLabel={lane?.id ?? nodeRun?.laneId ?? null} laneIndex={lane?.index ?? 0} />}

      {node.type === "condition" ? (
        <>
          <PortHandle id="true" top="35%" color="!bg-green-500" label="true" runMode={runMode} />
          <PortHandle id="false" top="65%" color="!bg-zinc-400" label="false" runMode={runMode} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} id="out" className={`${handleBase} !bg-zinc-300`} isConnectable={!runMode} />
      )}
      {phase === 2 && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="error"
          title="Error port: runs the target when this node fails"
          className={`${handleBase} !bg-red-500`}
          isConnectable={!runMode}
        />
      )}
    </div>
  );
});

function PortHandle({ id, top, color, label, runMode }: { id: string; top: string; color: string; label: string; runMode: boolean }) {
  return (
    <>
      <Handle type="source" position={Position.Right} id={id} style={{ top }} className={`${handleBase} ${color}`} isConnectable={!runMode} />
      <span className="pointer-events-none absolute right-2 -translate-y-1/2 text-[9px] text-zinc-500 uppercase" style={{ top }}>
        {label}
      </span>
    </>
  );
}

function RunFooter({ nodeRun, laneLabel, laneIndex }: { nodeRun: NodeRun | null; laneLabel: string | null; laneIndex: number }) {
  const status = nodeRun?.status ?? "pending";
  const style = NODE_STATUS_STYLE[status];
  const live = isActiveNodeStatus(status);
  const now = useNow(live);
  const time = nodeRun ? elapsed(nodeRun.startedAt, nodeRun.finishedAt, now) : null;
  const usage = nodeRun?.output?.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens : 0;
  const activity = nodeRun?.status === "waiting_input" ? (nodeRun.waitingReason?.message ?? "Needs input") : nodeRun?.activity;

  return (
    <div className="space-y-1.5 border-t border-white/5 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className={`inline-block size-2 rounded-full ${style.dot} ${live ? "animate-pulse" : ""}`} />
        <span className={`font-medium ${style.text}`}>{style.label}</span>
        {time && <span className="ml-auto font-mono text-zinc-400 tabular-nums">{time}</span>}
      </div>
      {activity && live && <div className="truncate font-mono text-[11px] text-zinc-400" title={activity}>{activity}</div>}
      {nodeRun?.error && status === "failed" && <div className="line-clamp-2 text-[11px] text-red-300" title={nodeRun.error}>{nodeRun.error}</div>}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {laneLabel && <span className={`rounded px-1.5 py-0.5 font-mono ring-1 ${laneColor(laneIndex)}`}>{laneLabel}</span>}
        {nodeRun && nodeRun.attempt > 0 && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">try {nodeRun.attempt + 1}</span>}
        {nodeRun?.hold && <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-sky-200">hold</span>}
        {nodeRun?.laneSetup && (
          <span
            className={`rounded px-1.5 py-0.5 ${nodeRun.laneSetup === "failed" ? "bg-red-900/60 text-red-200" : nodeRun.laneSetup === "running" ? "bg-blue-900/60 text-blue-200" : "bg-zinc-800 text-zinc-300"}`}
          >
            setup {nodeRun.laneSetup}
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
