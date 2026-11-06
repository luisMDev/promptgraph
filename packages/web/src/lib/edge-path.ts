import { Position } from "@xyflow/react";
import type { LoopRoute } from "./loop-routing";

/** Geometry of an edge's endpoints (subset of React Flow's EdgeProps). */
export interface EdgeEnds {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
}

/** Run-out from the handles before turning. */
const STUB = 28;
/** How far beside the outermost endpoint the back-edge runs (cards are 240 px wide, centred on their handles). */
const SIDE = 160;
const RADIUS = 12;

/**
 * Path of a loop back-edge that points backwards (target above the source): out of the source, around the
 * side of both nodes (the side the source leans to; left when they are aligned), up and into the target's
 * input from above — so it reads as a back-edge instead of
 * a bezier crossing the nodes. From the error port (right edge) it goes up on the right instead, beside the
 * error branches. `route` (from `loopRoutes`) overrides the side run's x and staggers the horizontal runs so
 * loops never share a segment. Returns null when the target is below the source (a normal bezier is fine).
 * Result: [svgPath, labelX, labelY] (label at the middle of the vertical run).
 */
export function backEdgePath(e: EdgeEnds, route?: LoopRoute): [string, number, number] | null {
  if (e.targetY > e.sourceY + STUB * 2) return null;
  const startX = e.sourceX;
  const startY = e.sourceY;
  const lift = route?.lift ?? 0;
  const above = e.targetY - STUB - lift;
  if (e.sourcePosition === Position.Right) {
    const right = startX + STUB;
    const points: [number, number][] = [
      [startX, startY],
      [right, startY],
      [right, above],
      [e.targetX, above],
      [e.targetX, e.targetY],
    ];
    return [roundedPolyline(points, RADIUS), right, (startY + above) / 2];
  }
  const below = startY + STUB + lift;
  // Without a route: around the side the source leans to, so the run stays clear of the siblings on the other side.
  const side = route?.x ?? (startX > e.targetX ? Math.max(startX, e.targetX) + SIDE : Math.min(startX, e.targetX) - SIDE);
  const points: [number, number][] = [
    [startX, startY],
    [startX, below],
    [side, below],
    [side, above],
    [e.targetX, above],
    [e.targetX, e.targetY],
  ];
  return [roundedPolyline(points, RADIUS), side, (below + above) / 2];
}

/** Orthogonal polyline with rounded corners (quadratic curves at each inner point). */
export function roundedPolyline(points: readonly [number, number][], radius: number): string {
  if (points.length === 0) return "";
  const [x0, y0] = points[0]!;
  let d = `M ${x0},${y0}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const r = Math.min(radius, dist(px, py, cx, cy) / 2, dist(cx, cy, nx, ny) / 2);
    const [ax, ay] = toward(cx, cy, px, py, r);
    const [bx, by] = toward(cx, cy, nx, ny, r);
    d += ` L ${ax},${ay} Q ${cx},${cy} ${bx},${by}`;
  }
  const [lx, ly] = points[points.length - 1]!;
  return `${d} L ${lx},${ly}`;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

function toward(fromX: number, fromY: number, toX: number, toY: number, r: number): [number, number] {
  const len = dist(fromX, fromY, toX, toY);
  if (len === 0) return [fromX, fromY];
  return [fromX + ((toX - fromX) / len) * r, fromY + ((toY - fromY) / len) * r];
}
