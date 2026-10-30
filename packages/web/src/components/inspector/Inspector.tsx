import { formatCostUsd, isFinalRunStatus, type GraphEdge, type GraphNode, type OnError } from "@promptgraph/shared";
import { formatDuration } from "../../lib/format";
import { NODE_TYPE_META } from "../../lib/node-meta";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { useNow } from "../../lib/use-now";
import { isReadOnly, useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { Select } from "../common/fields";
import { NodeTypeIcon } from "../common/icons";
import { Button, Field, Section, StatusDot, inputClass } from "../common/ui";
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
        <Field label="On error">
          <Select value={node.onError ?? "pause"} options={ON_ERROR_OPTIONS} disabled={disabled} onChange={(onError) => update((n) => ({ ...n, onError }))} />
        </Field>
      </Section>
      <Section title="Configuration">
        <NodeConfigForm node={node} settings={settings} disabled={disabled} />
      </Section>
    </div>
  );
}

function EdgeInspector({ edge, disabled }: { edge: GraphEdge; disabled: boolean }) {
  const graph = useEditorStore((s) => s.graph!);
  const phase = useEditorStore((s) => s.phase);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label || id;
  const update = (fn: (e: GraphEdge) => GraphEdge) => useEditorStore.getState().updateEdge(edge.id, fn);
  return (
    <Section title="Edge" actions={<Button size="sm" variant="ghost" disabled={disabled} onClick={() => useEditorStore.getState().removeElements([], [edge.id])}>Delete</Button>}>
      <p className="text-sm text-zinc-300">
        {label(edge.source)} <span className="text-zinc-500">({edge.sourcePort})</span> → {label(edge.target)}
      </p>
      {phase === 2 && (
        <>
          <Field label="Follow when">
            <Select<string>
              value={edge.when ?? ""}
              disabled={disabled}
              options={[
                { value: "", label: "Default" },
                { value: "success", label: "Source succeeded" },
                { value: "failure", label: "Source failed" },
                { value: "always", label: "Always" },
              ]}
              onChange={(w) => update((e) => ({ ...e, when: w === "" ? undefined : (w as GraphEdge["when"]) }))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="accent-blue-500"
              checked={!!edge.loop}
              disabled={disabled}
              onChange={(ev) => update((e) => ({ ...e, loop: ev.target.checked ? { maxIterations: 3, onExhausted: "fail" } : undefined }))}
            />
            Loop back-edge
          </label>
          {edge.loop && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Max iterations">
                <input
                  type="number"
                  min={1}
                  max={100}
                  className={inputClass}
                  value={edge.loop.maxIterations}
                  disabled={disabled}
                  onChange={(ev) => {
                    const n = Math.min(100, Math.max(1, Math.round(ev.target.valueAsNumber || 1)));
                    update((e) => ({ ...e, loop: { ...e.loop!, maxIterations: n } }));
                  }}
                />
              </Field>
              <Field label="When exhausted">
                <Select
                  value={edge.loop.onExhausted}
                  disabled={disabled}
                  options={[
                    { value: "fail", label: "Fail" },
                    { value: "continue", label: "Continue" },
                  ]}
                  onChange={(onExhausted) => update((e) => ({ ...e, loop: { ...e.loop!, onExhausted } }))}
                />
              </Field>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function RunInspector() {
  const detail = useRunStore((s) => s.detail);
  const selectedNodeId = useRunStore((s) => s.selectedNodeId);
  const currentByNode = useRunStore((s) => s.currentByNode);
  const lanes = useRunStore((s) => s.lanes);
  if (!detail) return null;
  const node = selectedNodeId ? detail.run.graphSnapshot.nodes.find((n) => n.id === selectedNodeId) : undefined;
  if (node) {
    const nodeRun = currentByNode[node.id] ?? null;
    const lane = nodeRun?.laneId ? (lanes[nodeRun.laneId] ?? null) : null;
    return <NodeRunDetails node={node} nodeRun={nodeRun} lane={lane} runStatus={detail.run.status} />;
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
