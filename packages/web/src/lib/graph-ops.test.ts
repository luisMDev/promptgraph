import { describe, expect, it } from "vitest";
import { graphOf, linearGraph } from "../test-fixtures";
import { connect, connectionError, createNode, defaultLabel, moveNodes, removeElements } from "./graph-ops";

describe("graph-ops", () => {
  it("creates nodes with defaults and unique labels", () => {
    const g = linearGraph();
    const n = createNode(g, "prompt", { x: 10, y: 20 });
    expect(n.type).toBe("prompt");
    expect(n.config).toMatchObject({ prompt: "", context: "fresh" });
    expect(n.label).toBe("Prompt");
    const g2 = { ...g, nodes: [...g.nodes, n] };
    expect(defaultLabel(g2, "prompt")).toBe("Prompt 2");
    expect(g.nodes.some((x) => x.id === n.id)).toBe(false);
  });

  it("refuses self loops and duplicate edges", () => {
    const g = linearGraph();
    expect(connectionError(g, { source: "a", sourcePort: "out", target: "a" })).toMatch(/itself/);
    expect(connectionError(g, { source: "a", sourcePort: "out", target: "b" })).toMatch(/already/);
    // Phase 1 has no loop edges: closing a cycle is refused while dragging; phase 2 allows marking a loop.
    expect(connectionError(g, { source: "b", sourcePort: "out", target: "a" }, 1)).toMatch(/cycle/);
    expect(connectionError(g, { source: "b", sourcePort: "out", target: "a" }, 2)).toBeNull();
    expect(connect(g, { source: "a", sourcePort: "out", target: "b" })).toBe(g);
  });

  it("connects nodes with an out → in edge", () => {
    const g = graphOf({
      nodes: [
        { id: "x", type: "shell" },
        { id: "y", type: "commit" },
      ],
    });
    const next = connect(g, { source: "x", sourcePort: "out", target: "y" });
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({ source: "x", sourcePort: "out", target: "y", targetPort: "in" });
  });

  it("removes nodes together with their edges", () => {
    const next = removeElements(linearGraph(), ["a"], []);
    expect(next.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(next.edges).toEqual([]);
  });

  it("moves only nodes whose position changed", () => {
    const g = linearGraph();
    const next = moveNodes(g, new Map([["b", { x: 320, y: 16 }]]));
    expect(next.nodes[0]).toBe(g.nodes[0]);
    expect(next.nodes[1]!.position).toEqual({ x: 320, y: 16 });
  });
});
