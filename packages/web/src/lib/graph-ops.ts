import {
  defaultNodeConfig,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type Position,
  type SourcePort,
} from "@promptgraph/shared";
import { NODE_TYPE_META } from "./node-meta";

/** Pure graph mutations used by the editor store. Every function returns a new graph (or the same one if unchanged). */

function randomId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36).slice(-4)}${rand}`;
}

function uniqueId(prefix: string, taken: ReadonlySet<string>): string {
  let id = randomId(prefix);
  while (taken.has(id)) id = randomId(prefix);
  return id;
}

/** "Prompt", "Prompt 2", … — the first title not used as a label yet. */
export function defaultLabel(graph: Graph, type: NodeType): string {
  const base = NODE_TYPE_META[type].title;
  const labels = new Set(graph.nodes.map((n) => n.label));
  if (!labels.has(base)) return base;
  for (let i = 2; ; i++) if (!labels.has(`${base} ${i}`)) return `${base} ${i}`;
}

export function createNode(graph: Graph, type: NodeType, position: Position): GraphNode {
  const id = uniqueId("n", new Set(graph.nodes.map((n) => n.id)));
  return { id, type, label: defaultLabel(graph, type), position, config: defaultNodeConfig(type) } as GraphNode;
}

export function addNode(graph: Graph, node: GraphNode): Graph {
  return { ...graph, nodes: [...graph.nodes, node] };
}

export interface ConnectRequest {
  source: string;
  sourcePort: SourcePort;
  target: string;
}

/**
 * Why a connection is refused, or null if it can be made. Before phase 2 there are no loop edges, so a
 * connection that would close a cycle is refused while dragging instead of becoming a validation error.
 */
export function connectionError(graph: Graph, c: ConnectRequest, phase: 1 | 2 = 2): string | null {
  if (c.source === c.target) return "A node cannot connect to itself";
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(c.source) || !ids.has(c.target)) return "Unknown node";
  if (graph.edges.some((e) => e.source === c.source && e.target === c.target && e.sourcePort === c.sourcePort)) {
    return "These nodes are already connected";
  }
  if (phase < 2 && reaches(graph, c.target, c.source)) return "This connection would create a cycle";
  return null;
}

/** True when `to` can be reached from `from` along forward (non-loop) edges. */
function reaches(graph: Graph, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (e.source === id && !e.loop) stack.push(e.target);
  }
  return false;
}

export function connect(graph: Graph, c: ConnectRequest, phase: 1 | 2 = 2): Graph {
  if (connectionError(graph, c, phase)) return graph;
  const edge: GraphEdge = {
    id: uniqueId("e", new Set(graph.edges.map((e) => e.id))),
    source: c.source,
    sourcePort: c.sourcePort,
    target: c.target,
    targetPort: "in",
  };
  return { ...graph, edges: [...graph.edges, edge] };
}

/** Removes nodes (and every edge touching them) and edges. */
export function removeElements(graph: Graph, nodeIds: Iterable<string>, edgeIds: Iterable<string>): Graph {
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  if (nodes.size === 0 && edges.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !nodes.has(n.id)),
    edges: graph.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.source) && !nodes.has(e.target)),
  };
}

export function updateNode(graph: Graph, id: string, fn: (node: GraphNode) => GraphNode): Graph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (n.id !== id) return n;
    const next = fn(n);
    changed ||= next !== n;
    return next;
  });
  return changed ? { ...graph, nodes } : graph;
}

export function updateEdge(graph: Graph, id: string, fn: (edge: GraphEdge) => GraphEdge): Graph {
  return { ...graph, edges: graph.edges.map((e) => (e.id === id ? fn(e) : e)) };
}

export function moveNodes(graph: Graph, positions: ReadonlyMap<string, Position>): Graph {
  if (positions.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = positions.get(n.id);
      return p && (p.x !== n.position.x || p.y !== n.position.y) ? { ...n, position: p } : n;
    }),
  };
}
