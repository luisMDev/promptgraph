import { z } from "zod";
import {
  edgeWhen,
  EdgeSchema,
  EdgeWhenSchema,
  GraphSchema,
  NODE_CONFIG_SCHEMAS,
  LoopSpecSchema,
  NodeSchema,
  NodeTypeSchema,
  OnErrorSchema,
  PositionSchema,
  SourcePortSchema,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type Position,
} from "./graph.js";
import { deriveEdgeId, edgeIdSet, LAYOUT_DX, LAYOUT_DY, layeredLayout } from "./layout.js";
import { buildTopology, topologicalOrder } from "./topology.js";

/**
 * Incremental edits of a graph (DESIGN §20.7), used by the `patch_graph` MCP tool so Claude can change
 * the graph on screen without rewriting it. Existing nodes keep their ids and positions; only the
 * nodes and edges named by the ops change. `applyGraphPatch` is pure.
 */

/** A node to create. `id` is derived from the label (or type) when absent; `position` is placed when absent. */
export const GraphPatchNodeSchema = z.object({
  id: z.string().min(1).optional(),
  type: NodeTypeSchema,
  label: z.string().optional(),
  position: PositionSchema.optional(),
  /** Node config for its type; omitted fields take the type's defaults. */
  config: z.record(z.string(), z.unknown()).optional(),
  onError: OnErrorSchema.optional(),
});
export type GraphPatchNode = z.infer<typeof GraphPatchNodeSchema>;

export const GraphPatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: GraphPatchNodeSchema }),
  z.object({
    op: z.literal("update_node"),
    id: z.string().min(1),
    label: z.string().optional(),
    position: PositionSchema.optional(),
    /** null clears the field (falls back to the default). */
    onError: OnErrorSchema.nullable().optional(),
    /** Shallow merge into the node's config; a key set to null is removed (back to its default). */
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    op: z.literal("remove_node"),
    id: z.string().min(1),
    /**
     * Bridge each predecessor to each success successor (outgoing success edges on port "out") so the flow stays
     * connected. Failure, always and condition-branch edges of the removed node are dropped with it. Default true.
     */
    reconnect: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("connect"),
    source: z.string().min(1),
    target: z.string().min(1),
    /** Derived from the endpoints when absent. */
    id: z.string().min(1).optional(),
    sourcePort: SourcePortSchema.optional(),
    when: EdgeWhenSchema.optional(),
    loop: LoopSpecSchema.optional(),
  }),
  /** Either `edgeId`, or `source` + `target` (+ `sourcePort` to pick one edge among several). */
  z.object({
    op: z.literal("disconnect"),
    edgeId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    sourcePort: SourcePortSchema.optional(),
  }),
  /**
   * The new node takes over the success edges of `after` on `port` (default "out"), and an edge
   * `after` → new node is added on that port. Failure, always and loop edges stay on `after`.
   */
  z.object({ op: z.literal("insert_after"), after: z.string().min(1), node: GraphPatchNodeSchema, port: SourcePortSchema.optional() }),
  /** The new node takes over every incoming edge of `before`, and an edge new node → `before` is added. */
  z.object({ op: z.literal("insert_before"), before: z.string().min(1), node: GraphPatchNodeSchema }),
]);
export type GraphPatchOp = z.infer<typeof GraphPatchOpSchema>;
export type GraphPatchOpInput = z.input<typeof GraphPatchOpSchema>;
export type GraphPatchOpOf<K extends GraphPatchOp["op"]> = Extract<GraphPatchOp, { op: K }>;

export const GraphPatchSchema = z.array(GraphPatchOpSchema).min(1);
export type GraphPatch = z.infer<typeof GraphPatchSchema>;

export const GRAPH_PATCH_ERROR_CODES = [
  "unknown_node",
  "unknown_edge",
  "duplicate_node",
  "duplicate_edge",
  "ambiguous_edge",
  "invalid_op",
  "invalid_node",
  "invalid_result",
] as const;
export type GraphPatchErrorCode = (typeof GRAPH_PATCH_ERROR_CODES)[number];

/** An op that cannot be applied. `opIndex` is the 0-based index of the op (absent for the final check). */
export class GraphPatchError extends Error {
  override readonly name = "GraphPatchError";
  constructor(
    readonly code: GraphPatchErrorCode,
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
  }
}

export interface GraphPatchResult {
  graph: Graph;
  /** Node ids, each in at most one list. A node added then removed by the same patch is in none. */
  added: string[];
  removed: string[];
  updated: string[];
  addedEdges: string[];
  removedEdges: string[];
  /** Existing edges rewired by insert_after / insert_before (id kept). */
  updatedEdges: string[];
}

