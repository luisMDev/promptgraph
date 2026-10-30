import { describe, expect, it } from "vitest";
import { forkMergeGraph, linearGraph, nodeRunOf, testFixLoopGraph } from "../test-fixtures";
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
    expect(nodes[0]!.data).toMatchObject({ runMode: true, lane: { id: "main", index: 0 } });
    expect(nodes[0]!.data.nodeRun?.status).toBe("running");
    expect(toFlowEdges({ ...base, graph, validation: { errors: [], warnings: [] }, run })[0]!.animated).toBe(true);
  });

  it("shows planned lanes in run mode and the merge order on merge nodes", () => {
    const graph = forkMergeGraph();
    const validation = { errors: [], warnings: [] };
    const run = { currentByNode: {}, lanes: {} };
    const byId = Object.fromEntries(toFlowNodes({ ...base, graph, validation, run }).map((n) => [n.id, n.data]));
    expect(byId.c!.lane).toEqual({ id: "l2", index: 1 });
    expect(byId.m!.mergeInputs).toEqual(["Backend", "Frontend"]);
    expect(byId.a!.mergeInputs).toEqual([]);
    // Edit mode: merge order shown, no lanes.
    const edit = toFlowNodes({ ...base, graph, validation });
    expect(edit.find((n) => n.id === "m")!.data).toMatchObject({ lane: null, mergeInputs: ["Backend", "Frontend"] });
  });
});

describe("flow mapping (phase 2)", () => {
  const base = { phase: 2 as const, selectedNodeIds: [], selectedEdgeIds: [], measured: {} };
  const noIssues = { errors: [], warnings: [] };

  it("draws loop and failure edges dashed, with labels in edit mode and an iteration badge in run mode", () => {
    const graph = testFixLoopGraph();
    graph.edges.push({ id: "err", source: "impl", sourcePort: "error", target: "fix", targetPort: "in", when: "failure" });
    const edit = Object.fromEntries(toFlowEdges({ ...base, graph, validation: noIssues }).map((e) => [e.id, e]));
    expect(edit.loop!.style?.strokeDasharray).toBe("8 5");
    expect(edit.loop!.data).toMatchObject({ loop: true, label: "loop ≤3", badge: undefined });
    expect(edit.err!.style).toMatchObject({ stroke: "#ef4444", strokeDasharray: "4 3" });
    expect(edit.err!.data?.label).toBeUndefined();
    expect(edit.e1!.style?.strokeDasharray).toBeUndefined();

    const run = {
      currentByNode: {
        fix: nodeRunOf({ id: "f", nodeId: "fix", iteration: 1, status: "succeeded" }),
        cond: nodeRunOf({ id: "c", nodeId: "cond", iteration: 1, status: "succeeded", output: { port: "false" } }),
      },
      lanes: {},
      loops: { loop: { iteration: 2, maxIterations: 3, exhausted: false } },
    };
    const live = Object.fromEntries(toFlowEdges({ ...base, graph, validation: noIssues, run }).map((e) => [e.id, e]));
    expect(live.loop!.data).toMatchObject({ badge: "2/3", runState: "activated", label: undefined });
    expect(live.loop!.style?.strokeDasharray).toBe("8 5");
    expect(live.e3!.data?.runState).toBe("dead");
    expect(live.e3!.style?.opacity).toBe(0.5);
    expect(live.e4!.data?.runState).toBe("activated");
  });

  it("labels non-default conditions and lists edge warnings in the tooltip", () => {
    const graph = linearGraph();
    graph.edges[0] = { ...graph.edges[0]!, when: "always" };
    const validation = { errors: [], warnings: [{ code: "empty_label" as const, message: "Check me", edgeId: "e1" }] };
    const [edge] = toFlowEdges({ ...base, graph, validation });
    expect(edge!.data).toMatchObject({ label: "always", title: "Check me" });
    expect(edge!.style?.stroke).toBe("#f59e0b");
  });
});
