import type { Graph, NodeOutcome } from "@promptgraph/shared";

/** What a delivery changed. */
export interface ActivationDelta {
  /** Nodes that became ready (≥1 activation, all forward inputs resolved), canvas order. */
  ready: string[];
  /** Nodes that received only skips (dead path, Phase 2); their outgoing edges were skipped too. */
  skipped: string[];
}

/**
 * Activation-token bookkeeping for one run (§8.1), pure and synchronous. Built from the graph snapshot;
 * loop edges are handled by the engine (Phase 2) via resetIteration().
 */
export class ActivationTracker {
  constructor(graph: Graph) {
    throw new Error("not implemented");
  }

  /** Roots (no forward inputs): ready at run start. */
  initialReady(): string[] {
    throw new Error("not implemented");
  }

  /** Node finished with `outcome`: each outgoing forward edge delivers an activation (edgeMatches) or a skip. */
  complete(nodeId: string, outcome: NodeOutcome): ActivationDelta {
    throw new Error("not implemented");
  }

  /** Node was skipped by the user (§8.3 "treat as success") — same as complete(nodeId, {kind:"success"}). */
  skipAsSuccess(nodeId: string): ActivationDelta {
    throw new Error("not implemented");
  }

  /** Edge ids that delivered an activation (UI colours them green). */
  activatedEdges(): string[] {
    throw new Error("not implemented");
  }

  /** Phase 2 loops: forget deliveries into and within `bodyNodeIds`. */
  resetIteration(bodyNodeIds: readonly string[]): void {
    throw new Error("not implemented");
  }

  /** Rebuilds state from finished node runs (crash recovery / retry after restart). */
  static restore(graph: Graph, finished: ReadonlyArray<{ nodeId: string; outcome: NodeOutcome | "skipped" }>): ActivationTracker {
    throw new Error("not implemented");
  }
}
