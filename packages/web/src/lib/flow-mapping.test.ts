import { describe, expect, it } from "vitest";
import { linearGraph, nodeRunOf } from "../test-fixtures";
import { toFlowEdges, toFlowNodes } from "./flow-mapping";

describe("flow mapping", () => {
  const base = { phase: 1 as const, selectedNodeIds: [], selectedEdgeIds: [], measured: {} };

  it("attaches validation issues to nodes and colours invalid edges", () => {
    const graph = linearGraph();
    const validation = {
      errors: [
        { code: "missing_config" as const, message: "Prompt is empty", nodeId: "a" },
        { code: "invalid_join" as const, message: "bad edge", edgeId: "e1" },
      ],
      warnings: [{ code: "empty_label" as const, message: "No label", nodeId: "b" }],
    };
    const nodes = toFlowNodes({ ...base, graph, validation });
    expect(nodes[0]!.data.issues.errors).toEqual(["Prompt is empty"]);
    expect(nodes[1]!.data.issues.warnings).toEqual(["No label"]);
    const [edge] = toFlowEdges({ ...base, graph, validation });
    expect(edge!.style?.stroke).toBe("#ef4444");
    expect(edge!.data?.title).toBe("bad edge");
  });

  it("uses node run status and lane in run mode", () => {
    const graph = linearGraph();
    const run = {
      currentByNode: { a: nodeRunOf({ id: "1", nodeId: "a", status: "running" }) },
      lanes: { main: { id: "main", runId: "r1", branch: "pg/g1/ab12/main", worktreePath: "/w", baseRef: "x", status: "active" as const, index: 0, pushed: false } },
    };
    const nodes = toFlowNodes({ ...base, graph, validation: { errors: [], warnings: [] }, run });
    expect(nodes[0]!.data).toMatchObject({ runMode: true, lane: { id: "main" } });
    expect(nodes[0]!.data.nodeRun?.status).toBe("running");
    expect(toFlowEdges({ ...base, graph, validation: { errors: [], warnings: [] }, run })[0]!.animated).toBe(true);
  });
});