/** Applies `ops` in order to a copy of `graph`. @throws GraphPatchError on the first op that cannot apply. */
export function applyGraphPatch(graph: Graph, ops: readonly GraphPatchOpInput[]): GraphPatchResult {
  const parsedOps = z.array(GraphPatchOpSchema).safeParse(ops);
  if (!parsedOps.success) throw new GraphPatchError("invalid_op", `invalid patch ops:\n${z.prettifyError(parsedOps.error)}`);
  const p = new Patcher(structuredClone(graph));
  parsedOps.data.forEach((op, i) => p.apply(op, i));
  return p.finish();
}

class Patcher {
  private readonly added = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly updated = new Set<string>();
  private readonly addedEdges = new Set<string>();
  private readonly removedEdges = new Set<string>();
  private readonly updatedEdges = new Set<string>();
  /** New nodes created without a position, placed by finish(). */
  private readonly unplaced = new Set<string>();
  private opIndex = 0;

  constructor(private readonly graph: Graph) {}

  apply(op: GraphPatchOp, index: number): void {
    this.opIndex = index;
    switch (op.op) {
      case "add_node":
        this.addNode(op.node);
        return;
      case "update_node":
        this.updateNode(op);
        return;
      case "remove_node":
        this.removeNode(op.id, op.reconnect ?? true);
        return;
      case "connect":
        this.connect(op);
        return;
      case "disconnect":
        this.disconnect(op);
        return;
      case "insert_after":
        this.insertAfter(op);
        return;
      case "insert_before":
        this.insertBefore(op);
        return;
    }
  }

  finish(): GraphPatchResult {
    this.placeNewNodes();
    const parsed = GraphSchema.safeParse(this.graph);
    if (!parsed.success) throw new GraphPatchError("invalid_result", `the patched graph does not match the schema:\n${z.prettifyError(parsed.error)}`);
    return {
      graph: parsed.data,
      added: [...this.added],
      removed: [...this.removed],
      updated: [...this.updated].filter((id) => !this.added.has(id)),
      addedEdges: [...this.addedEdges],
      removedEdges: [...this.removedEdges],
      updatedEdges: [...this.updatedEdges].filter((id) => !this.addedEdges.has(id)),
    };
  }

  // --- ops ---------------------------------------------------------------

  private addNode(draft: GraphPatchNode): GraphNode {
    const id = draft.id ?? this.deriveNodeId(draft);
    if (this.findNode(id)) this.fail("duplicate_node", `node "${id}" already exists`);
    if (draft.config) this.checkConfigKeys(id, draft.type, draft.config);
    const parsed = NodeSchema.safeParse({
      id,
      type: draft.type,
      label: draft.label ?? "",
      position: draft.position ?? { x: 0, y: 0 },
      config: draft.config ?? {},
      ...(draft.onError ? { onError: draft.onError } : {}),
    });
    if (!parsed.success) this.fail("invalid_node", `node "${id}" is invalid:\n${z.prettifyError(parsed.error)}`);
    const node = parsed.data;
    this.graph.nodes.push(node);
    if (!draft.position) this.unplaced.add(id);
    if (this.removed.delete(id)) this.updated.add(id);
    else this.added.add(id);
    return node;
  }

  private updateNode(op: GraphPatchOpOf<"update_node">): void {
    const index = this.graph.nodes.findIndex((n) => n.id === op.id);
    if (index < 0) this.fail("unknown_node", `node "${op.id}" does not exist`);
    const current = this.graph.nodes[index]!;
    const next: Record<string, unknown> = { ...current };
    if (op.label !== undefined) next.label = op.label;
    if (op.position !== undefined) {
      next.position = op.position;
      this.unplaced.delete(op.id);
    }
    if (op.onError === null) delete next.onError;
    else if (op.onError !== undefined) next.onError = op.onError;
    if (op.config) {
      this.checkConfigKeys(op.id, current.type, op.config);
      const config: Record<string, unknown> = { ...(current.config as Record<string, unknown>) };
      for (const [key, value] of Object.entries(op.config)) {
        if (value === null) delete config[key];
        else config[key] = value;
      }
      next.config = config;
    }
    const parsed = NodeSchema.safeParse(next);
    if (!parsed.success) this.fail("invalid_node", `node "${op.id}" is invalid after the update:\n${z.prettifyError(parsed.error)}`);
    this.graph.nodes[index] = parsed.data;
    this.updated.add(op.id);
  }

