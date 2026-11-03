import { buildTopology, GraphSchema, topologicalOrder, type Graph } from "@promptgraph/shared";
import { z } from "zod";

/** Canvas spacing used by the auto layout (matches docs/examples). */
export const LAYOUT_DX = 300;
const LAYOUT_DY = 180;

export class GraphDraftError extends Error {}

type RawRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is RawRecord => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turns a graph written by Claude into a valid `Graph` (§19.3): edges without an `id` get one, then
 * GraphSchema fills the defaults, then nodes that had no `position` are placed by a layered
 * left-to-right layout. Structural rules (cycles, joins, configs) are left to validateGraph.
 * `layout`: "missing" (default) places only nodes without a position, "all" every node, "keep" none.
 * @throws GraphDraftError with the schema issues.
 */
export function normalizeGraphDraft(input: unknown, opts: { layout?: "missing" | "all" | "keep" } = {}): Graph {
  if (!isRecord(input)) throw new GraphDraftError("graph must be a JSON object");
  const unplaced = new Set(
    (Array.isArray(input.nodes) ? input.nodes : [])
      .filter((n): n is RawRecord => isRecord(n) && (opts.layout === "all" || !isRecord(n.position)))
      .map((n) => String(n.id)),
  );
  const edges = Array.isArray(input.edges) ? assignEdgeIds(input.edges) : input.edges;
  const parsed = GraphSchema.safeParse({ version: 1, ...input, edges });
  if (!parsed.success) throw new GraphDraftError(`graph does not match the promptgraph schema:\n${z.prettifyError(parsed.error)}`);
  const graph = parsed.data;
  if (opts.layout !== "keep" && unplaced.size > 0) {
    const positions = layeredLayout(graph);
    for (const node of graph.nodes) if (unplaced.has(node.id)) node.position = positions.get(node.id)!;
  }
  return graph;
}

function assignEdgeIds(edges: unknown[]): unknown[] {
  const used = new Set(edges.filter(isRecord).map((e) => e.id).filter((id): id is string => typeof id === "string" && id.length > 0));
  return edges.map((e) => {
    if (!isRecord(e) || (typeof e.id === "string" && e.id.length > 0)) return e;
    const port = typeof e.sourcePort === "string" && e.sourcePort !== "out" ? `-${e.sourcePort}` : "";
    const base = `e-${String(e.source)}${port}-${String(e.target)}`;
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return { ...e, id };
  });
}

/**
 * Column = longest path from a root over forward (non-loop) edges; rows are centred on y = 0 in
 * declaration order. Nodes on a cycle (an invalid graph) go to an extra last column.
 */
function layeredLayout(graph: Graph): Map<string, { x: number; y: number }> {
  const topo = buildTopology(graph);
  const { order, cyclic } = topologicalOrder(topo);
  const depth = new Map<string, number>();
  for (const node of order) {
    depth.set(node.id, Math.max(0, ...topo.incoming.get(node.id)!.map((e) => depth.get(e.source)! + 1)));
  }
  const lastColumn = Math.max(-1, ...depth.values()) + 1;
  for (const id of cyclic) depth.set(id, lastColumn);

  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.id)!;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(node.id);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, column] of columns) {
    column.forEach((id, i) => positions.set(id, { x: d * LAYOUT_DX, y: (i - (column.length - 1) / 2) * LAYOUT_DY }));
  }
  return positions;
}
