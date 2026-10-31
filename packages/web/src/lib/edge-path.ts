import { Position } from "@xyflow/react";

/** Geometry of an edge's endpoints (subset of React Flow's EdgeProps). */
export interface EdgeEnds {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
}

/** Horizontal run-out from the handles before turning. */
const STUB = 28;
/** How far below the lower endpoint the back-edge runs (node cards are ~60–90 px below their handle). */
const DROP = 110;
const RADIUS = 12;

/**
 * Path of a loop back-edge that points backwards (target left of the source): out of the source, down below
 * both nodes, back to the left and up into the target's input — so it reads as a back-edge instead of a
 * bezier crossing the nodes. Returns null when the target is ahead of the source (a normal bezier is fine).
 * Result: [svgPath, labelX, labelY] (label at the middle of the bottom run).
 */
export function backEdgePath(e: EdgeEnds): [string, number, number] | null {
  const fromBottom = e.sourcePosition === Position.Bottom;
  if (!fromBottom && e.targetX > e.sourceX + STUB * 2) return null;
  const startX = e.sourceX;
  const startY = e.sourceY;
  const right = fromBottom ? startX : startX + STUB;
  const left = e.targetX - STUB;
  const bottom = Math.max(startY, e.targetY) + DROP;
  const points: [number, number][] = fromBottom
    ? [
        [startX, startY],
        [startX, bottom],
        [left, bottom],
        [left, e.targetY],
        [e.targetX, e.targetY],
      ]
    : [
        [startX, startY],
        [right, startY],
        [right, bottom],
        [left, bottom],
        [left, e.targetY],
        [e.targetX, e.targetY],
      ];
  return [roundedPolyline(points, RADIUS), (right + left) / 2, bottom];
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
