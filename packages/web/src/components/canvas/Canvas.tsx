import { NODE_TYPES, type Graph, type NodeType, type Position, type SourcePort } from "@promptgraph/shared";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { toFlowEdges, toFlowNodes } from "../../lib/flow-mapping";
import { connectionError } from "../../lib/graph-ops";
import { NODE_STATUS_COLOR_HEX } from "../../lib/status-hex";
import { isReadOnly, useEditorStore } from "../../store/editor-store";
import { openNodeTerminal } from "../../store/app-actions";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { nodeTypes } from "../nodes/NodeCard";
import type { PgFlowNode } from "../nodes/types";
import { edgeTypes, type PgFlowEdge } from "./PgEdge";

export const PALETTE_MIME = "application/x-promptgraph-node";
const GRID: [number, number] = [16, 16];
const SOURCE_PORTS: readonly string[] = ["out", "true", "false", "error"];
const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.3 };
const MINIMAP_STYLE = { width: 160, height: 100 };

type Measured = Record<string, { width: number; height: number }>;

/** React Flow canvas: editable graph in edit mode, read-only run snapshot with live statuses in run mode. */
export function Canvas() {
  const graphId = useEditorStore((s) => s.graph?.id ?? null);
  const runId = useRunStore((s) => s.selectedRunId);
  return (
    <ReactFlowProvider key={`${graphId}:${runId ?? "edit"}`}>
      {runId ? <RunCanvas /> : <EditCanvas />}
    </ReactFlowProvider>
  );
}

function useMeasured() {
  const [measured, setMeasured] = useState<Measured>({});
  const apply = useCallback((changes: NodeChange<PgFlowNode>[]) => {
    const dims = changes.filter((c) => c.type === "dimensions" && c.dimensions);
    if (dims.length === 0) return;
    setMeasured((prev) => {
      const next = { ...prev };
      for (const c of dims) if (c.type === "dimensions" && c.dimensions) next[c.id] = c.dimensions;
      return next;
    });
  }, []);
  return [measured, apply] as const;
}

function EditCanvas() {
  const graph = useEditorStore((s) => s.graph);
  const phase = useEditorStore((s) => s.phase);
  const validation = useEditorStore((s) => s.validation);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const selectedEdgeIds = useEditorStore((s) => s.selectedEdgeIds);
  const readOnly = useEditorStore(isReadOnly);
  const [measured, applyMeasured] = useMeasured();
  const { screenToFlowPosition } = useReactFlow();

  const input = useMemo(
    () => (graph ? { graph, phase, validation, selectedNodeIds, selectedEdgeIds, measured } : null),
    [graph, phase, validation, selectedNodeIds, selectedEdgeIds, measured],
  );
  const nodes = useMemo(() => (input ? toFlowNodes(input) : []), [input]);
  const edges = useMemo(() => (input ? toFlowEdges(input) : []), [input]);

  const onNodesChange = useCallback(
    (changes: NodeChange<PgFlowNode>[]) => {
      applyMeasured(changes);
      const editor = useEditorStore.getState();
      const positions = new Map<string, Position>();
      for (const c of changes) if (c.type === "position" && c.position) positions.set(c.id, c.position);
      if (positions.size) editor.moveNodes(positions);
      const selects = changes.filter((c) => c.type === "select");
      if (selects.length) {
        const set = new Set(editor.selectedNodeIds);
        for (const c of selects) if (c.type === "select") (c.selected ? set.add(c.id) : set.delete(c.id));
        editor.setSelection([...set], useEditorStore.getState().selectedEdgeIds);
      }
    },
    [applyMeasured],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<PgFlowEdge>[]) => {
    const selects = changes.filter((c) => c.type === "select");
    if (!selects.length) return;
    const editor = useEditorStore.getState();
    const set = new Set(editor.selectedEdgeIds);
    for (const c of selects) if (c.type === "select") (c.selected ? set.add(c.id) : set.delete(c.id));
    editor.setSelection(useEditorStore.getState().selectedNodeIds, [...set]);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const error = useEditorStore.getState().connect(toConnectRequest(c));
    if (error) useUiStore.getState().toast("error", error);
  }, []);

  const isValidConnection: IsValidConnection<PgFlowEdge> = useCallback(
    (c) => {
      const g = useEditorStore.getState().graph;
      return !!g && connectionError(g, toConnectRequest({ source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? null, targetHandle: null })) === null;
    },
    [],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData(PALETTE_MIME);
      if (!(NODE_TYPES as readonly string[]).includes(type)) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      useEditorStore.getState().addNode(type as NodeType, snap({ x: p.x - 120, y: p.y - 30 }));
    },
    [screenToFlowPosition],
  );

  if (!graph) return null;

  return (
    <div className="relative h-full w-full" onDragOver={(e) => onDragOver(e, readOnly)} onDrop={readOnly ? undefined : onDrop}>
      <ReactFlow<PgFlowNode, PgFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onDelete={({ nodes: n, edges: e }) => useEditorStore.getState().removeElements(n.map((x) => x.id), e.map((x) => x.id))}
        onPaneClick={() => useEditorStore.getState().setSelection([], [])}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        multiSelectionKeyCode={["Meta", "Control"]}
        selectionKeyCode="Shift"
        snapToGrid
        snapGrid={GRID}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID[0]} size={1} color="#27272a" />
        <Controls showInteractive={false} />
        <RefitOnDrawerToggle />
        <MiniMap<PgFlowNode> style={MINIMAP_STYLE} pannable zoomable nodeColor={(n) => (n.data.issues.errors.length ? "#ef4444" : "#52525b")} nodeStrokeWidth={0} maskColor="rgb(9 9 11 / 0.7)" />
      </ReactFlow>
      {graph.nodes.length === 0 && <EmptyHint readOnly={readOnly} />}
    </div>
  );
}

