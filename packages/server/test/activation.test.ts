import { describe, expect, it } from "vitest";
import { GraphSchema, type GraphInput } from "@promptgraph/shared";
import { ActivationTracker } from "../src/engine/activation.js";

/** Nodes laid out left to right in the given order (canvas order = argument order). */
function graph(nodeIds: string[], edges: GraphInput["edges"]) {
  return GraphSchema.parse({
    version: 1,
    id: "g",
    name: "G",
    nodes: nodeIds.map((id, i) => ({ id, type: id.startsWith("m") ? "merge" : "prompt", position: { x: i * 100, y: 0 } })),
    edges,
  });
}
const e = (source: string, target: string, extra: Record<string, unknown> = {}) => ({ id: `${source}-${target}`, source, target, ...extra });

describe("ActivationTracker", () => {
  it("linear chain: each completion readies the next node", () => {
    const t = new ActivationTracker(graph(["a", "b", "c"], [e("a", "b"), e("b", "c")]));
    expect(t.initialReady()).toEqual(["a"]);
    expect(t.initialReady()).toEqual([]); // released once
    expect(t.complete("a", { kind: "success" })).toEqual({ ready: ["b"], skipped: [] });
    expect(t.complete("b", { kind: "success" })).toEqual({ ready: ["c"], skipped: [] });
    expect(t.complete("c", { kind: "success" })).toEqual({ ready: [], skipped: [] });
    expect(t.activatedEdges().sort()).toEqual(["a-b", "b-c"]);
  });

  it("several roots start together; a join waits for every input", () => {
    const t = new ActivationTracker(graph(["a", "b", "m"], [e("a", "m"), e("b", "m")]));
    expect(t.initialReady()).toEqual(["a", "b"]);
    expect(t.complete("b", { kind: "success" }).ready).toEqual([]);
    expect(t.complete("a", { kind: "success" }).ready).toEqual(["m"]);
  });

  it("fan-out readies successors in canvas order", () => {
    const g = graph(["a", "c", "b"], [e("a", "b"), e("a", "c")]);
    const t = new ActivationTracker(g);
    t.initialReady();
    expect(t.complete("a", { kind: "success" }).ready).toEqual(["c", "b"]);
  });

  it("completing twice is a no-op", () => {
    const t = new ActivationTracker(graph(["a", "b"], [e("a", "b")]));
    t.initialReady();
    t.complete("a", { kind: "success" });
    expect(t.complete("a", { kind: "success" })).toEqual({ ready: [], skipped: [] });
  });

  it("skipAsSuccess resolves a node so later deliveries never ready it again", () => {
    const t = new ActivationTracker(graph(["a", "b", "c"], [e("a", "b"), e("b", "c")]));
    t.initialReady();
    expect(t.skipAsSuccess("b")).toEqual({ ready: ["c"], skipped: [] });
    expect(t.complete("a", { kind: "success" })).toEqual({ ready: [], skipped: [] });
    expect(t.isResolved("b")).toBe(true);
  });

  it("Phase 2: unmatched edges deliver skips and dead paths propagate", () => {
    // a --success--> b --> d ; a --error--> c ; join d? no: c and d independent
    const g = graph(["a", "b", "c", "d"], [e("a", "b"), e("a", "c", { sourcePort: "error" }), e("b", "d")]);
    const t = new ActivationTracker(g);
    t.initialReady();
    expect(t.complete("a", { kind: "failure" })).toEqual({ ready: ["c"], skipped: ["b", "d"] });
    expect(t.activatedEdges()).toEqual(["a-c"]);
  });

  it("Phase 2: a join with one activation and one skip becomes ready", () => {
    const g = graph(
      ["k", "t", "f", "j"],
      [e("k", "t", { sourcePort: "true" }), e("k", "f", { sourcePort: "false" }), e("t", "j"), e("f", "j")],
    );
    const tr = new ActivationTracker(g);
    tr.initialReady();
    expect(tr.complete("k", { kind: "success", port: "true" })).toEqual({ ready: ["t"], skipped: ["f"] });
    expect(tr.complete("t", { kind: "success" })).toEqual({ ready: ["j"], skipped: [] });
  });

  it("restore() replays finished nodes and reports ready-but-unfinished ones", () => {
    const g = graph(["a", "b", "c", "d"], [e("a", "b"), e("b", "c"), e("a", "d")]);
    const t = ActivationTracker.restore(g, [{ nodeId: "a", outcome: { kind: "success" } }]);
    expect(t.readyUnresolved()).toEqual(["b", "d"]);
    expect(t.complete("b", { kind: "success" }).ready).toEqual(["c"]);

    const skipped = ActivationTracker.restore(g, [
      { nodeId: "a", outcome: { kind: "success" } },
      { nodeId: "b", outcome: "skipped" },
    ]);
    expect(skipped.readyUnresolved()).toEqual(["d"]);
    expect(skipped.isResolved("c")).toBe(true); // dead path propagated from b
  });

  it("resetIteration forgets deliveries into the loop body", () => {
    const g = graph(["a", "b", "c"], [e("a", "b"), e("b", "c")]);
    const t = new ActivationTracker(g);
    t.initialReady();
    t.complete("a", { kind: "success" });
    t.complete("b", { kind: "success" });
    t.resetIteration(["b", "c"]);
    expect(t.isResolved("b")).toBe(false);
    expect(t.activatedEdges()).toEqual([]);
    expect(t.readyUnresolved()).toEqual([]);
  });
});
