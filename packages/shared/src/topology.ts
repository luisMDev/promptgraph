import {
  compareCanvasOrder,
  edgeWhen,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "./graph.js";

/**
 * Pure graph topology helpers shared by validator, engine and UI. Loop back-edges (`edge.loop`) are
 * excluded from every "forward" structure here: the forward graph must be a DAG.
 */
export interface Topology {
  nodes: ReadonlyMap<string, GraphNode>;
  /** Forward (non-loop) edges whose endpoints exist, by target / source, sorted by canvas order of the other end. */
  incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  loopEdges: readonly GraphEdge[];
}

export function buildTopology(graph: Pick<Graph, "nodes" | "edges">): Topology {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const incoming = new Map<string, GraphEdge[]>(graph.nodes.map((n) => [n.id, []]));
  const outgoing = new Map<string, GraphEdge[]>(graph.nodes.map((n) => [n.id, []]));
  const loopEdges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    if (e.loop) {
      loopEdges.push(e);
      continue;
    }
    outgoing.get(e.source)!.push(e);
    incoming.get(e.target)!.push(e);
  }
  const byNode = (id: string) => nodes.get(id)!;
  for (const list of incoming.values()) list.sort((a, b) => compareCanvasOrder(byNode(a.source), byNode(b.source)));
  for (const list of outgoing.values()) list.sort((a, b) => compareCanvasOrder(byNode(a.target), byNode(b.target)));
  return { nodes, incoming, outgoing, loopEdges };
}

/** Nodes without incoming forward edges, in canvas order. */
export function findRoots(topo: Topology): GraphNode[] {
  return [...topo.nodes.values()].filter((n) => topo.incoming.get(n.id)!.length === 0).sort(compareCanvasOrder);
}

/**
 * Kahn topological order over forward edges (ties broken by canvas order).
 * `cyclic` lists the nodes that could not be ordered (they are on or behind a cycle).
 */
export function topologicalOrder(topo: Topology): { order: GraphNode[]; cyclic: string[] } {
  const indeg = new Map([...topo.nodes.keys()].map((id) => [id, topo.incoming.get(id)!.length]));
  const ready = findRoots(topo);
  const order: GraphNode[] = [];
  while (ready.length > 0) {
    ready.sort(compareCanvasOrder);
    const n = ready.shift()!;
    order.push(n);
    for (const e of topo.outgoing.get(n.id)!) {
      const d = indeg.get(e.target)! - 1;
      indeg.set(e.target, d);
      if (d === 0) ready.push(topo.nodes.get(e.target)!);
    }
  }
  const done = new Set(order.map((n) => n.id));
  return { order, cyclic: [...topo.nodes.keys()].filter((id) => !done.has(id)) };
}

/** Finds one cycle (node ids in order) among forward edges, or null. */
export function findCycle(topo: Topology): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const e of topo.outgoing.get(id)!) {
      const s = state.get(e.target);
      if (s === 1) return stack.slice(stack.indexOf(e.target));
      if (s === undefined) {
        const c = visit(e.target);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of topo.nodes.keys()) {
    if (!state.has(id)) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

/** All nodes reachable from `start` via forward edges (excluding start unless on a cycle). */
export function descendants(topo: Topology, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = topo.outgoing.get(start)?.map((e) => e.target) ?? [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of topo.outgoing.get(id) ?? []) stack.push(e.target);
  }
  return seen;
}

export function ancestors(topo: Topology, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = topo.incoming.get(start)?.map((e) => e.source) ?? [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of topo.incoming.get(id) ?? []) stack.push(e.source);
  }
  return seen;
}

/**
 * Branch key of an edge: outgoing edges of one node with different keys are mutually exclusive
 * (only one key fires per outcome) and therefore never fan out into separate lanes (§15.3).
 * "always" edges share the key of the success side.
 */
export function branchKey(edge: GraphEdge): "out" | "true" | "false" | "error" {
  if (edgeWhen(edge) === "failure") return "error";
  if (edge.sourcePort === "true" || edge.sourcePort === "false") return edge.sourcePort;
  return "out";
}

/** Nodes downstream of `nodeId` reached only through edges with the given branch key. */
function branchReach(topo: Topology, nodeId: string, key: string): Set<string> {
  const seen = new Set<string>();
  for (const e of topo.outgoing.get(nodeId) ?? []) {
    if (branchKey(e) !== key) continue;
    seen.add(e.target);
    for (const d of descendants(topo, e.target)) seen.add(d);
  }
  return seen;
}

const EXCLUSIVE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["true", "false"],
  ["out", "error"],
  ["true", "error"],
  ["false", "error"],
];

