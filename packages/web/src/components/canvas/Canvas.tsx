import { NODE_TYPES, webRoutes, type Graph, type NodeType, type Position, type SourcePort } from "@promptgraph/shared";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
  useStoreApi,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { toFlowEdges, toFlowNodes } from "../../lib/flow-mapping";
import { connectionError } from "../../lib/graph-ops";
import { editorNodeHex, statusHex } from "../../lib/status-hex";
import { useTheme } from "../../lib/theme";
import { readableViewport } from "../../lib/viewport";
import { toast } from "../../store/toast-store";
import { showNodeRun } from "../../store/view/actions";
import { useEditor, useRun, useTabActive, useView, useViewUi } from "../../store/view/context";
import { isReadOnly } from "../../store/view/editor-store";
import { Icons } from "../common/icons";
import { nodeTypes } from "../nodes/NodeCard";
import type { PgFlowNode } from "../nodes/types";
import { edgeTypes, type PgFlowEdge } from "./PgEdge";

export const PALETTE_MIME = "application/x-promptgraph-node";
const GRID: [number, number] = [16, 16];
const SOURCE_PORTS: readonly string[] = ["out", "true", "false", "error"];
const MINIMAP_STYLE = { width: 160, height: 100 };
/** Below this canvas width the minimap would cover most of the graph. */
const MINIMAP_MIN_CANVAS_WIDTH = 600;
const REFIT_DEBOUNCE_MS = 150;
const FIT_ANIMATION_MS = 200;

type Measured = Record<string, { width: number; height: number }>;

/** React Flow canvas: editable graph in edit mode, read-only run snapshot with live statuses in run mode. */
export function Canvas() {
  const graphId = useEditor((s) => s.graph?.id ?? null);
  const runId = useRun((s) => s.selectedRunId);
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
  const theme = useTheme();
  const { editor: editorStore } = useView();
  const active = useTabActive();
  const graph = useEditor((s) => s.graph);
  const phase = useEditor((s) => s.phase);
  const validation = useEditor((s) => s.validation);
  const selectedNodeIds = useEditor((s) => s.selectedNodeIds);
  const selectedEdgeIds = useEditor((s) => s.selectedEdgeIds);
  const readOnly = useEditor(isReadOnly);
  const [measured, applyMeasured] = useMeasured();
  const { screenToFlowPosition } = useReactFlow();
  // Fitting an empty graph would jump the viewport when the first node is dropped, so the next drops
  // land on top of it: fit on mount only when there is something to fit.
  const fitOnMount = useRef((graph?.nodes.length ?? 0) > 0).current;
  const { manual, onMoveStart, onMoveEnd } = useManualViewport();

  const input = useMemo(
    () => (graph ? { graph, phase, validation, selectedNodeIds, selectedEdgeIds, measured } : null),
    [graph, phase, validation, selectedNodeIds, selectedEdgeIds, measured],
  );
  const nodes = useMemo(() => (input ? toFlowNodes(input) : []), [input]);
  const edges = useMemo(() => (input ? toFlowEdges(input) : []), [input]);

  const onNodesChange = useCallback(
    (changes: NodeChange<PgFlowNode>[]) => {
      applyMeasured(changes);
      const editor = editorStore.getState();
      const positions = new Map<string, Position>();
      for (const c of changes) if (c.type === "position" && c.position) positions.set(c.id, c.position);
      if (positions.size) editor.moveNodes(positions);
      const selects = changes.filter((c) => c.type === "select");
      if (selects.length) {
        const set = new Set(editor.selectedNodeIds);
        for (const c of selects) if (c.type === "select") (c.selected ? set.add(c.id) : set.delete(c.id));
        editor.setSelection([...set], editorStore.getState().selectedEdgeIds);
      }
    },
    [applyMeasured, editorStore],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<PgFlowEdge>[]) => {
    const selects = changes.filter((c) => c.type === "select");
    if (!selects.length) return;
    const editor = editorStore.getState();
    const set = new Set(editor.selectedEdgeIds);
    for (const c of selects) if (c.type === "select") (c.selected ? set.add(c.id) : set.delete(c.id));
    editor.setSelection(editorStore.getState().selectedNodeIds, [...set]);
  }, [editorStore]);

  const onConnect = useCallback(
    (c: Connection) => {
      const error = editorStore.getState().connect(toConnectRequest(c));
      if (error) toast("error", error);
    },
    [editorStore],
  );

  const isValidConnection: IsValidConnection<PgFlowEdge> = useCallback(
    (c) => {
      const { graph: g, phase: p } = editorStore.getState();
      return !!g && connectionError(g, toConnectRequest({ source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? null, targetHandle: null }), p) === null;
    },
    [editorStore],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData(PALETTE_MIME);
      if (!(NODE_TYPES as readonly string[]).includes(type)) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      editorStore.getState().addNode(type as NodeType, snap({ x: p.x - 120, y: p.y - 30 }));
    },
    [screenToFlowPosition, editorStore],
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
        onDelete={({ nodes: n, edges: e }) => editorStore.getState().removeElements(n.map((x) => x.id), e.map((x) => x.id))}
        onPaneClick={() => editorStore.getState().setSelection([], [])}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        // A hidden view must not react to keys: React Flow listens on document (DESIGN §13.4).
        deleteKeyCode={readOnly || !active ? null : ["Backspace", "Delete"]}
        multiSelectionKeyCode={active ? ["Meta", "Control"] : null}
        selectionKeyCode={active ? "Shift" : null}
        snapToGrid
        snapGrid={GRID}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID[0]} size={1} color="var(--pg-canvas-dots)" />
        <CanvasControls manual={manual} />
        <AutoFit manual={manual} fitOnInit={fitOnMount} />
        <RevealRequestedNode measured={measured} />
        <WideEnoughForMinimap>
          <MiniMap<PgFlowNode> style={MINIMAP_STYLE} pannable zoomable nodeColor={(n) => editorNodeHex(n.data.issues.errors.length > 0, theme)} nodeStrokeWidth={0} maskColor="var(--pg-minimap-mask)" />
        </WideEnoughForMinimap>
      </ReactFlow>
      {graph.nodes.length === 0 && <EmptyHint readOnly={readOnly} />}
    </div>
  );
}

