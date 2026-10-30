import {
  buildTopology,
  compareCanvasOrder,
  edgeMatches,
  findRoots,
  topologicalOrder,
  type Graph,
  type GraphEdge,
  type NodeOutcome,
  type Topology,
} from "@promptgraph/shared";

/** What a delivery changed. */
export interface ActivationDelta {
  /** Nodes that became ready (≥1 activation, all forward inputs resolved), canvas order. */
  ready: string[];
  /** Nodes that received only skips (dead path, Phase 2); their outgoing edges were skipped too. */
  skipped: string[];
}

type Delivery = "activation" | "skip";

/**
 * Activation-token bookkeeping for one run (§8.1), pure and synchronous. Built from the graph snapshot;
 * loop edges are handled by the engine (Phase 2) via resetIteration().
 *
 * Every node is released at most once per iteration (as ready or as dead-path skipped), so deliveries
 * reaching a node the user already skipped never make it ready again.
 */
export class ActivationTracker {
  private readonly topo: Topology;
  private readonly delivered = new Map<string, Delivery>();
  /** Released as ready or skipped (no further release). */
  private readonly released = new Set<string>();
  /** Completed (any outcome) or dead-path skipped: its outgoing edges have delivered. */
  private readonly resolved = new Set<string>();

  constructor(graph: Pick<Graph, "nodes" | "edges">) {
    this.topo = buildTopology(graph);
  }

  /** Roots (no forward inputs): ready at run start. */
  initialReady(): string[] {
    const roots = findRoots(this.topo)
      .map((n) => n.id)
      .filter((id) => !this.released.has(id));
    for (const id of roots) this.released.add(id);
    return roots;
  }

  /** Node finished with `outcome`: each outgoing forward edge delivers an activation (edgeMatches) or a skip. */
  complete(nodeId: string, outcome: NodeOutcome): ActivationDelta {
    const delta: ActivationDelta = { ready: [], skipped: [] };
    if (this.resolved.has(nodeId) || !this.topo.nodes.has(nodeId)) return delta;
    this.released.add(nodeId);
    this.resolved.add(nodeId);
    this.deliver(nodeId, (e) => (edgeMatches(e, outcome) ? "activation" : "skip"), delta);
    return this.sorted(delta);
  }

  /** Node was skipped by the user (§8.3 "treat as success") — same as complete(nodeId, {kind:"success"}). */
  skipAsSuccess(nodeId: string): ActivationDelta {
    return this.complete(nodeId, { kind: "success" });
  }

  /** Edge ids that delivered an activation (UI colours them green). */
  activatedEdges(): string[] {
    return [...this.delivered].filter(([, d]) => d === "activation").map(([id]) => id);
  }

  /** Whether the node's outgoing edges have delivered (completed, user-skipped or dead path). */
  isResolved(nodeId: string): boolean {
    return this.resolved.has(nodeId);
  }

  /** Nodes released as ready that have not completed yet (queued, running, failed or interrupted), canvas order. */
  readyUnresolved(): string[] {
    return this.sortIds([...this.released].filter((id) => !this.resolved.has(id)));
  }

  /** Phase 2 loops: forget deliveries into and within `bodyNodeIds`. */
  resetIteration(bodyNodeIds: readonly string[]): void {
    const body = new Set(bodyNodeIds);
    for (const id of body) {
      this.released.delete(id);
      this.resolved.delete(id);
      for (const e of this.topo.incoming.get(id) ?? []) this.delivered.delete(e.id);
    }
  }

  /** Rebuilds state from finished node runs (crash recovery / retry after restart). */
  static restore(graph: Graph, finished: ReadonlyArray<{ nodeId: string; outcome: NodeOutcome | "skipped" }>): ActivationTracker {
    const tracker = new ActivationTracker(graph);
    const byNode = new Map(finished.map((f) => [f.nodeId, f.outcome] as const));
    tracker.initialReady();
    for (const node of topologicalOrder(tracker.topo).order) {
      const outcome = byNode.get(node.id);
      if (outcome === undefined || tracker.resolved.has(node.id)) continue;
      if (outcome === "skipped") tracker.skipDeadPath(node.id, { ready: [], skipped: [] });
      else tracker.complete(node.id, outcome);
    }
    return tracker;
  }

  private deliver(nodeId: string, kind: (e: GraphEdge) => Delivery, delta: ActivationDelta): void {
    for (const e of this.topo.outgoing.get(nodeId) ?? []) {
      this.delivered.set(e.id, kind(e));
      this.evaluate(e.target, delta);
    }
  }

  private evaluate(nodeId: string, delta: ActivationDelta): void {
    if (this.released.has(nodeId)) return;
    const inputs = this.topo.incoming.get(nodeId) ?? [];
    const deliveries = inputs.map((e) => this.delivered.get(e.id));
    if (deliveries.some((d) => d === undefined)) return;
    if (deliveries.includes("activation")) {
      this.released.add(nodeId);
      delta.ready.push(nodeId);
    } else {
      this.skipDeadPath(nodeId, delta);
    }
  }

  private skipDeadPath(nodeId: string, delta: ActivationDelta): void {
    this.released.add(nodeId);
    this.resolved.add(nodeId);
    delta.skipped.push(nodeId);
    this.deliver(nodeId, () => "skip", delta);
  }

  private sorted(delta: ActivationDelta): ActivationDelta {
    return { ready: this.sortIds(delta.ready), skipped: this.sortIds(delta.skipped) };
  }

  private sortIds(ids: string[]): string[] {
    return ids.sort((a, b) => compareCanvasOrder(this.topo.nodes.get(a)!, this.topo.nodes.get(b)!));
  }
}
