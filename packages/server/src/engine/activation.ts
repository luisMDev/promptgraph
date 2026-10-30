import {
  buildTopology,
  compareCanvasOrder,
  edgeMatches,
  findRoots,
  loopBody,
  topologicalOrder,
  type Graph,
  type GraphEdge,
  type LoopState,
  type NodeOutcome,
  type Topology,
} from "@promptgraph/shared";

/** A loop back-edge that activated: its body starts a new iteration. */
export interface LoopIteration {
  edgeId: string;
  /** Loop-backs of this edge so far, including this one (= LoopState.iteration). */
  iteration: number;
  /** Body nodes (target … source), canvas order: their node runs restart as `pending` (new iteration). */
  body: string[];
}

/** What a delivery changed. Apply in this order: skipped, loops, ready. */
export interface ActivationDelta {
  /** Nodes that became ready (≥1 activation, all forward inputs resolved), canvas order. */
  ready: string[];
  /** Nodes that received only skips (dead path, Phase 2); their outgoing edges were skipped too. */
  skipped: string[];
  /** Loop edges that looped back (Phase 2), in the order they fired. */
  loops: LoopIteration[];
}

type Delivery = "activation" | "skip";

interface LoopRuntime {
  edge: GraphEdge;
  max: number;
  onExhausted: "fail" | "continue";
  body: Set<string>;
  /** Loop-backs in the current pass of the enclosing loops. */
  iteration: number;
  exhausted: boolean;
  /** The source resolved without looping back: deliveries leave the body directly. */
  closed: boolean;
  /** Deliveries from body nodes to nodes outside the body, held while the loop may still repeat. */
  held: Map<string, { edge: GraphEdge; delivery: Delivery }>;
}

/**
 * Activation-token bookkeeping for one run (§8.1, §15.3, §15.4), pure and synchronous. Built from the
 * graph snapshot.
 *
 * Every node is released at most once per iteration (as ready or as dead-path skipped), so deliveries
 * reaching a node the user already skipped never make it ready again.
 *
 * Loops: while a loop may still repeat (its source has not resolved in the current pass), deliveries
 * from its body to nodes outside the body are held; only the pass that ends the loop lets them through.
 * So nodes after a loop run once, with the outputs of its last iteration, and a branch skipped in an
 * early iteration (e.g. "tests pass → commit") is not dead for good. When the loop edge activates
 * (edgeMatches on the source's outcome) and `iteration < maxIterations`, the body is reset — deliveries
 * between body nodes are forgotten, deliveries into the body from outside are kept — and the loop target
 * is released again; nested loops inside the body restart at iteration 0.
 */
export class ActivationTracker {
  private readonly topo: Topology;
  private readonly delivered = new Map<string, Delivery>();
  /** Released as ready or skipped (no further release). */
  private readonly released = new Set<string>();
  /** Completed (any outcome) or dead-path skipped: its outgoing edges have delivered. */
  private readonly resolved = new Set<string>();
  /** Innermost (smallest body) first. */
  private readonly loops: LoopRuntime[];
  private restoredLoops: LoopIteration[] = [];

  /** `loopStates`: persisted counters (crash recovery); absent edges start at iteration 0. */
  constructor(graph: Pick<Graph, "nodes" | "edges">, loopStates: readonly LoopState[] = []) {
    this.topo = buildTopology(graph);
    const saved = new Map(loopStates.map((s) => [s.edgeId, s] as const));
    this.loops = this.topo.loopEdges
      .map((edge): LoopRuntime => ({
        edge,
        max: edge.loop!.maxIterations,
        onExhausted: edge.loop!.onExhausted,
        body: loopBody(this.topo, edge),
        iteration: saved.get(edge.id)?.iteration ?? 0,
        exhausted: saved.get(edge.id)?.exhausted ?? false,
        closed: false,
        held: new Map(),
      }))
      .filter((l) => l.body.size > 0)
      .sort((a, b) => a.body.size - b.body.size);
  }

  /** Roots (no forward inputs): ready at run start. */
  initialReady(): string[] {
    const roots = findRoots(this.topo)
      .map((n) => n.id)
      .filter((id) => !this.released.has(id));
    for (const id of roots) this.released.add(id);
    return roots;
  }