  private removeNode(id: string, reconnect: boolean): void {
    if (!this.findNode(id)) this.fail("unknown_node", `node "${id}" does not exist`);
    const incoming = this.graph.edges.filter((e) => e.target === id && e.source !== id);
    const outgoing = this.graph.edges.filter((e) => e.source === id && e.target !== id);
    for (const e of this.graph.edges.filter((e) => e.source === id || e.target === id)) this.dropEdge(e.id);
    this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
    this.unplaced.delete(id);
    this.updated.delete(id);
    if (!this.added.delete(id)) this.removed.add(id);
    if (!reconnect) return;
    // Only the success path is bridged: a failure / always handler of the removed node must not become a
    // success branch of its predecessor (it would run on every success, in a parallel lane).
    const bridged = outgoing.filter((e) => (e.sourcePort ?? "out") === "out" && edgeWhen(e) === "success");
    for (const inEdge of incoming) {
      for (const outEdge of bridged) {
        if (inEdge.source === outEdge.target) continue;
        // The bridge keeps the predecessor's branch (port and condition) and the successor edge's loop.
        const loop = outEdge.loop ?? inEdge.loop;
        const edge = { source: inEdge.source, sourcePort: inEdge.sourcePort, target: outEdge.target, when: inEdge.when, loop };
        if (this.findSameEdge(edge)) continue;
        this.pushEdge(edge);
      }
    }
  }

  private connect(op: GraphPatchOpOf<"connect">): void {
    this.requireNode(op.source);
    this.requireNode(op.target);
    const sourcePort = op.sourcePort ?? "out";
    if (this.findSameEdge({ source: op.source, sourcePort, target: op.target })) {
      this.fail("duplicate_edge", `an edge ${op.source}${sourcePort === "out" ? "" : `:${sourcePort}`} → ${op.target} already exists`);
    }
    if (op.id && this.graph.edges.some((e) => e.id === op.id)) this.fail("duplicate_edge", `edge id "${op.id}" already exists`);
    this.pushEdge({ id: op.id, source: op.source, sourcePort, target: op.target, when: op.when, loop: op.loop });
  }

  private disconnect(op: GraphPatchOpOf<"disconnect">): void {
    if (op.edgeId) {
      if (!this.graph.edges.some((e) => e.id === op.edgeId)) this.fail("unknown_edge", `edge "${op.edgeId}" does not exist`);
      this.dropEdge(op.edgeId);
      return;
    }
    if (!op.source || !op.target) this.fail("invalid_op", "disconnect needs `edgeId`, or `source` and `target`");
    const matches = this.graph.edges.filter(
      (e) => e.source === op.source && e.target === op.target && (op.sourcePort === undefined || e.sourcePort === op.sourcePort),
    );
    if (matches.length === 0) this.fail("unknown_edge", `no edge ${op.source} → ${op.target}`);
    if (matches.length > 1) {
      this.fail("ambiguous_edge", `several edges ${op.source} → ${op.target} (${matches.map((e) => e.id).join(", ")}): pass edgeId or sourcePort`);
    }
    this.dropEdge(matches[0]!.id);
  }

  private insertAfter(op: GraphPatchOpOf<"insert_after">): void {
    this.requireNode(op.after);
    const port = op.port ?? "out";
    // Only the success path moves: failure / always handlers and loop back-edges keep reacting to `after`.
    const taken = this.graph.edges.filter(
      (e) => e.source === op.after && (e.sourcePort ?? "out") === port && e.target !== op.after && edgeWhen(e) === "success" && !e.loop,
    );
    const node = this.addNode(op.node);
    for (const e of taken) {
      e.source = node.id;
      e.sourcePort = "out";
      this.updatedEdges.add(e.id);
    }
    this.pushEdge({ source: op.after, sourcePort: port, target: node.id });
  }

  private insertBefore(op: GraphPatchOpOf<"insert_before">): void {
    this.requireNode(op.before);
    const taken = this.graph.edges.filter((e) => e.target === op.before && e.source !== op.before);
    const node = this.addNode(op.node);
    for (const e of taken) {
      e.target = node.id;
      this.updatedEdges.add(e.id);
    }
    this.pushEdge({ source: node.id, target: op.before });
  }

  // --- helpers -----------------------------------------------------------

  private fail(code: GraphPatchErrorCode, message: string): never {
    throw new GraphPatchError(code, `op ${this.opIndex}: ${message}`, this.opIndex);
  }

