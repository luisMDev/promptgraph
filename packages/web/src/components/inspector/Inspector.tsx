import {
  edgeWhen,
  formatCostUsd,
  isFinalRunStatus,
  type EdgeWhen,
  type GraphEdge,
  type GraphNode,
  type LoopSpec,
  type OnError,
  type SourcePort,
} from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { formatDuration } from "../../lib/format";
import { DEFAULT_LOOP, setEdgeLoop, setEdgeWhen } from "../../lib/graph-ops";
import { NODE_TYPE_META } from "../../lib/node-meta";
import { nodeIterations, selectIterationEntry } from "../../lib/run-view";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { isReadOnly, useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { Select } from "../common/fields";
import { NodeTypeIcon } from "../common/icons";
import { Button, Checkbox, Field, Section, StatusDot, inputClass } from "../common/ui";
import { GraphSettingsForm } from "../settings/GraphSettingsForm";
import { LaneLegend } from "./LaneLegend";
import { NodeConfigForm } from "./NodeConfigForm";
import { NodeRunDetails, UsageSection } from "./NodeRunDetails";
import { ValidationList } from "./ValidationList";

/** Right panel: node/edge/graph config in edit mode; NodeRun details and controls in run mode. */
export function Inspector() {
  const runMode = useRunStore((s) => s.selectedRunId !== null);
  return <div className="h-full overflow-y-auto">{runMode ? <RunInspector /> : <EditInspector />}</div>;
}

function EditInspector() {
  const graph = useEditorStore((s) => s.graph);
  const validation = useEditorStore((s) => s.validation);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const selectedEdgeIds = useEditorStore((s) => s.selectedEdgeIds);
  const nodeId = useEditorStore((s) => s.selectedNodeId);
  const edgeId = useEditorStore((s) => s.selectedEdgeId);
  const readOnly = useEditorStore(isReadOnly);
  if (!graph) return null;

  const node = nodeId ? graph.nodes.find((n) => n.id === nodeId) : undefined;
  const edge = edgeId ? graph.edges.find((e) => e.id === edgeId) : undefined;
  const count = selectedNodeIds.length + selectedEdgeIds.length;

  if (node) return <NodeInspector node={node} disabled={readOnly} />;
  if (edge) return <EdgeInspector edge={edge} disabled={readOnly} />;
  if (count > 1) {
    return (
      <Section title="Selection">
        <p className="text-sm text-zinc-300">
          {selectedNodeIds.length} nodes, {selectedEdgeIds.length} edges selected.
        </p>
        <Button variant="danger" size="sm" disabled={readOnly} onClick={() => useEditorStore.getState().removeSelection()}>
          Delete selection
        </Button>
      </Section>
    );
  }
  return (
    <>
      <Section title={`Problems${validation.errors.length + validation.warnings.length ? ` (${validation.errors.length + validation.warnings.length})` : ""}`}>
        <ValidationList validation={validation} />
      </Section>
      <Section title="Graph settings">
        <GraphSettingsForm graphId={graph.id} settings={graph.settings} disabled={readOnly} />
      </Section>
    </>
  );
}

const ON_ERROR_OPTIONS: readonly { value: OnError; label: string }[] = [
  { value: "pause", label: "Pause the run (retry / skip later)" },
  { value: "fail-run", label: "Fail the whole run" },
];

function NodeInspector({ node, disabled }: { node: GraphNode; disabled: boolean }) {
  const settings = useEditorStore((s) => s.graph!.settings);
  const phase = useEditorStore((s) => s.phase);
  const issues = useEditorStore((s) => s.validation);
  const nodeIssues = { errors: issues.errors.filter((i) => i.nodeId === node.id), warnings: issues.warnings.filter((i) => i.nodeId === node.id) };
  const meta = NODE_TYPE_META[node.type];
  const update = (fn: (n: GraphNode) => GraphNode) => useEditorStore.getState().updateNode(node.id, fn);

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <span className={`flex size-7 items-center justify-center rounded-md ${meta.accent}`}>
          <NodeTypeIcon type={node.type} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-zinc-100">{meta.title}</div>
          <div className="truncate text-[11px] text-zinc-500">{meta.description}</div>
        </div>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => useEditorStore.getState().removeElements([node.id], [])}>
          Delete
        </Button>
      </div>
      {(nodeIssues.errors.length > 0 || nodeIssues.warnings.length > 0) && (
        <div className="border-b border-zinc-800 px-2 py-2">
          <ValidationList validation={nodeIssues} />
        </div>
      )}
      <Section title="Node">
        <Field label="Label">
          <input className={inputClass} value={node.label} disabled={disabled} onChange={(e) => update((n) => ({ ...n, label: e.target.value }))} />
        </Field>
        <Field label="On error" hint={phase === 2 ? "Applies only when no failure edge (error port) handles the failure." : undefined}>
          <Select value={node.onError ?? "pause"} options={ON_ERROR_OPTIONS} disabled={disabled} onChange={(onError) => update((n) => ({ ...n, onError }))} />
        </Field>
      </Section>
      <Section title="Configuration">
        <NodeConfigForm node={node} settings={settings} disabled={disabled} />
      </Section>
    </div>
  );
}

