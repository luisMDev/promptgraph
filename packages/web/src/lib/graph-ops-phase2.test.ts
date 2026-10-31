import { validateGraph } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { linearGraph } from "../test-fixtures";
import { DEFAULT_LOOP, connect, createNode, setEdgeLoop, setEdgeWhen } from "./graph-ops";

describe("graph-ops (phase 2 edges)", () => {
  it("creates a failure edge when dragging from the error port", () => {
    const g = linearGraph();
    const next = connect({ ...g, edges: [] }, { source: "a", sourcePort: "error", target: "b" }, 2);
    expect(next.edges[0]).toMatchObject({ sourcePort: "error", when: "failure" });
    expect(next.edges[0]!.loop).toBeUndefined();
    expect(validateGraph(next, { phase: 2 }).errors).toEqual([]);
  });

  it("marks a connection that closes a cycle as a loop back-edge (phase 2 only)", () => {
    const g = linearGraph();
    const next = connect(g, { source: "b", sourcePort: "out", target: "a" }, 2);
    const back = next.edges.find((e) => e.source === "b")!;
    expect(back.loop).toEqual(DEFAULT_LOOP);
    expect(back.when).toBeUndefined();
    expect(validateGraph(next, { phase: 2 }).errors.filter((i) => i.code === "cycle")).toEqual([]);
    // Phase 1 refuses the connection altogether.
    expect(connect(g, { source: "b", sourcePort: "out", target: "a" }, 1)).toBe(g);
  });

  it("connects a shell to an exit-code condition with an `always` edge (phase 2)", () => {
    const g = linearGraph();
    const withCond = { ...g, nodes: [...g.nodes, createNode(g, "condition", { x: 600, y: 0 })] };
    const cond = withCond.nodes.at(-1)!;
    const next = connect(withCond, { source: "b", sourcePort: "out", target: cond.id }, 2);
    expect(next.edges.at(-1)).toMatchObject({ source: "b", target: cond.id, when: "always" });
    expect(validateGraph(next, { phase: 2 }).warnings.filter((i) => i.code === "condition_input")).toEqual([]);
    // Other sources keep the default condition.
    expect(connect(withCond, { source: "a", sourcePort: "out", target: cond.id }, 2).edges.at(-1)!.when).toBeUndefined();
  });

  it("stores the default condition as an absent `when`", () => {
    const e = linearGraph().edges[0]!;
    expect(setEdgeWhen(e, "always")).toMatchObject({ when: "always" });
    expect("when" in setEdgeWhen({ ...e, when: "always" }, "success")).toBe(false);
    expect(setEdgeWhen(e, "failure")).toMatchObject({ when: "failure" });
    // Error-port edges keep their explicit failure condition.
    expect(setEdgeWhen({ ...e, sourcePort: "error" }, "failure")).toMatchObject({ when: "failure" });
  });

  it("marks and unmarks loop edges", () => {
    const e = linearGraph().edges[0]!;
    const marked = setEdgeLoop(e, { maxIterations: 2, onExhausted: "continue" });
    expect(marked.loop).toEqual({ maxIterations: 2, onExhausted: "continue" });
    expect("loop" in setEdgeLoop(marked, null)).toBe(false);
  });
});
