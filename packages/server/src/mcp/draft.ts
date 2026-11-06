import { deriveEdgeId, GraphSchema, layeredLayout, type Graph } from "@promptgraph/shared";
import { z } from "zod";

/** Re-exported for callers and tests that predate the move of the layout to @promptgraph/shared. */
export { LAYOUT_DX, LAYOUT_DY } from "@promptgraph/shared";

export class GraphDraftError extends Error {}

type RawRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is RawRecord => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turns a graph written by Claude into a valid `Graph` (§19.3): edges without an `id` get one, then
 * GraphSchema fills the defaults, then nodes that had no `position` are placed by a layered
 * top-to-bottom layout. Structural rules (cycles, joins, configs) are left to validateGraph.
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
    const sourcePort = typeof e.sourcePort === "string" ? e.sourcePort : undefined;
    const id = deriveEdgeId({ source: String(e.source), target: String(e.target), sourcePort }, used);
    used.add(id);
    return { ...e, id };
  });
}
