import type { Graph, GraphEdge, Lane, NodeRun, ValidationResult } from "@promptgraph/shared";
import { MarkerType } from "@xyflow/react";
import type { PgFlowEdge } from "../components/canvas/PgEdge";
import type { NodeIssues, PgFlowNode } from "../components/nodes/types";
import { mergeInputLabels, nodeLanes } from "./lanes";
import { edgeRunState, type EdgeRunState } from "./run-view";

/** Maps the domain graph (+ validation or run state) to React Flow nodes and edges. Pure. */

export interface FlowInput {
  graph: Graph;
  phase: 1 | 2;
  validation: ValidationResult;
  selectedNodeIds: readonly string[];
  selectedEdgeIds: readonly string[];
  measured: Readonly<Record<string, { width: number; height: number }>>;
  /** Present in run mode. */
  run?: { currentByNode: Readonly<Record<string, NodeRun>>; lanes: Readonly<Record<string, Lane>> };
}

export function issuesByNode(validation: ValidationResult): Map<string, NodeIssues> {
  const map = new Map<string, NodeIssues>();
  const get = (id: string) => {
    let v = map.get(id);
    if (!v) map.set(id, (v = { errors: [], warnings: [] }));
    return v;
  };
  for (const i of validation.errors) if (i.nodeId) get(i.nodeId).errors.push(i.message);
  for (const i of validation.warnings) if (i.nodeId) get(i.nodeId).warnings.push(i.message);
  return map;
}

const NO_ISSUES: NodeIssues = { errors: [], warnings: [] };

export function toFlowNodes(input: FlowInput): PgFlowNode[] {
  const issues = input.run ? new Map<string, NodeIssues>() : issuesByNode(input.validation);
  const selected = new Set(input.selectedNodeIds);
  const lanes = input.run ? nodeLanes(input.graph, input.run.lanes, input.run.currentByNode) : null;
  return input.graph.nodes.map((node) => {
    const nodeRun = input.run?.currentByNode[node.id] ?? null;
    const m = input.measured[node.id];
    return {
      id: node.id,
      type: "pg" as const,
      position: node.position,
      selected: selected.has(node.id),
      ...(m ? { measured: m } : {}),
      data: {
        node,
        nodeRun,
        lane: lanes?.get(node.id) ?? null,
        mergeInputs: node.type === "merge" ? mergeInputLabels(input.graph, node.id) : [],
        runMode: !!input.run,
        issues: issues.get(node.id) ?? NO_ISSUES,
        phase: input.phase,
      },
    };
  });
}

const RUN_EDGE_STYLE: Record<EdgeRunState, { stroke: string; animated: boolean; opacity?: number }> = {
  idle: { stroke: "#52525b", animated: false },
  flowing: { stroke: "#60a5fa", animated: true },
  activated: { stroke: "#22c55e", animated: false },
  dead: { stroke: "#3f3f46", animated: false, opacity: 0.5 },
};

function edgeLabel(edge: GraphEdge): string | undefined {
  const parts: string[] = [];
  if (edge.when && edge.when !== "success") parts.push(edge.when);
  if (edge.loop) parts.push(`loop ≤${edge.loop.maxIterations}`);
  return parts.length ? parts.join(" · ") : undefined;
}

export function toFlowEdges(input: FlowInput): PgFlowEdge[] {
  const errorEdges = new Map<string, string[]>();
  const warnEdges = new Set<string>();
  if (!input.run) {
    for (const i of input.validation.errors) if (i.edgeId) errorEdges.set(i.edgeId, [...(errorEdges.get(i.edgeId) ?? []), i.message]);
    for (const i of input.validation.warnings) if (i.edgeId) warnEdges.add(i.edgeId);
  }
  const selected = new Set(input.selectedEdgeIds);
  return input.graph.edges.map((edge) => {
    const failure = edge.sourcePort === "error" || edge.when === "failure";
    let stroke = failure ? "#ef4444" : "#71717a";
    let animated = false;
    let opacity: number | undefined;
    if (input.run) {
      const state = edgeRunState(edge, input.run.currentByNode[edge.source]);
      ({ stroke, animated, opacity } = RUN_EDGE_STYLE[state]);
    } else if (errorEdges.has(edge.id)) {
      stroke = "#ef4444";
    } else if (warnEdges.has(edge.id)) {
      stroke = "#f59e0b";
    }
    const dashed = !!edge.loop || failure;
    const label = edgeLabel(edge);
    return {
      id: edge.id,
      type: "pg" as const,
      source: edge.source,
      sourceHandle: edge.sourcePort,
      target: edge.target,
      targetHandle: edge.targetPort,
      selected: selected.has(edge.id),
      animated,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      style: {
        stroke,
        strokeWidth: errorEdges.has(edge.id) ? 2.5 : 2,
        ...(dashed ? { strokeDasharray: "6 4" } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
      },
      data: { title: errorEdges.get(edge.id)?.join("\n"), label },
    };
  });
}