function RunCanvas() {
  const theme = useTheme();
  const view = useView();
  const active = useTabActive();
  const detail = useRun((s) => s.detail);
  const currentByNode = useRun((s) => s.currentByNode);
  const lanes = useRun((s) => s.lanes);
  const loops = useRun((s) => s.loops);
  const selectedNodeId = useRun((s) => s.selectedNodeId);
  const detailError = useRun((s) => s.detailError);
  const phase = useEditor((s) => s.phase);
  const [measured, applyMeasured] = useMeasured();
  const { manual, onMoveStart, onMoveEnd } = useManualViewport();
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
            run: { currentByNode, lanes, loops },
          }
        : null,
    [graph, phase, selectedNodeId, measured, currentByNode, lanes, loops],
  );
  const nodes = useMemo(() => (input ? toFlowNodes(input) : []), [input]);
  const edges = useMemo(() => (input ? toFlowEdges(input) : []), [input]);

  // Selecting a node run is a navigation within the same run (replace: no history entry per click).
  const onNodeClick = useCallback(
    (_: unknown, n: PgFlowNode) => {
      const runs = view.run.getState();
      const runId = runs.selectedRunId;
      const nodeRun = runs.currentByNode[n.id];
      if (!runId) return;
      if (!nodeRun) {
        runs.selectNode(n.id);
        view.navigate(webRoutes.run(view.repoId, runId), { replace: true });
        return;
      }
      showNodeRun(view, nodeRun);
      view.navigate(webRoutes.nodeRun(view.repoId, runId, nodeRun.id), { replace: true });
    },
    [view],
  );
  const onPaneClick = useCallback(() => {
    const runs = view.run.getState();
    runs.selectNode(null);
    if (runs.selectedRunId) view.navigate(webRoutes.run(view.repoId, runs.selectedRunId), { replace: true });
  }, [view]);

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
      onPaneClick={onPaneClick}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      multiSelectionKeyCode={active ? undefined : null}
      selectionKeyCode={active ? undefined : null}
      onMoveStart={onMoveStart}
      onMoveEnd={onMoveEnd}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={GRID[0]} size={1} color="var(--pg-canvas-dots)" />
      <CanvasControls manual={manual} />
      <AutoFit manual={manual} fitOnInit />
      <WideEnoughForMinimap>
        <MiniMap<PgFlowNode>
          style={MINIMAP_STYLE}
          pannable
          zoomable
          nodeColor={(n) => statusHex(n.data.nodeRun?.status ?? "pending", theme)}
          nodeStrokeWidth={0}
          maskColor="var(--pg-minimap-mask)"
        />
      </WideEnoughForMinimap>
    </ReactFlow>
  );
}