  /**
   * Node finished with `outcome`: each outgoing forward edge delivers an activation (edgeMatches) or a
   * skip; then its loop edges decide whether their body repeats.
   */
  complete(nodeId: string, outcome: NodeOutcome): ActivationDelta {
    const delta: ActivationDelta = { ready: [], skipped: [], loops: [] };
    if (this.resolved.has(nodeId) || !this.topo.nodes.has(nodeId)) return delta;
    this.released.add(nodeId);
    this.resolved.add(nodeId);
    this.deliver(nodeId, (e) => (edgeMatches(e, outcome) ? "activation" : "skip"), delta);
    this.settleLoops(nodeId, outcome, delta);
    return this.finish(delta);
  }

  /** Node was skipped by the user (§8.3 "treat as success") — same as complete(nodeId, {kind:"success"}). */
  skipAsSuccess(nodeId: string): ActivationDelta {
    return this.complete(nodeId, { kind: "success" });
  }

  /**
   * The loop edge that would loop back for this outcome of `nodeId` but has reached maxIterations with
   * onExhausted "fail" (§15.4: the source then fails). Null when an inner loop repeats first, or none
   * is exhausted. Pure; the engine converts the success into a failure and calls markExhausted.
   */
  exhaustedFailLoop(nodeId: string, outcome: NodeOutcome): GraphEdge | null {
    for (const loop of this.loopsFrom(nodeId)) {
      if (!edgeMatches(loop.edge, outcome)) continue;
      if (loop.iteration < loop.max) return null;
      if (loop.onExhausted === "fail") return loop.edge;
    }
    return null;
  }

  /** Whether a loop edge of `nodeId` would loop back for this outcome (a failure it handles is not fatal). */
  loopsBack(nodeId: string, outcome: NodeOutcome): boolean {
    return this.loopsFrom(nodeId).some((l) => edgeMatches(l.edge, outcome) && l.iteration < l.max);
  }

  markExhausted(edgeId: string): void {
    const loop = this.loops.find((l) => l.edge.id === edgeId);
    if (loop) loop.exhausted = true;
  }

  /** Current counters, one per loop edge in graph edge order (persisted by the engine, shown by the UI). */
  loopStates(): LoopState[] {
    return this.topo.loopEdges.flatMap((e) => {
      const l = this.loops.find((x) => x.edge.id === e.id);
      return l ? [{ edgeId: e.id, iteration: l.iteration, maxIterations: l.max, exhausted: l.exhausted }] : [];
    });
  }

  /** Edge ids that delivered an activation (UI colours them green). */
  activatedEdges(): string[] {
    return [...this.delivered].filter(([, d]) => d === "activation").map(([id]) => id);
  }

  /** Whether the edge delivered an activation (false for skips, held and undelivered edges). */
  isActivated(edgeId: string): boolean {
    return this.delivered.get(edgeId) === "activation";
  }

  /** Whether the node's outgoing edges have delivered (completed, user-skipped or dead path). */
  isResolved(nodeId: string): boolean {
    return this.resolved.has(nodeId);
  }

  /** Nodes released as ready that have not completed yet (queued, running, failed or interrupted), canvas order. */
  readyUnresolved(): string[] {
    return this.sortIds([...this.released].filter((id) => !this.resolved.has(id)));
  }

  /**
   * Loops that looped back while restore() replayed a source that finished just before a crash (its
   * new iteration was never persisted). The engine creates their node runs. Returned once.
   */
  takeRestoredLoops(): LoopIteration[] {
    const loops = this.restoredLoops;
    this.restoredLoops = [];
    return loops;
  }

