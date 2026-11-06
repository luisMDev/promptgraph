import { edgeWhen, type Graph, type GraphEdge, type Position } from "./graph.js";
import { buildTopology, topologicalOrder } from "./topology.js";

/** Canvas spacing used by the auto layout (matches docs/examples): DX between siblings, DY between layers. */
export const LAYOUT_DX = 300;
export const LAYOUT_DY = 200;

/**
 * Layered top-to-bottom layout (§19.3). Row = longest path from a root over forward (non-loop)
 * edges, where a failure edge does not add a row: an error handler sits beside its source, to the
 * right. The nodes of a row are centred on x = 0, sorted by the mean x of their placed parents (the
 * target of a condition's true port leans left, of its false port right; ties in declaration order),
 * nodes reached only through failure edges last. Nodes on a cycle (an invalid graph) go to an extra
 * last row. Pure: returns a position for every node and does not modify the graph.
 */
export function layeredLayout(graph: Pick<Graph, "nodes" | "edges">): Map<string, Position> {
  const topo = buildTopology(graph);
  const { order, cyclic } = topologicalOrder(topo);
  const depth = new Map<string, number>();
  for (const node of order) {
    depth.set(node.id, Math.max(0, ...topo.incoming.get(node.id)!.map((e) => depth.get(e.source)! + (isFailure(e) ? 0 : 1))));
  }
  const errorOnly = (id: string) => {
    const incoming = topo.incoming.get(id) ?? [];
    return incoming.length > 0 && incoming.every(isFailure);
  };
  const lastRow = Math.max(-1, ...depth.values()) + 1;
  for (const id of cyclic) depth.set(id, lastRow);

  const rows = new Map<number, string[]>();
  const ordered = [...graph.nodes.filter((n) => !errorOnly(n.id)), ...graph.nodes.filter((n) => errorOnly(n.id))];
  for (const node of ordered) {
    const d = depth.get(node.id) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d)!.push(node.id);
  }
  // Rows top to bottom; each row sorted by where its parents sit (true branch left of false) so edges do not cross.
  const positions = new Map<string, Position>();
  for (const d of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(d)!;
    const key = (id: string) => (errorOnly(id) ? Infinity : parentKey(topo.incoming.get(id) ?? [], positions));
    const keys = new Map(row.map((id) => [id, key(id)] as const));
    const sorted = row.map((id, i) => ({ id, i })).sort((a, b) => keys.get(a.id)! - keys.get(b.id)! || a.i - b.i);
    sorted.forEach(({ id }, i) => positions.set(id, { x: (i - (row.length - 1) / 2) * LAYOUT_DX, y: d * LAYOUT_DY }));
  }
  return positions;
}

/** Condition ports lean their targets apart, matching the true (left) / false (right) handles. */
const PORT_BIAS: Partial<Record<string, number>> = { true: -LAYOUT_DX / 4, false: LAYOUT_DX / 4 };

/** Mean x of the already placed parents over success/always edges, plus the port bias; Infinity when none. */
function parentKey(incoming: readonly GraphEdge[], positions: ReadonlyMap<string, Position>): number {
  const xs = incoming
    .filter((e) => !isFailure(e) && positions.has(e.source))
    .map((e) => positions.get(e.source)!.x + (PORT_BIAS[e.sourcePort] ?? 0));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
}

function isFailure(edge: GraphEdge): boolean {
  return edgeWhen(edge) === "failure";
}

/**
 * Edge id derived from its endpoints: `e-<source>[-<port>]-<target>`, suffixed `-2`, `-3`, … until it
 * is not in `used`. The caller adds the result to `used` when it keeps it.
 */
export function deriveEdgeId(edge: { source: string; target: string; sourcePort?: string | null }, used: ReadonlySet<string>): string {
  const port = edge.sourcePort && edge.sourcePort !== "out" ? `-${edge.sourcePort}` : "";
  const base = `e-${edge.source}${port}-${edge.target}`;
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Ids of every edge of the graph, for deriveEdgeId. */
export function edgeIdSet(edges: readonly Pick<GraphEdge, "id">[]): Set<string> {
  return new Set(edges.map((e) => e.id));
}
