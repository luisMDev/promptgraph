import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { backEdgePath, roundedPolyline } from "./edge-path";

describe("loop back-edge routing", () => {
  it("keeps a normal bezier for edges pointing forward", () => {
    expect(backEdgePath({ sourceX: 0, sourceY: 0, targetX: 0, targetY: 200, sourcePosition: Position.Bottom })).toBeNull();
  });

  it("routes aligned backward edges around the left of both nodes, label on the side run", () => {
    const r = backEdgePath({ sourceX: 0, sourceY: 640, targetX: 0, targetY: 200, sourcePosition: Position.Bottom });
    expect(r).not.toBeNull();
    const [path, labelX, labelY] = r!;
    expect(path.startsWith("M 0,640 L 0,")).toBe(true);
    expect(path.endsWith("L 0,200")).toBe(true);
    expect(labelX).toBe(-160);
    expect(labelY).toBe((668 + 172) / 2);
  });

  it("goes around the right when the source sits right of the target", () => {
    const [, labelX] = backEdgePath({ sourceX: 300, sourceY: 640, targetX: 0, targetY: 200, sourcePosition: Position.Bottom })!;
    expect(labelX).toBe(460);
  });

  it("goes up on the right from the error port", () => {
    const [path, labelX] = backEdgePath({ sourceX: 500, sourceY: 300, targetX: 380, targetY: 0, sourcePosition: Position.Right })!;
    expect(path).toMatch(/^M 500,300 L /);
    expect(labelX).toBe(528);
  });

  it("rounds corners without overshooting short segments", () => {
    expect(roundedPolyline([[0, 0], [10, 0], [10, 10]], 12)).toBe("M 0,0 L 5,0 Q 10,0 10,5 L 10,10");
  });
});