function RunCanvas() {
  const detail = useRunStore((s) => s.detail);
  const currentByNode = useRunStore((s) => s.currentByNode);
  const lanes = useRunStore((s) => s.lanes);
  const selectedNodeId = useRunStore((s) => s.selectedNodeId);
  const detailError = useRunStore((s) => s.detailError);
  const phase = useEditorStore((s) => s.phase);
  const [measured, applyMeasured] = useMeasured();
  const graph: Graph | null = detail?.run.graphSnapshot ?? null;

  const input = useMemo(
    () =>
      graph
        ? {
            graph,
            phase,
            validation: { errors: [], warnings: [] },
            selectedNodeIds: selectedNodeId ? [selectedNodeId] : [],
            selectedEdgeIds: [],
            measured,
            run: { currentByNode, lanes },
          }
        : null,
    [graph, phase, selectedNodeId, measured, currentByNode, lanes],
  );
  const nodes = useMemo(() => (input ? toFlowNodes(input) : []), [input]);
  const edges = useMemo(() => (input ? toFlowEdges(input) : []), [input]);

  const onNodeClick = useCallback((_: unknown, n: PgFlowNode) => {
    useRunStore.getState().selectNode(n.id);
    const nodeRun = useRunStore.getState().currentByNode[n.id];
    if (!nodeRun) return;
    if (nodeRun.status === "waiting_approval") useUiStore.getState().openApproval(nodeRun.id);
    openNodeTerminal(nodeRun, n.data.node.label || n.data.node.type);
  }, []);

  if (detailError) return <CenteredMessage tone="error">Could not load the run: {detailError}</CenteredMessage>;
  if (!graph) return <CenteredMessage>Loading run…</CenteredMessage>;

  return (
    <ReactFlow<PgFlowNode, PgFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      onNodesChange={applyMeasured}
      onNodeClick={onNodeClick}
      onPaneClick={() => useRunStore.getState().selectNode(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={GRID[0]} size={1} color="#27272a" />
      <Controls showInteractive={false} />
      <RefitOnDrawerToggle />
      <MiniMap<PgFlowNode>
        style={MINIMAP_STYLE}
        pannable
        zoomable
        nodeColor={(n) => NODE_STATUS_COLOR_HEX[n.data.nodeRun?.status ?? "pending"]}
        nodeStrokeWidth={0}
        maskColor="rgb(9 9 11 / 0.7)"
      />
    </ReactFlow>
  );
}

/** Opening or closing the terminal drawer shrinks the canvas; re-fit so nodes are not hidden under it. */
function RefitOnDrawerToggle() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const { fitView } = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => void fitView({ ...FIT_VIEW_OPTIONS, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [drawerOpen, fitView]);
  return null;
}

function toConnectRequest(c: Connection) {
  const port = c.sourceHandle && SOURCE_PORTS.includes(c.sourceHandle) ? (c.sourceHandle as SourcePort) : "out";
  return { source: c.source, sourcePort: port, target: c.target };
}

function snap(p: Position): Position {
  return { x: Math.round(p.x / GRID[0]) * GRID[0], y: Math.round(p.y / GRID[1]) * GRID[1] };
}

function onDragOver(e: DragEvent, readOnly: boolean): void {
  if (readOnly || !e.dataTransfer.types.includes(PALETTE_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}

function EmptyHint({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/70 px-6 py-4 text-center text-sm text-zinc-400">
        {readOnly ? "This graph is empty." : "Drag a node from the palette to start, then connect the ports."}
      </div>
    </div>
  );
}

function CenteredMessage({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-red-300" : "text-zinc-500"}`}>{children}</div>;
}