/**
 * Set once the user pans or zooms (a move with a DOM event, or the zoom buttons): from then on the
 * canvas keeps their viewport on resize instead of re-fitting. The fit button resets it.
 */
function useManualViewport() {
  const manual = useRef(false);
  const start = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // A click on a (non-draggable) node also starts a d3 "move": only a move that changed the viewport counts.
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }) => {
    start.current = event ? viewport : null;
  }, []);
  const onMoveEnd = useCallback((event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }) => {
    const from = start.current;
    start.current = null;
    if (event && from && (from.x !== viewport.x || from.y !== viewport.y || from.zoom !== viewport.zoom)) manual.current = true;
  }, []);
  return { manual, onMoveStart, onMoveEnd };
}

/** Fits the graph at a readable zoom (lib/viewport): never below FIT_MIN_ZOOM, start-aligned when too big. */
function useReadableFit() {
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const store = useStoreApi();
  return useCallback(
    (duration?: number) => {
      const nodes = getNodes();
      const { width, height } = store.getState();
      if (nodes.length === 0 || !width || !height) return;
      void setViewport(readableViewport(getNodesBounds(nodes), { width, height }), duration ? { duration } : undefined);
    },
    [getNodes, getNodesBounds, setViewport, store],
  );
}

/**
 * Fits once the nodes are measured (when `fitOnInit`), and again (debounced) whenever the canvas changes
 * size with the window, the terminal drawer or the side panels — unless the user moved the viewport.
 */
function AutoFit({ manual, fitOnInit }: { manual: RefObject<boolean>; fitOnInit: boolean }) {
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const initialized = useNodesInitialized();
  const fit = useReadableFit();
  const fitted = useRef(false);
  const last = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!fitOnInit || fitted.current || !initialized || !width || !height) return;
    fitted.current = true;
    fit();
  }, [fitOnInit, initialized, width, height, fit]);

  useEffect(() => {
    const prev = last.current;
    last.current = { width, height };
    if (!prev || prev.width === 0 || (prev.width === width && prev.height === height) || manual.current) return;
    const timer = setTimeout(() => fit(FIT_ANIMATION_MS), REFIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [width, height, manual, fit]);
  return null;
}

/** Zoom buttons count as a manual viewport; our fit button replaces React Flow's (which ignores the minimum zoom). */
function CanvasControls({ manual }: { manual: RefObject<boolean> }) {
  const fit = useReadableFit();
  const markManual = useCallback(() => {
    manual.current = true;
  }, [manual]);
  return (
    <Controls showInteractive={false} showFitView={false} onZoomIn={markManual} onZoomOut={markManual}>
      <ControlButton
        title="Fit view"
        aria-label="Fit view"
        onClick={() => {
          manual.current = false;
          fit(FIT_ANIMATION_MS);
        }}
      >
        <Icons.fit />
      </ControlButton>
    </Controls>
  );
}

function WideEnoughForMinimap({ children }: { children: ReactNode }) {
  const wide = useStore((s) => s.width >= MINIMAP_MIN_CANVAS_WIDTH);
  return wide ? children : null;
}

/** Pans to a node added by a palette click when it landed outside the visible area. */
function RevealRequestedNode({ measured }: { measured: Measured }) {
  const { ui } = useView();
  const nodeId = useViewUi((s) => s.revealNodeId);
  const node = useEditor((s) => (nodeId ? s.graph?.nodes.find((n) => n.id === nodeId) : undefined));
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const { getViewport, setCenter } = useReactFlow();
  useEffect(() => {
    if (!nodeId) return;
    ui.getState().revealNode(null);
    if (!node) return;
    const size = measured[node.id] ?? { width: 240, height: 80 };
    const { x, y, zoom } = getViewport();
    const left = node.position.x * zoom + x;
    const top = node.position.y * zoom + y;
    const visible = left >= 0 && top >= 0 && left + size.width * zoom <= width && top + size.height * zoom <= height;
    if (!visible) void setCenter(node.position.x + size.width / 2, node.position.y + size.height / 2, { zoom, duration: 300 });
  }, [nodeId, node, measured, width, height, getViewport, setCenter, ui]);
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
      <div className="rounded-lg border border-dashed bg-card/70 px-6 py-4 text-center text-sm text-muted-foreground">
        {readOnly ? "This graph is empty." : "Drag a node from the palette to start, then connect the ports."}
      </div>
    </div>
  );
}

function CenteredMessage({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <div className={`flex h-full items-center justify-center text-sm ${tone === "error" ? "text-red-700" : "text-muted-foreground"}`}>{children}</div>;
}
