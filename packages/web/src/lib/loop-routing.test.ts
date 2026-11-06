import { GraphSchema, type Graph } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { LOOP_LIFT, LOOP_TRACK, loopRoutes } from "./loop-routing";

type N = { id: string; x: number; y: number };
type E = { source: string; target: string; loop?: boolean; sourcePort?: string };

function g(nodes: N[], edges: E[]): Graph {
  return GraphSchema.parse({
    version: 1,
    id: "t",
    name: "T",
    nodes: nodes.map((n) => ({ id: n.id, type: "shell", label: n.id, position: { x: n.x, y: n.y }, config: { run: "true" } })),
    edges: edges.map(({ loop, ...e }) => ({ id: `e-${e.source}-${e.target}`, ...e, ...(loop ? { loop: { maxIterations: 2 } } : {}) })),
  });
}

describe("loopRoutes", () => {
  it("runs a loop beside every card in its span, on the shorter side", () => {
    const graph = g(
      [{ id: "a", x: 0, y: 0 }, { id: "b", x: -300, y: 200 }, { id: "c", x: 0, y: 400 }],
      [{ source: "a", target: "c" }, { source: "c", target: "a", loop: true }],
    );
    // b (x -300) is in the span: going left would detour around it, so the loop goes right.
    expect(loopRoutes(graph, {}).get("e-c-a")).toEqual({ x: 240 + 40, lift: 0 });
  });

  it("gives overlapping loops their own track, the shorter one inside", () => {
    const graph = g(
      [
        { id: "test", x: 0, y: 0 },
        { id: "fix", x: 0, y: 200 },
        { id: "review", x: 0, y: 400 },
        { id: "apply", x: 0, y: 600 },
      ],
      [
        { source: "fix", target: "test", loop: true },
        { source: "apply", target: "fix", loop: true },
        { source: "apply", target: "test", loop: true },
      ],
    );
    const routes = loopRoutes(graph, {});
    const short1 = routes.get("e-fix-test")!;
    const short2 = routes.get("e-apply-fix")!;
    const long = routes.get("e-apply-test")!;
    // Both short loops overlap only at fix (the shared row), so they are pushed apart.
    expect(Math.abs(short1.x - short2.x)).toBeGreaterThanOrEqual(LOOP_TRACK);
    expect(long.x).toBeLessThan(Math.min(short1.x, short2.x));
    expect(long.lift).toBeGreaterThanOrEqual(LOOP_LIFT);
  });

  it("ignores forward loops and loops from the error port", () => {
    const graph = g(
      [{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 400 }],
      [{ source: "a", target: "b", loop: true }, { source: "b", target: "a", loop: true, sourcePort: "error" }],
    );
    expect(loopRoutes(graph, {}).size).toBe(0);
  });
});
