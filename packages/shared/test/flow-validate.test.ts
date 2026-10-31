import { describe, expect, it } from "vitest";
import {
  buildTopology,
  computeLanePlan,
  edgesMutuallyExclusive,
  GraphSchema,
  loopBody,
  validateGraph,
  type Graph,
  type GraphInput,
  type ValidationIssue,
} from "../src/index.js";

/** Phase 2 validation (§15): joins of exclusive branches, ports, loops. */

type N = { id: string; type?: string; x?: number; y?: number; config?: Record<string, unknown>; onError?: string };
type E = { id?: string; source: string; target: string; sourcePort?: string; when?: string; loop?: { maxIterations: number; onExhausted?: string } };

const CONFIG: Record<string, Record<string, unknown>> = { prompt: { prompt: "do it" }, shell: { run: "true" }, command: { command: "/x" } };

function g(nodes: N[], edges: E[]): Graph {
  return GraphSchema.parse({
    version: 1,
    id: "flow",
    name: "Flow",
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type ?? "prompt",
      label: n.id,
      position: { x: n.x ?? i * 100, y: n.y ?? 0 },
      config: n.config ?? CONFIG[n.type ?? "prompt"] ?? {},
      ...(n.onError ? { onError: n.onError } : {}),
    })),
    edges: edges.map((e, i) => ({ id: e.id ?? `e${i}`, ...e })),
  } as GraphInput);
}
const issues = (list: ValidationIssue[]) => list.map((i) => `${i.code}:${i.nodeId ?? i.edgeId ?? ""}`);

/** impl → test → cond; cond.true → commit; cond.false → fix; fix ⟲ test. */
const TEST_FIX: N[] = [
  { id: "impl", x: 0 },
  { id: "test", type: "shell", x: 100 },
  { id: "cond", type: "condition", x: 200 },
  { id: "commit", type: "commit", x: 300, y: 0 },
  { id: "fix", x: 300, y: 100 },
];
const testFixEdges = (loop: E["loop"] = { maxIterations: 3 }): E[] => [
  { source: "impl", target: "test" },
  { id: "test-cond", source: "test", target: "cond", when: "always" },
  { source: "cond", sourcePort: "true", target: "commit" },
  { source: "cond", sourcePort: "false", target: "fix" },
  { id: "loop", source: "fix", target: "test", loop },
];

describe("exclusive joins (§15.3)", () => {
  it("accepts true/false branches of one condition and a step joined with its failure path", () => {
    const graph = g(
      [{ id: "t", type: "shell" }, { id: "c", type: "condition" }, { id: "a", y: 0 }, { id: "b", y: 100 }, { id: "a2", y: 0 }, { id: "j", x: 600 }],
      [
        { source: "t", target: "c" },
        { source: "c", sourcePort: "true", target: "a" },
        { source: "c", sourcePort: "false", target: "b" },
        { source: "a", target: "a2" },
        { source: "a2", target: "j" },
        { source: "b", target: "j" },
      ],
    );
    expect(validateGraph(graph).errors).toEqual([]);
    // A failure edge out of a node dominated by the false branch is still on the false side.
    const viaFailure = g(
      [{ id: "t", type: "shell" }, { id: "c", type: "condition" }, { id: "a", y: 0 }, { id: "b", y: 100 }, { id: "j", x: 600 }],
      [
        { source: "t", target: "c" },
        { source: "c", sourcePort: "true", target: "a" },
        { source: "c", sourcePort: "false", target: "b" },
        { source: "a", target: "j" },
        { source: "b", sourcePort: "error", target: "j" },
      ],
    );
    expect(validateGraph(viaFailure).errors).toEqual([]);
  });

  it('rejects joins that are not provably exclusive ("always" edges, unrelated inputs)', () => {
    const always = g([{ id: "a" }, { id: "x", y: 0 }, { id: "y", y: 100 }, { id: "j", x: 500 }], [
      { source: "a", target: "x", when: "always" },
      { source: "a", sourcePort: "error", target: "y" },
      { source: "x", target: "j" },
      { source: "y", target: "j" },
    ]);
    expect(issues(validateGraph(always).errors)).toEqual(["invalid_join:j"]);
    expect(validateGraph(always).errors[0]!.message).toContain("merge node");

    // b is reachable only through the false side, but a second root also activates it.
    const unrelated = g(
      [{ id: "t", type: "shell" }, { id: "c", type: "condition" }, { id: "r", y: 300 }, { id: "a", y: 0 }, { id: "b", y: 100 }, { id: "j", x: 600 }],
      [
        { source: "t", target: "c" },
        { source: "c", sourcePort: "true", target: "a" },
        { source: "c", sourcePort: "false", target: "b" },
        { source: "r", target: "b" },
        { source: "a", target: "j" },
        { source: "b", target: "j" },
      ],
    );
    const topo = buildTopology(unrelated);
    const [ja, jb] = topo.incoming.get("j")!;
    expect(edgesMutuallyExclusive(topo, ja!, jb!)).toBe(false);
    expect(issues(validateGraph(unrelated).errors)).toEqual(expect.arrayContaining(["invalid_join:b", "invalid_join:j"]));
  });

  it("rejects exclusive branches that reach the join from different lanes", () => {
    const graph = g(
      [{ id: "t", type: "shell" }, { id: "c", type: "condition" }, { id: "a", y: 0 }, { id: "b", y: 50 }, { id: "f", y: 100 }, { id: "j", x: 600 }],
      [
        { source: "t", target: "c" },
        { source: "c", sourcePort: "true", target: "a" },
        { source: "c", sourcePort: "true", target: "b" }, // fan-out on the true side → b forks a lane
        { source: "c", sourcePort: "false", target: "f" },
        { source: "b", target: "j" },
        { source: "f", target: "j" },
      ],
    );
    const r = validateGraph(graph);
    expect(issues(r.errors)).toEqual(["invalid_join:j"]);
    expect(r.errors[0]!.message).toContain("different lanes");
  });

  it('lane plan: an "always" edge never shares the lane with a failure branch', () => {
    const graph = g([{ id: "a" }, { id: "x", y: 0 }, { id: "y", y: 100 }], [
      { source: "a", target: "x", when: "always" },
      { source: "a", sourcePort: "error", target: "y" },
    ]);
    const plan = computeLanePlan(graph);
    expect(plan.laneOf.get("x")).not.toBe(plan.laneOf.get("y"));
  });
});