  /** Node config schemas drop unknown keys: a misspelt field would be a silent no-op, so it is an error. */
  private checkConfigKeys(id: string, type: NodeType, config: Record<string, unknown>): void {
    const known = Object.keys(NODE_CONFIG_SCHEMAS[type].shape);
    const unknown = Object.keys(config).filter((k) => !known.includes(k));
    if (unknown.length === 0) return;
    const fields = unknown.map((k) => `"${k}"`).join(", ");
    this.fail("invalid_node", `node "${id}": unknown config field${unknown.length > 1 ? "s" : ""} ${fields} for ${type} nodes (expected: ${known.join(", ")})`);
  }

  private findNode(id: string): GraphNode | undefined {
    return this.graph.nodes.find((n) => n.id === id);
  }

  private requireNode(id: string): GraphNode {
    return this.findNode(id) ?? this.fail("unknown_node", `node "${id}" does not exist`);
  }

  private findSameEdge(edge: { source: string; sourcePort?: string; target: string }): GraphEdge | undefined {
    const port = edge.sourcePort ?? "out";
    return this.graph.edges.find((e) => e.source === edge.source && e.target === edge.target && e.sourcePort === port);
  }

  private pushEdge(edge: { id?: string; source: string; sourcePort?: string; target: string; when?: unknown; loop?: unknown }): void {
    const id = edge.id ?? deriveEdgeId(edge, edgeIdSet(this.graph.edges));
    const raw = Object.fromEntries(Object.entries({ ...edge, id }).filter(([, v]) => v !== undefined));
    const parsed = EdgeSchema.safeParse(raw);
    if (!parsed.success) this.fail("invalid_op", `edge "${id}" is invalid:\n${z.prettifyError(parsed.error)}`);
    this.graph.edges.push(parsed.data);
    if (this.removedEdges.delete(id)) this.updatedEdges.add(id);
    else this.addedEdges.add(id);
  }

  private dropEdge(id: string): void {
    this.graph.edges = this.graph.edges.filter((e) => e.id !== id);
    this.updatedEdges.delete(id);
    if (!this.addedEdges.delete(id)) this.removedEdges.add(id);
  }

  private deriveNodeId(draft: GraphPatchNode): string {
    const base =
      (draft.label ?? "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "") || draft.type;
    let id = base;
    for (let i = 2; this.findNode(id); i++) id = `${base}-${i}`;
    return id;
  }

  /**
   * Places new nodes that came without a position, in forward topological order so a node's
   * predecessors are placed first: one row below its first placed predecessor (beside it, to the
   * right, when reached through a failure edge), else one row above its first placed successor, else
   * below the whole graph; then moved right until it does not overlap another node. When every node of the graph is new, the layered layout places them all.
   */
  private placeNewNodes(): void {
    if (this.unplaced.size === 0) return;
    if (this.graph.nodes.every((n) => this.unplaced.has(n.id))) {
      const positions = layeredLayout(this.graph);
      for (const node of this.graph.nodes) node.position = positions.get(node.id)!;
      return;
    }
    const topo = buildTopology(this.graph);
    const { order, cyclic } = topologicalOrder(topo);
    const sequence = [...order.map((n) => n.id), ...cyclic].filter((id) => this.unplaced.has(id));
    const placed = new Set(this.graph.nodes.filter((n) => !this.unplaced.has(n.id)).map((n) => n.id));
    const byId = new Map(this.graph.nodes.map((n) => [n.id, n] as const));
    for (const id of sequence) {
      const node = byId.get(id)!;
      const predEdge = topo.incoming.get(id)!.find((e) => placed.has(e.source));
      const pred = predEdge && byId.get(predEdge.source)!;
      const succ = topo.outgoing.get(id)!.map((e) => byId.get(e.target)!).find((n) => placed.has(n.id));
      const others = this.graph.nodes.filter((n) => placed.has(n.id));
      let candidate: Position;
      if (pred && edgeWhen(predEdge!) === "failure") candidate = { x: pred.position.x + LAYOUT_DX, y: pred.position.y };
      else if (pred) candidate = { x: pred.position.x, y: pred.position.y + LAYOUT_DY };
      else if (succ) candidate = { x: succ.position.x, y: succ.position.y - LAYOUT_DY };
      else candidate = { x: 0, y: Math.max(...others.map((n) => n.position.y)) + LAYOUT_DY };
      while (others.some((n) => Math.abs(n.position.x - candidate.x) < LAYOUT_DX / 2 && Math.abs(n.position.y - candidate.y) < LAYOUT_DY / 2)) {
        candidate = { x: candidate.x + LAYOUT_DX, y: candidate.y };
      }
      node.position = candidate;
      placed.add(id);
    }
  }
}
