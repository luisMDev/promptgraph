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
    expect(t.complete("a", { kind: "success" })).toEqual({ ready: ["b"], skipped: [], loops: [] });
    expect(t.complete("b", { kind: "success" })).toEqual({ ready: ["c"], skipped: [], loops: [] });
    expect(t.complete("c", { kind: "success" })).toEqual({ ready: [], skipped: [], loops: [] });
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
    expect(t.complete("a", { kind: "success" })).toEqual({ ready: [], skipped: [], loops: [] });
  });

  it("skipAsSuccess resolves a node so later deliveries never ready it again", () => {
    const t = new ActivationTracker(graph(["a", "b", "c"], [e("a", "b"), e("b", "c")]));
    t.initialReady();
    expect(t.skipAsSuccess("b")).toEqual({ ready: ["c"], skipped: [], loops: [] });
    expect(t.complete("a", { kind: "success" })).toEqual({ ready: [], skipped: [], loops: [] });
    expect(t.isResolved("b")).toBe(true);
  });

  it("Phase 2: unmatched edges deliver skips and dead paths propagate", () => {
    // a --success--> b --> d ; a --error--> c ; join d? no: c and d independent
    const g = graph(["a", "b", "c", "d"], [e("a", "b"), e("a", "c", { sourcePort: "error" }), e("b", "d")]);
    const t = new ActivationTracker(g);
    t.initialReady();
    expect(t.complete("a", { kind: "failure" })).toEqual({ ready: ["c"], skipped: ["b", "d"], loops: [] });
    expect(t.activatedEdges()).toEqual(["a-c"]);
  });

  it("Phase 2: a join with one activation and one skip becomes ready", () => {
    const g = graph(
      ["k", "t", "f", "j"],
      [e("k", "t", { sourcePort: "true" }), e("k", "f", { sourcePort: "false" }), e("t", "j"), e("f", "j")],
    );
    const tr = new ActivationTracker(g);
    tr.initialReady();
    expect(tr.complete("k", { kind: "success", port: "true" })).toEqual({ ready: ["t"], skipped: ["f"], loops: [] });
    expect(tr.complete("t", { kind: "success" })).toEqual({ ready: ["j"], skipped: [], loops: [] });
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

  describe("Phase 2 loops", () => {
    /** impl → test → cond; cond.true → commit; cond.false → fix; fix ⟲ test (loop). */
    function testFix(loop: { maxIterations: number; onExhausted?: "fail" | "continue" }) {
      return GraphSchema.parse({
        version: 1,
        id: "g",
        name: "G",
        nodes: [
          { id: "impl", type: "prompt", position: { x: 0, y: 0 } },
          { id: "test", type: "shell", position: { x: 100, y: 0 } },
          { id: "cond", type: "condition", position: { x: 200, y: 0 } },
          { id: "commit", type: "commit", position: { x: 300, y: 0 } },
          { id: "fix", type: "prompt", position: { x: 300, y: 100 } },
        ],
        edges: [
          e("impl", "test"),
          e("test", "cond"),
          e("cond", "commit", { sourcePort: "true" }),
          e("cond", "fix", { sourcePort: "false" }),
          { id: "loop", source: "fix", target: "test", loop },
        ],
      });
    }
    const ok = { kind: "success" } as const;
    const no = { kind: "success", port: "false" } as const;
    const yes = { kind: "success", port: "true" } as const;

    it("holds exits while the loop may repeat, loops back, and lets the last pass out", () => {
      const t = new ActivationTracker(testFix({ maxIterations: 2 }));
      expect(t.loopStates()).toEqual([{ edgeId: "loop", iteration: 0, maxIterations: 2, exhausted: false }]);
      t.initialReady();
      t.complete("impl", ok);
      t.complete("test", ok);
      // commit's skip is held: a later pass may still take the true branch.
      expect(t.complete("cond", no)).toEqual({ ready: ["fix"], skipped: [], loops: [] });
      expect(t.isResolved("commit")).toBe(false);
      expect(t.complete("fix", ok)).toEqual({
        ready: ["test"],
        skipped: [],
        loops: [{ edgeId: "loop", iteration: 1, body: ["test", "cond", "fix"] }],
      });
      expect(t.isResolved("cond")).toBe(false);
      expect(t.isActivated("test-cond")).toBe(false);
      expect(t.isActivated("impl-test")).toBe(true); // deliveries from outside the body are kept
      t.complete("test", ok);
      // fix is a dead path → the loop edge cannot fire → the held commit activation is released.
      expect(t.complete("cond", yes)).toEqual({ ready: ["commit"], skipped: ["fix"], loops: [] });
      expect(t.loopStates()[0]).toMatchObject({ iteration: 1, exhausted: false });
    });

    it("exhausted + fail: the source must fail; skipping it continues", () => {
      const t = new ActivationTracker(testFix({ maxIterations: 1 }));
      t.initialReady();
      t.complete("impl", ok);
      t.complete("test", ok);
      t.complete("cond", no);
      expect(t.exhaustedFailLoop("fix", ok)).toBeNull();
      expect(t.complete("fix", ok).loops).toHaveLength(1);
      t.complete("test", ok);
      t.complete("cond", no);
      expect(t.exhaustedFailLoop("fix", ok)?.id).toBe("loop");
      expect(t.loopsBack("fix", ok)).toBe(false);
      // The engine turns the success into a failure: no failure edge → commit gets its skip now.
      t.markExhausted("loop");
      expect(t.complete("fix", { kind: "failure" })).toEqual({ ready: [], skipped: ["commit"], loops: [] });
      expect(t.loopStates()[0]).toMatchObject({ iteration: 1, exhausted: true });
    });

    it("exhausted + continue: the loop edge delivers a skip and the flow continues", () => {
      const t = new ActivationTracker(testFix({ maxIterations: 1, onExhausted: "continue" }));
      t.initialReady();
      for (let i = 0; i < 2; i++) {
        t.complete("impl", ok);
        t.complete("test", ok);
        t.complete("cond", no);
        if (i === 0) t.complete("fix", ok);
      }
      expect(t.exhaustedFailLoop("fix", ok)).toBeNull();
      expect(t.complete("fix", ok)).toEqual({ ready: [], skipped: ["commit"], loops: [] });
      expect(t.loopStates()[0]!.exhausted).toBe(true);
    });

    it("a failure loop edge retries a node; the next step waits for the last pass", () => {
      const g = graph(["a", "b"], [e("a", "b"), { id: "retry", source: "a", target: "a", sourcePort: "error", loop: { maxIterations: 2 } }]);
      const t = new ActivationTracker(g);
      t.initialReady();
      expect(t.loopsBack("a", { kind: "failure" })).toBe(true);
      expect(t.complete("a", { kind: "failure" })).toEqual({ ready: ["a"], skipped: [], loops: [{ edgeId: "retry", iteration: 1, body: ["a"] }] });
      expect(t.complete("a", { kind: "success" })).toEqual({ ready: ["b"], skipped: [], loops: [] });
    });

    it("an outer loop restarts the inner loop's counter", () => {
      // a → b → c → d; inner c ⟲ b (2), outer d ⟲ a (1); always-success loops (counters only).
      const g = graph(
        ["a", "b", "c", "d", "z"],
        [
          e("a", "b"),
          e("b", "c"),
          e("c", "d"),
          e("d", "z"),
          { id: "inner", source: "c", target: "b", loop: { maxIterations: 1, onExhausted: "continue" } },
          { id: "outer", source: "d", target: "a", loop: { maxIterations: 1, onExhausted: "continue" } },
        ],
      );
      const t = new ActivationTracker(g);
      t.initialReady();
      t.complete("a", ok);
      t.complete("b", ok);
      expect(t.complete("c", ok).loops.map((l) => l.edgeId)).toEqual(["inner"]);
      t.complete("b", ok);
      expect(t.complete("c", ok)).toEqual({ ready: ["d"], skipped: [], loops: [] }); // inner exhausted, continue
      expect(t.complete("d", ok)).toEqual({ ready: ["a"], skipped: [], loops: [{ edgeId: "outer", iteration: 1, body: ["a", "b", "c", "d"] }] });
      expect(t.loopStates()).toEqual([
        { edgeId: "inner", iteration: 0, maxIterations: 1, exhausted: false },
        { edgeId: "outer", iteration: 1, maxIterations: 1, exhausted: false },
      ]);
      t.complete("a", ok);
      t.complete("b", ok);
      expect(t.complete("c", ok).loops.map((l) => l.edgeId)).toEqual(["inner"]);
      t.complete("b", ok);
      t.complete("c", ok);
      expect(t.complete("d", ok)).toEqual({ ready: ["z"], skipped: [], loops: [] });
    });

    it("restore() replays the current pass with the persisted counters", () => {
      const g = testFix({ maxIterations: 3 });
      const states = [{ edgeId: "loop", iteration: 1, maxIterations: 3, exhausted: false }];
      // Second pass: test and cond done (false), fix pending.
      const t = ActivationTracker.restore(
        g,
        [
          { nodeId: "impl", outcome: ok },
          { nodeId: "test", outcome: ok },
          { nodeId: "cond", outcome: no },
        ],
        states,
      );
      expect(t.readyUnresolved()).toEqual(["fix"]);
      expect(t.isResolved("commit")).toBe(false);
      expect(t.takeRestoredLoops()).toEqual([]);
      // Crash right after fix succeeded (new iteration not persisted): the replay loops back.
      const crashed = ActivationTracker.restore(
        g,
        [
          { nodeId: "impl", outcome: ok },
          { nodeId: "test", outcome: ok },
          { nodeId: "cond", outcome: no },
          { nodeId: "fix", outcome: ok },
        ],
        states,
      );
      expect(crashed.takeRestoredLoops()).toEqual([{ edgeId: "loop", iteration: 2, body: ["test", "cond", "fix"] }]);
      expect(crashed.readyUnresolved()).toEqual(["test"]);
    });
  });
});