const WHEN_OPTIONS: readonly { value: EdgeWhen; label: string }[] = [
  { value: "success", label: "Source succeeded" },
  { value: "failure", label: "Source failed" },
  { value: "always", label: "Always (success or failure)" },
];

const EXHAUSTED_OPTIONS: readonly { value: LoopSpec["onExhausted"]; label: string }[] = [
  { value: "fail", label: "Fail" },
  { value: "continue", label: "Continue" },
];

const PORT_LABEL: Record<SourcePort, string> = { out: "output", true: "true", false: "false", error: "error" };

/** Loop settings of edges whose "Loop back-edge" box was unchecked in this session (restored on recheck). */
const lastLoopSpec = new Map<string, LoopSpec>();

/**
 * Integer 1–100 kept as local text while typing (clearing the field does not snap back to 1); valid values
 * are committed as typed, anything else is reverted on blur.
 */
function MaxIterationsInput({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parse = (t: string): number | null => {
    const n = Number(t);
    return t.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
  };
  return (
    <input
      type="number"
      min={1}
      max={100}
      className={inputClass}
      value={text}
      disabled={disabled}
      onChange={(ev) => {
        setText(ev.target.value);
        const n = parse(ev.target.value);
        if (n !== null && n !== value) onChange(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function EdgeInspector({ edge, disabled }: { edge: GraphEdge; disabled: boolean }) {
  const graph = useEditorStore((s) => s.graph!);
  const phase = useEditorStore((s) => s.phase);
  const validation = useEditorStore((s) => s.validation);
  const edgeIssues = { errors: validation.errors.filter((i) => i.edgeId === edge.id), warnings: validation.warnings.filter((i) => i.edgeId === edge.id) };
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label || id;
  const update = (fn: (e: GraphEdge) => GraphEdge) => useEditorStore.getState().updateEdge(edge.id, fn);
  const errorPort = edge.sourcePort === "error";
  return (
    <>
      <Section title={edge.loop ? "Loop edge" : "Edge"} actions={<Button size="sm" variant="ghost" disabled={disabled} onClick={() => useEditorStore.getState().removeElements([], [edge.id])}>Delete</Button>}>
        <p className="text-sm text-zinc-300">
          {label(edge.source)} <span className={errorPort ? "text-red-400" : "text-zinc-500"}>({PORT_LABEL[edge.sourcePort]})</span> → {label(edge.target)}
        </p>
        {(edgeIssues.errors.length > 0 || edgeIssues.warnings.length > 0) && <ValidationList validation={edgeIssues} />}
        {phase < 2 && <p className="text-[11px] text-zinc-500">Edge conditions, error ports and loops need phase 2.</p>}
      </Section>
      {phase === 2 && (
        <Section title="Condition">
          <Field
            label="Follow when"
            hint={
              errorPort
                ? "Edges from the error port run their target when the source fails."
                : edge.sourcePort === "true" || edge.sourcePort === "false"
                  ? `Also requires the condition to be ${edge.sourcePort}. Edges that do not match deliver a skip (dead path).`
                  : "Edges that do not match deliver a skip: the target is skipped unless another input activates it."
            }
          >
            <Select<EdgeWhen> value={edgeWhen(edge)} disabled={disabled || errorPort} options={WHEN_OPTIONS} onChange={(w) => update((e) => setEdgeWhen(e, w))} />
          </Field>
        </Section>
      )}
      {phase === 2 && (
        <Section title="Loop">
          <Checkbox
            checked={!!edge.loop}
            disabled={disabled}
            label="Loop back-edge"
            onChange={(on) => {
              // Unchecking and rechecking restores the settings the user had chosen.
              if (!on && edge.loop) lastLoopSpec.set(edge.id, edge.loop);
              update((e) => setEdgeLoop(e, on ? { ...(lastLoopSpec.get(edge.id) ?? DEFAULT_LOOP) } : null));
            }}
          />
          <p className="text-[11px] leading-snug text-zinc-500">
            A loop edge points back to an earlier node: when it activates, the nodes from its target to its source run again as a new iteration.
          </p>
          {edge.loop && (
            <p className="text-[11px] text-zinc-500">
              Loops back at most {edge.loop.maxIterations} time{edge.loop.maxIterations === 1 ? "" : "s"}; the run shows the count as a badge on the edge.
            </p>
          )}
          {edge.loop && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Max iterations">
                <MaxIterationsInput
                  value={edge.loop.maxIterations}
                  disabled={disabled}
                  onChange={(n) => update((e) => ({ ...e, loop: { ...e.loop!, maxIterations: n } }))}
                />
              </Field>
              <Field label="When exhausted">
                <Select
                  value={edge.loop.onExhausted}
                  disabled={disabled}
                  options={EXHAUSTED_OPTIONS}
                  onChange={(onExhausted) => update((e) => ({ ...e, loop: { ...e.loop!, onExhausted } }))}
                />
              </Field>
            </div>
          )}
          {edge.loop && (
            <p className="text-[11px] text-zinc-500">
              {edge.loop.onExhausted === "fail"
                ? "When exhausted, the edge's source node fails (route it with a failure edge, or the run pauses)."
                : "When exhausted, the edge delivers a skip and the flow continues on the other branches."}
            </p>
          )}
        </Section>
      )}
    </>
  );
}

function RunInspector() {
  const detail = useRunStore((s) => s.detail);
  const selectedNodeId = useRunStore((s) => s.selectedNodeId);
  const selectedIteration = useRunStore((s) => s.selectedIteration);
  const lanes = useRunStore((s) => s.lanes);
  if (!detail) return null;
  const node = selectedNodeId ? detail.run.graphSnapshot.nodes.find((n) => n.id === selectedNodeId) : undefined;
  if (node) {
    const iterations = nodeIterations(detail.nodeRuns, node.id);
    const entry = selectIterationEntry(iterations, selectedIteration);
    const nodeRun = entry?.nodeRun ?? null;
    const lane = nodeRun?.laneId ? (lanes[nodeRun.laneId] ?? null) : null;
    return (
      <NodeRunDetails
        node={node}
        nodeRun={nodeRun}
        lane={lane}
        runStatus={detail.run.status}
        iterations={iterations}
        historical={!!entry && entry !== iterations[iterations.length - 1]}
      />
    );
  }
  return <RunOverview />;
}

function RunOverview() {
  const detail = useRunStore((s) => s.detail)!;
  const { run } = detail;
  const style = RUN_STATUS_STYLE[run.status];
  const now = useNow(!isFinalRunStatus(run.status));
  return (
    <>
      <Section title="Run">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot className={style.dot} />
          <span className={`font-medium ${style.text}`}>{style.label}</span>
          <span className="font-mono text-xs text-zinc-500">#{run.shortId}</span>
          <span className="ml-auto text-xs text-zinc-400 tabular-nums">{formatDuration((run.finishedAt ?? now) - run.startedAt)}</span>
        </div>
        {run.error && <pre className="rounded-md bg-red-500/10 px-2 py-1.5 text-xs whitespace-pre-wrap text-red-200">{run.error}</pre>}
        {run.status === "paused" && (
          <p className="text-xs text-amber-200/90">The run is paused: select a failed node to retry or skip it, or cancel the run.</p>
        )}
        <p className="text-xs text-zinc-500">Click a node to see its details and open its terminal.</p>
      </Section>
      <LaneLegend />
      <UsageSection usage={run.usage} title={`Usage · ${formatCostUsd(run.usage.costUsd)}`} />
    </>
  );
}