describe("ports and failure routing (§15.1, §15.2)", () => {
  it("true/false ports only fire on success; onError is ignored behind a failure edge", () => {
    const r = validateGraph(
      g([{ id: "t", type: "shell" }, { id: "c", type: "condition", onError: "fail-run" }, { id: "a" }, { id: "b", y: 100 }], [
        { source: "t", target: "c" },
        { id: "bad", source: "c", sourcePort: "true", when: "failure", target: "a" },
        { source: "c", sourcePort: "error", target: "b" },
      ]),
    );
    expect(issues(r.errors)).toEqual(["invalid_port:bad"]);
    expect(issues(r.warnings)).toEqual(["condition_input:c", "on_error_ignored:c"]);
  });
});

describe("loops (§15.4)", () => {
  it("accepts the canonical test-fix loop and computes its body", () => {
    const graph = g(TEST_FIX, testFixEdges());
    expect(validateGraph(graph)).toEqual({ errors: [], warnings: [] });
    const topo = buildTopology(graph);
    expect([...loopBody(topo, topo.loopEdges[0]!)].sort()).toEqual(["cond", "fix", "test"]);
    const plain = g(TEST_FIX, testFixEdges().map((e) => (e.id === "test-cond" ? { source: "test", target: "cond" } : e)));
    const warning = validateGraph(plain).warnings;
    expect(issues(warning)).toEqual(["condition_input:cond"]);
    expect(warning[0]!.message).toContain('"always"');
    expect(issues(validateGraph(graph, { phase: 1 }).errors)).toEqual(expect.arrayContaining(["phase2_unsupported:loop", "phase2_unsupported:cond"]));
  });

  it("allows a self-loop only as a loop edge (retry one node)", () => {
    const ok = g([{ id: "a", type: "shell" }], [{ id: "l", source: "a", target: "a", sourcePort: "error", loop: { maxIterations: 2 } }]);
    expect(validateGraph(ok).errors).toEqual([]);
    const bad = g([{ id: "a", type: "shell" }], [{ id: "l", source: "a", target: "a" }]);
    expect(issues(validateGraph(bad).errors)).toContain("self_loop:l");
  });

  it("rejects loops that do not point back, overlap, repeat the same body, merge or fork", () => {
    const forward = g([{ id: "a" }, { id: "b" }, { id: "c" }], [
      { source: "a", target: "b" },
      { id: "l", source: "a", target: "c", loop: { maxIterations: 2 } },
    ]);
    expect(issues(validateGraph(forward).errors)).toEqual(["invalid_loop:l"]);

    const chain: N[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const chainEdges: E[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "d" },
    ];
    const cont = { maxIterations: 2, onExhausted: "continue" };
    const overlap = g(chain, [...chainEdges, { id: "l1", source: "c", target: "a", loop: cont }, { id: "l2", source: "d", target: "b", loop: cont }]);
    expect(issues(validateGraph(overlap).errors)).toEqual(["invalid_loop:l2"]);
    expect(validateGraph(overlap).errors[0]!.message).toContain("overlap");

    const nested = g(chain, [...chainEdges, { id: "l1", source: "d", target: "a", loop: cont }, { id: "l2", source: "c", target: "b", loop: cont }]);
    expect(validateGraph(nested).errors).toEqual([]);

    const same = g(TEST_FIX, [...testFixEdges(), { id: "again", source: "fix", target: "test", sourcePort: "error", loop: { maxIterations: 1 } }]);
    expect(issues(validateGraph(same).errors)).toEqual(["invalid_loop:again"]);

    const merging = g(
      [{ id: "a" }, { id: "x", y: 0 }, { id: "y", y: 100 }, { id: "m", type: "merge" }, { id: "t", type: "shell" }, { id: "c", type: "condition" }],
      [
        { source: "a", target: "x" },
        { source: "a", target: "y" },
        { source: "x", target: "m" },
        { source: "y", target: "m" },
        { source: "m", target: "t" },
        { source: "t", target: "c" },
        { id: "l", source: "c", sourcePort: "false", target: "a", loop: { maxIterations: 2 } },
      ],
    );
    expect(issues(validateGraph(merging).errors)).toEqual(["invalid_loop:m"]);

    const forking = g(TEST_FIX.concat({ id: "notify", x: 200, y: 200 }), [...testFixEdges(), { source: "test", target: "notify" }]);
    const r = validateGraph(forking);
    expect(issues(r.errors)).toEqual(["invalid_loop:test"]);
    expect(r.errors[0]!.message).toContain("parallel branches");
  });

  it("warns when nothing but a failure can stop a loop", () => {
    const g1 = g([{ id: "a" }, { id: "b" }], [
      { source: "a", target: "b" },
      { id: "l", source: "b", target: "a", loop: { maxIterations: 2 } },
    ]);
    expect(issues(validateGraph(g1).warnings)).toEqual(["unconditional_loop:l"]);
    expect(validateGraph(g1).warnings[0]!.message).toContain("3 times");
    const cont = g([{ id: "a" }, { id: "b" }], [
      { source: "a", target: "b" },
      { id: "l", source: "b", target: "a", loop: { maxIterations: 2, onExhausted: "continue" } },
    ]);
    expect(validateGraph(cont).warnings).toEqual([]);
  });

  it("rejects a loop back to an exit-code/regex condition (it would re-check the same output)", () => {
    const toCond = g(TEST_FIX, [...testFixEdges().filter((e) => e.id !== "loop"), { id: "loop", source: "fix", target: "cond", loop: { maxIterations: 3 } }]);
    const r = validateGraph(toCond);
    expect(issues(r.errors)).toEqual(["invalid_loop:loop"]);
    expect(r.errors[0]!.message).toContain("same output");
    const self = g(
      [{ id: "t", type: "shell" }, { id: "c", type: "condition" }, { id: "a" }],
      [{ source: "t", target: "c", when: "always" }, { source: "c", sourcePort: "true", target: "a" }, { id: "l", source: "c", sourcePort: "false", target: "c", loop: { maxIterations: 2 } }],
    );
    expect(issues(validateGraph(self).errors)).toEqual(["invalid_loop:l"]);
  });

  it("a condition without a forward predecessor is an error (a loop edge into it does not count)", () => {
    const alone = g([{ id: "c", type: "condition", config: { evaluator: { kind: "regex", pattern: "x" } } }, { id: "a" }], [{ source: "c", sourcePort: "true", target: "a" }]);
    expect(issues(validateGraph(alone).errors)).toEqual(["condition_input:c"]);
  });

  it('context "resume" inside a loop body does not need a Claude predecessor', () => {
    const nodes = TEST_FIX.map((n) => (n.id === "fix" ? { ...n, config: { prompt: "fix", context: "resume" } } : n));
    expect(validateGraph(g(nodes, testFixEdges())).errors).toEqual([]);
    const outside = TEST_FIX.map((n) => (n.id === "commit" ? { ...n, type: "prompt", config: { prompt: "x", context: "resume" } } : n));
    expect(issues(validateGraph(g(outside, testFixEdges())).errors)).toEqual(["invalid_resume_context:commit"]);
  });
});