/**
 * Phase 2: whether two incoming edges of a join come from mutually exclusive branches of one
 * upstream node (e.g. the true/false ports of a condition, or success/failure of any node).
 */
export function edgesMutuallyExclusive(topo: Topology, a: GraphEdge, b: GraphEdge): boolean {
  const candidates = new Set([a.source, b.source, ...ancestors(topo, a.source), ...ancestors(topo, b.source)]);
  const side = (e: GraphEdge, split: string, key: string, reach: Set<string>) =>
    (e.source === split && branchKey(e) === key) || (e.source !== split && reach.has(e.source));
  for (const split of candidates) {
    for (const [k1, k2] of EXCLUSIVE_KEYS) {
      const r1 = branchReach(topo, split, k1);
      const r2 = branchReach(topo, split, k2);
      const aOnly1 = side(a, split, k1, r1) && !side(a, split, k2, r2);
      const aOnly2 = side(a, split, k2, r2) && !side(a, split, k1, r1);
      const bOnly1 = side(b, split, k1, r1) && !side(b, split, k2, r2);
      const bOnly2 = side(b, split, k2, r2) && !side(b, split, k1, r1);
      if ((aOnly1 && bOnly2) || (aOnly2 && bOnly1)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lane plan (§9.2), computed on the snapshot at run start
// ---------------------------------------------------------------------------

export interface PlannedLane {
  /** "main" for the first root's lane, then "l2", "l3", … in creation order. */
  id: string;
  index: number;
  /** null: branched from settings.baseBranch. Otherwise the parent lane, forked after `forkAfter` (checkpoint). */
  parentLaneId: string | null;
  forkAfterNodeId: string | null;
  /** First node executed in the lane (gets the workspace-setup badge). */
  firstNodeId: string;
}

export interface LanePlan {
  lanes: PlannedLane[];
  /** Lane of every node that can be ordered (nodes on cycles are absent). */
  laneOf: Map<string, string>;
  /** For merge nodes: lanes merged into the merge's own lane, in canvas order of the inputs. */
  mergeSources: Map<string, string[]>;
}

/**
 * Lane rules:
 * 1. each root starts a new lane from baseBranch (root lanes are numbered first, in canvas order);
 * 2. single successor stays in the lane;
 * 3. fan-out: per branch key, the first target by canvas order keeps the lane, others fork new lanes;
 *    different branch keys are exclusive and all keep the lane;
 * 4. merge continues the lane of its first input (canvas order) and merges the others.
 * Non-merge joins (Phase 2 exclusive joins) take the lane of their first input.
 */
export function computeLanePlan(graph: Pick<Graph, "nodes" | "edges">): LanePlan {
  const topo = buildTopology(graph);
  const { order } = topologicalOrder(topo);
  const lanes: PlannedLane[] = [];
  const laneOf = new Map<string, string>();
  const mergeSources = new Map<string, string[]>();
  /** Lane granted to a target by a specific edge. */
  const laneByEdge = new Map<string, string>();

  const newLane = (firstNodeId: string, parentLaneId: string | null, forkAfterNodeId: string | null): string => {
    const id = lanes.length === 0 ? "main" : `l${lanes.length + 1}`;
    lanes.push({ id, index: lanes.length, parentLaneId, forkAfterNodeId, firstNodeId });
    return id;
  };

  // Root lanes first so their ids do not depend on traversal order.
  const rootLane = new Map(findRoots(topo).map((r) => [r.id, newLane(r.id, null, null)] as const));

  for (const node of order) {
    const inputs = topo.incoming.get(node.id)!;
    let lane: string;
    if (inputs.length === 0) {
      lane = rootLane.get(node.id)!;
    } else {
      const inputLanes = inputs.map((e) => laneByEdge.get(e.id)!);
      lane = inputLanes[0]!;
      if (node.type === "merge") {
        mergeSources.set(
          node.id,
          [...new Set(inputLanes.slice(1))].filter((l) => l !== lane),
        );
      }
    }
    laneOf.set(node.id, lane);

    const groups = new Map<string, GraphEdge[]>();
    for (const e of topo.outgoing.get(node.id)!) {
      const k = branchKey(e);
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const edges of groups.values()) {
      // Edges are already in canvas order of their targets; first keeps the lane.
      const seenTargets = new Map<string, string>();
      edges.forEach((e, i) => {
        const existing = seenTargets.get(e.target);
        const granted = existing ?? (i === 0 ? lane : newLane(e.target, lane, node.id));
        seenTargets.set(e.target, granted);
        laneByEdge.set(e.id, granted);
      });
    }
  }
  return { lanes, laneOf, mergeSources };
}
