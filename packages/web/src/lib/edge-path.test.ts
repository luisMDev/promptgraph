import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { backEdgePath, roundedPolyline } from "./edge-path";

describe("loop back-edge routing", () => {
  it("keeps a normal bezier for edges pointing forward", () => {
    expect(backEdgePath({ sourceX: 0, sourceY: 0, targetX: 300, targetY: 0, sourcePosition: Position.Right })).toBeNull();
  });

  it("routes backward edges below both nodes, label on the bottom run", () => {
    const r = backEdgePath({ sourceX: 900, sourceY: 240, targetX: 300, targetY: 40, sourcePosition: Position.Right });
    expect(r).not.toBeNull();
    const [path, labelX, labelY] = r!;
    expect(path.startsWith("M 900,240")).toBe(true);
    expect(path.endsWith("L 300,40")).toBe(true);
    expect(labelY).toBe(240 + 110);
    expect(labelX).toBe((928 + 272) / 2);
  });

  it("starts downwards from the error port", () => {
    const [path] = backEdgePath({ sourceX: 500, sourceY: 100, targetX: 600, targetY: 0, sourcePosition: Position.Bottom })!;
    expect(path).toMatch(/^M 500,100 L 500,/);
  });

  it("rounds corners without overshooting short segments", () => {
    expect(roundedPolyline([[0, 0], [10, 0], [10, 10]], 12)).toBe("M 0,0 L 5,0 Q 10,0 10,5 L 10,10");
  });
});