  /**
   * Rebuilds state from the current node runs (crash recovery / retry after restart), replayed in
   * topological order with the persisted loop counters. Body nodes hold their latest iteration, so the
   * replay reproduces the current pass.
   */
  static restore(
    graph: Graph,
    finished: ReadonlyArray<{ nodeId: string; outcome: NodeOutcome | "skipped" }>,
    loopStates: readonly LoopState[] = [],
  ): ActivationTracker {
    const tracker = new ActivationTracker(graph, loopStates);
    const byNode = new Map(finished.map((f) => [f.nodeId, f.outcome] as const));
    tracker.initialReady();
    const loops: LoopIteration[] = [];
    for (const node of topologicalOrder(tracker.topo).order) {
      const outcome = byNode.get(node.id);
      if (outcome === undefined || tracker.resolved.has(node.id)) continue;
      if (outcome === "skipped") {
        const delta: ActivationDelta = { ready: [], skipped: [], loops: [] };
        tracker.skipDeadPath(node.id, delta);
        loops.push(...delta.loops);
      } else {
        loops.push(...tracker.complete(node.id, outcome).loops);
      }
    }
    tracker.restoredLoops = loops;
    return tracker;
  }

  // ---------------------------------------------------------------------------

  private loopsFrom(nodeId: string): LoopRuntime[] {
    return this.loops.filter((l) => l.edge.source === nodeId);
  }

  private deliver(nodeId: string, kind: (e: GraphEdge) => Delivery, delta: ActivationDelta): void {
    for (const e of this.topo.outgoing.get(nodeId) ?? []) this.deliverEdge(e, kind(e), delta);
  }

  /** Delivers, or holds the delivery in the innermost open loop it leaves. */
  private deliverEdge(e: GraphEdge, d: Delivery, delta: ActivationDelta): void {
    const holder = this.loops.find((l) => !l.closed && l.body.has(e.source) && !l.body.has(e.target));
    if (holder) {
      holder.held.set(e.id, { edge: e, delivery: d });
      return;
    }
    this.delivered.set(e.id, d);
    this.evaluate(e.target, delta);
  }

  /**
   * After `nodeId` resolved: its loop edges, innermost first. The first one that matches and has
   * iterations left loops back; the others (and an exhausted or non-matching edge) close their loop and
   * let the held deliveries out. A loop edge never activates for a dead-path skip (outcome null).
   */
  private settleLoops(nodeId: string, outcome: NodeOutcome | null, delta: ActivationDelta): void {
    for (const loop of this.loopsFrom(nodeId)) {
      const matches = outcome !== null && edgeMatches(loop.edge, outcome);
      if (matches && loop.iteration < loop.max) {
        this.loopBack(loop, delta);
        return;
      }
      if (matches) loop.exhausted = true;
      this.closeLoop(loop, delta);
    }
  }

  private closeLoop(loop: LoopRuntime, delta: ActivationDelta): void {
    loop.closed = true;
    const held = [...loop.held];
    loop.held.clear();
    for (const [, { edge, delivery }] of held) this.deliverEdge(edge, delivery, delta);
  }

  private loopBack(loop: LoopRuntime, delta: ActivationDelta): void {
    loop.iteration++;
    loop.held.clear();
    const body = loop.body;
    for (const id of body) {
      this.released.delete(id);
      this.resolved.delete(id);
      for (const e of this.topo.incoming.get(id) ?? []) if (body.has(e.source)) this.delivered.delete(e.id);
    }
    for (const inner of this.loops) {
      if (inner === loop || ![...inner.body].every((id) => body.has(id))) continue;
      Object.assign(inner, { iteration: 0, exhausted: false, closed: false });
      inner.held.clear();
    }
    delta.loops.push({ edgeId: loop.edge.id, iteration: loop.iteration, body: this.sortIds([...body]) });
    // The loop edge's activation releases the target (its inputs from outside the body are still delivered).
    this.released.add(loop.edge.target);
    delta.ready.push(loop.edge.target);
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
    this.settleLoops(nodeId, null, delta);
  }

  /** Ready = still released and unresolved after any loop reset in the same delta; canvas order. */
  private finish(delta: ActivationDelta): ActivationDelta {
    const ready = [...new Set(delta.ready)].filter((id) => this.released.has(id) && !this.resolved.has(id));
    return { ready: this.sortIds(ready), skipped: this.sortIds(delta.skipped), loops: delta.loops };
  }

  private sortIds(ids: string[]): string[] {
    return ids.sort((a, b) => compareCanvasOrder(this.topo.nodes.get(a)!, this.topo.nodes.get(b)!));
  }
}
