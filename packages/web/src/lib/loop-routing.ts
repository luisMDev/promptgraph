import type { Graph } from "@promptgraph/shared";

/** Where a loop back-edge runs (consumed by `backEdgePath`). */
export interface LoopRoute {
  /** Flow x of the vertical run beside the nodes. */
  x: number;
  /** Extra distance of the horizontal runs from the handles, so stacked loops do not share them. */
  lift: number;
}

type Size = { width: number; height: number };

/** Card size before React Flow has measured it (cards are w-60). */
const DEFAULT_SIZE: Size = { width: 240, height: 80 };
/** Gap between the vertical run and the outermost card it passes. */
const CLEARANCE = 40;
/** Gap between the vertical runs of loops that overlap vertically. */
export const LOOP_TRACK = 20;
/** Extra lift of the horizontal runs per track a loop is pushed out. */
export const LOOP_LIFT = 8;
/** Mirrors backEdgePath: a target this far below the source's output is a forward edge (plain bezier). */
const FORWARD_GAP = 56;

interface Pending {
  id: string;
  side: -1 | 1;
  base: number;
  top: number;
  bottom: number;
}

/**
 * Routes for the loop back-edges that point backwards (target above the source) and leave from the output
 * port. Each runs beside every card in its vertical span, on the side with the shorter detour (left on a tie,
 * as error branches sit on the right). Loops whose spans overlap on the same side get separate tracks: shorter
 * loops are placed first and stay inside, longer ones move out by LOOP_TRACK and lift their horizontal runs.
 * Pure.
 */
export function loopRoutes(graph: Pick<Graph, "nodes" | "edges">, measured: Readonly<Record<string, Size>>): Map<string, LoopRoute> {
  const size = (id: string) => measured[id] ?? DEFAULT_SIZE;
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const pending: Pending[] = [];
  for (const edge of graph.edges) {
    if (!edge.loop || edge.sourcePort === "error") continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const top = target.position.y;
    const bottom = source.position.y + size(source.id).height;
    if (top > bottom + FORWARD_GAP) continue;
    const spanned = graph.nodes.filter((n) => n.position.y < bottom && n.position.y + size(n.id).height > top);
    const left = Math.min(...spanned.map((n) => n.position.x)) - CLEARANCE;
    const right = Math.max(...spanned.map((n) => n.position.x + size(n.id).width)) + CLEARANCE;
    const sx = source.position.x + size(source.id).width / 2;
    const tx = target.position.x + size(target.id).width / 2;
    const detourLeft = sx - left + (tx - left);
    const detourRight = right - sx + (right - tx);
    const side = detourRight < detourLeft ? 1 : -1;
    pending.push({ id: edge.id, side, base: side < 0 ? left : right, top, bottom });
  }

  pending.sort((a, b) => a.bottom - a.top - (b.bottom - b.top) || a.id.localeCompare(b.id));
  const placed: (Pending & { x: number })[] = [];
  const routes = new Map<string, LoopRoute>();
  for (const loop of pending) {
    const neighbours = placed.filter((p) => p.side === loop.side && p.top < loop.bottom && p.bottom > loop.top);
    let x = loop.base;
    let tracks = 0;
    while (neighbours.some((p) => Math.abs(p.x - x) < LOOP_TRACK)) {
      x += loop.side * LOOP_TRACK;
      tracks++;
    }
    placed.push({ ...loop, x });
    routes.set(loop.id, { x, lift: tracks * LOOP_LIFT });
  }
  return routes;
}
