import { describe, expect, it } from "vitest";
import { nodeRunOf, testFixLoopGraph } from "../test-fixtures";
import { affectsLoops, cardNote, edgeRunState, loopBadge, loopViews, nodeIterations, selectIterationEntry } from "./run-view";

describe("loops and iterations (§15.4)", () => {
  const runs = [
    nodeRunOf({ id: "t0", nodeId: "test", iteration: 0, status: "failed" }),
    nodeRunOf({ id: "t1a", nodeId: "test", iteration: 1, attempt: 0, status: "failed" }),
    nodeRunOf({ id: "t1b", nodeId: "test", iteration: 1, attempt: 1, status: "succeeded" }),
    nodeRunOf({ id: "t2", nodeId: "test", iteration: 2, status: "running" }),
    nodeRunOf({ id: "f0", nodeId: "fix", iteration: 0, status: "succeeded" }),
  ];

  it("lists one entry per iteration with its latest attempt, ascending", () => {
    const entries = nodeIterations([...runs].reverse(), "test");
    expect(entries.map((e) => [e.iteration, e.nodeRun.id, e.attempts])).toEqual([
      [0, "t0", 1],
      [1, "t1b", 2],
      [2, "t2", 1],
    ]);
    expect(nodeIterations(runs, "commit")).toEqual([]);
  });

  it("shows the latest iteration unless an existing one is selected", () => {
    const entries = nodeIterations(runs, "test");
    expect(selectIterationEntry(entries, null)!.nodeRun.id).toBe("t2");
    expect(selectIterationEntry(entries, 1)!.nodeRun.id).toBe("t1b");
    // A selection that does not exist for this node (e.g. kept from another node) falls back to the latest.
    expect(selectIterationEntry(entries, 7)!.nodeRun.id).toBe("t2");
    expect(selectIterationEntry([], null)).toBeNull();
  });

  it("prefers the server loop state and derives it from the loop target's iterations otherwise", () => {
    const graph = testFixLoopGraph();
    expect(loopViews(graph, runs)).toEqual({ loop: { iteration: 2, maxIterations: 3, exhausted: false } });
    expect(loopViews(graph, runs, [{ edgeId: "loop", iteration: 1, maxIterations: 3, exhausted: true }])).toEqual({
      loop: { iteration: 1, maxIterations: 3, exhausted: true },
    });
    expect(loopViews(graph, [])).toEqual({ loop: { iteration: 0, maxIterations: 3, exhausted: false } });
    expect(loopBadge({ iteration: 2, maxIterations: 3, exhausted: false })).toBe("2/3");
  });

  it("greys an exhausted loop edge even when its source succeeded", () => {
    const loop = testFixLoopGraph().edges.find((e) => e.id === "loop")!;
    const fix = nodeRunOf({ id: "f", nodeId: "fix", status: "succeeded" });
    expect(edgeRunState(loop, fix, { exhausted: false })).toBe("activated");
    expect(edgeRunState(loop, fix, { exhausted: true })).toBe("dead");
    expect(edgeRunState(loop, nodeRunOf({ id: "f", nodeId: "fix", status: "running" }), { exhausted: true })).toBe("flowing");
  });

  it("routes condition ports and kills the other branch", () => {
    const graph = testFixLoopGraph();
    const [t, f] = [graph.edges.find((e) => e.id === "e3")!, graph.edges.find((e) => e.id === "e4")!];
    const cond = nodeRunOf({ id: "c", nodeId: "cond", status: "succeeded", output: { port: "false", result: false, text: "exit code 1" } });
    expect(edgeRunState(t, cond)).toBe("dead");
    expect(edgeRunState(f, cond)).toBe("activated");
    // A dead-path skipped node kills all its edges.
    expect(edgeRunState(graph.edges[0]!, nodeRunOf({ id: "s", nodeId: "impl", status: "skipped" }))).toBe("dead");
  });

  it("detects updates that may change the server loop state", () => {
    const graph = testFixLoopGraph();
    // A new iteration of a node.
    expect(affectsLoops(graph, runs, nodeRunOf({ id: "f1", nodeId: "fix", iteration: 1, status: "pending" }))).toBe(true);
    // Same iteration, retry or status change of a non-loop-source node: no.
    expect(affectsLoops(graph, runs, nodeRunOf({ id: "t2", nodeId: "test", iteration: 2, status: "succeeded" }))).toBe(false);
    // The loop source settling (it may loop back or exhaust).
    const prev = [...runs, nodeRunOf({ id: "f1", nodeId: "fix", iteration: 1, status: "running" })];
    expect(affectsLoops(graph, prev, nodeRunOf({ id: "f1", nodeId: "fix", iteration: 1, status: "succeeded" }))).toBe(true);
    expect(affectsLoops(graph, prev, nodeRunOf({ id: "f1", nodeId: "fix", iteration: 1, status: "running", activity: "Edit" }))).toBe(false);
    // Graphs without loops never refetch.
    expect(affectsLoops({ edges: [] }, runs, nodeRunOf({ id: "x", nodeId: "fix", iteration: 5 }))).toBe(false);
  });

  it("puts a condition's result and reason on its card", () => {
    const cond = { type: "condition" as const };
    expect(cardNote(cond, nodeRunOf({ id: "c", nodeId: "cond", status: "running" }))).toBeNull();
    expect(cardNote(cond, nodeRunOf({ id: "c", nodeId: "cond", status: "succeeded", output: { port: "true", text: "No blocking issues" } }))).toEqual({
      text: "true — No blocking issues",
      tone: "green",
    });
    expect(cardNote(cond, nodeRunOf({ id: "c", nodeId: "cond", status: "succeeded", output: { port: "false" } }))).toEqual({ text: "Result: false", tone: "zinc" });
  });
});
