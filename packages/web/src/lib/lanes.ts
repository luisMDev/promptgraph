import { buildTopology, computeLanePlan, type Graph, type Lane, type LaneSetupState, type NodeRun, nodeDisplayLabel } from "@promptgraph/shared";

/**
 * Lane colours and lane views for the run canvas. Lane ids and indexes come from the snapshot's lane plan
 * (the same `computeLanePlan` the engine uses), so a node shows its lane colour before the lane exists.
 */

export interface LaneSwatch {
  /** Badge classes (background, text, ring). */
  badge: string;
  /** Solid colour for the card stripe and the legend dot. */
  hex: string;
}

/** Literal class names so Tailwind picks them up. Ordered for contrast between neighbours. */
const LANE_PALETTE: readonly LaneSwatch[] = [
  { badge: "bg-cyan-500/20 text-cyan-300 ring-cyan-500/40", hex: "#06b6d4" },
  { badge: "bg-fuchsia-500/20 text-fuchsia-300 ring-fuchsia-500/40", hex: "#d946ef" },
  { badge: "bg-lime-500/20 text-lime-300 ring-lime-500/40", hex: "#84cc16" },
  { badge: "bg-orange-500/20 text-orange-300 ring-orange-500/40", hex: "#f97316" },
  { badge: "bg-teal-500/20 text-teal-300 ring-teal-500/40", hex: "#14b8a6" },
  { badge: "bg-pink-500/20 text-pink-300 ring-pink-500/40", hex: "#ec4899" },
  { badge: "bg-indigo-500/20 text-indigo-300 ring-indigo-500/40", hex: "#6366f1" },
  { badge: "bg-yellow-500/20 text-yellow-300 ring-yellow-500/40", hex: "#eab308" },
];

/** Swatch of the lane with this index (Lane.index / PlannedLane.index); wraps around the palette. */
export function laneSwatch(index: number): LaneSwatch {
  const n = LANE_PALETTE.length;
  return LANE_PALETTE[((index % n) + n) % n]!;
}

/** Lane shown on a node card. */
export interface NodeLane {
  id: string;
  index: number;
}

export interface LaneLegendEntry {
  id: string;
  index: number;
  /** null until the engine created the lane (fork lanes are created when their parent node finishes). */
  lane: Lane | null;
  /** Labels of the snapshot nodes planned in the lane, in execution (topological) order. */
  nodeLabels: string[];
  /** Workspace setup state of the lane's first node run, if setup ran. */
  setup: LaneSetupState | null;
}

/** Lane of each node (plan) with its index, overridden by the lanes the engine actually created. */
export function nodeLanes(graph: Graph, lanes: Readonly<Record<string, Lane>>, currentByNode: Readonly<Record<string, NodeRun>>): Map<string, NodeLane> {
  const plan = computeLanePlan(graph);
  const planIndex = new Map(plan.lanes.map((l) => [l.id, l.index] as const));
  const out = new Map<string, NodeLane>();
  for (const node of graph.nodes) {
    const id = currentByNode[node.id]?.laneId ?? plan.laneOf.get(node.id);
    if (!id) continue;
    const index = lanes[id]?.index ?? planIndex.get(id);
    if (index !== undefined) out.set(node.id, { id, index });
  }
  return out;
}

/** Legend of the run panel: every planned lane (plus unplanned created ones), in index order. */
export function laneLegend(graph: Graph, lanes: Readonly<Record<string, Lane>>, currentByNode: Readonly<Record<string, NodeRun>>): LaneLegendEntry[] {
  const plan = computeLanePlan(graph);
  const label = new Map(graph.nodes.map((n) => [n.id, nodeDisplayLabel(n)] as const));
  const entries = new Map<string, LaneLegendEntry>();
  for (const p of plan.lanes) {
    const first = currentByNode[p.firstNodeId];
    entries.set(p.id, { id: p.id, index: p.index, lane: lanes[p.id] ?? null, nodeLabels: [], setup: first?.laneSetup ?? null });
  }
  for (const lane of Object.values(lanes)) {
    if (!entries.has(lane.id)) entries.set(lane.id, { id: lane.id, index: lane.index, lane, nodeLabels: [], setup: null });
  }
  for (const [nodeId, laneId] of plan.laneOf) entries.get(laneId)?.nodeLabels.push(label.get(nodeId) ?? nodeId);
  return [...entries.values()].sort((a, b) => a.index - b.index);
}

/** Inputs of a merge node in merge order: the first keeps its lane, the others are merged into it one by one (§18 Q4). */
export function mergeInputLabels(graph: Pick<Graph, "nodes" | "edges">, mergeNodeId: string): string[] {
  const topo = buildTopology(graph);
  return (topo.incoming.get(mergeNodeId) ?? []).map((e) => {
    const n = topo.nodes.get(e.source);
    return n ? nodeDisplayLabel(n) : e.source;
  });
}
