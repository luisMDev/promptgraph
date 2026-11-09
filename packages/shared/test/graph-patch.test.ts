import { describe, expect, it } from "vitest";
import {
  applyGraphPatch,
  GraphPatchError,
  GraphPatchOpSchema,
  GraphSchema,
  LAYOUT_DX,
  LAYOUT_DY,
  layeredLayout,
  isLaidOut,
  deriveEdgeId,
  validateGraph,
  type Graph,
  type GraphPatchOpInput,
} from "../src/index.js";

type N = { id: string; type?: string; x?: number; y?: number; label?: string; config?: Record<string, unknown> };
type E = { id?: string; source: string; target: string; sourcePort?: string; when?: string; loop?: { maxIterations: number } };

function g(nodes: N[], edges: E[] = []): Graph {
  return GraphSchema.parse({
    version: 1,
    id: "test",
    name: "Test",
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? "shell",
      label: n.label ?? "",
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      config: n.config ?? { run: `echo ${n.id}` },
    })),
    edges: edges.map((e) => ({ id: e.id ?? `e-${e.source}-${e.target}`, ...e })),
  });
}

/** a → b → c, laid out on one row. */
const chain = () => g([{ id: "a" }, { id: "b", y: 200 }, { id: "c", y: 400 }], [{ source: "a", target: "b" }, { source: "b", target: "c" }]);

const pairs = (graph: Graph) => graph.edges.map((e) => `${e.source}${e.sourcePort === "out" ? "" : `:${e.sourcePort}`}>${e.target}`).sort();

function expectPatchError(fn: () => unknown, code: string, opIndex?: number): GraphPatchError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GraphPatchError);
    const e = err as GraphPatchError;
    expect(e.code).toBe(code);
    if (opIndex !== undefined) expect(e.opIndex).toBe(opIndex);
    return e;
  }
  throw new Error("expected a GraphPatchError");
}

describe("applyGraphPatch: purity and result", () => {
  it("does not modify the input graph", () => {
    const graph = chain();
    const before = structuredClone(graph);
    applyGraphPatch(graph, [{ op: "remove_node", id: "b" }, { op: "update_node", id: "a", label: "A" }]);
    expect(graph).toEqual(before);
  });

  it("returns a graph that parses with GraphSchema", () => {
    const { graph } = applyGraphPatch(chain(), [{ op: "insert_after", after: "a", node: { type: "prompt", label: "Plan" } }]);
    expect(GraphSchema.parse(graph)).toEqual(graph);
  });

  it("rejects malformed ops with invalid_op", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "explode" } as unknown as GraphPatchOpInput]), "invalid_op");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "add_node", node: { type: "nope" } } as unknown as GraphPatchOpInput]), "invalid_op");
  });

  it("an empty op list returns the graph unchanged", () => {
    const res = applyGraphPatch(chain(), []);
    expect(res.graph).toEqual(chain());
    expect([res.added, res.removed, res.updated]).toEqual([[], [], []]);
  });

  it("GraphPatchOpSchema discriminates on op", () => {
    expect(GraphPatchOpSchema.safeParse({ op: "remove_node", id: "x" }).success).toBe(true);
    expect(GraphPatchOpSchema.safeParse({ op: "remove_node" }).success).toBe(false);
  });
});

describe("add_node", () => {
  it("derives a unique id from the label, else the type", () => {
    const graph = g([{ id: "run-tests" }]);
    const res = applyGraphPatch(graph, [
      { op: "add_node", node: { type: "shell", label: "Run tests!" } },
      { op: "add_node", node: { type: "commit" } },
      { op: "add_node", node: { type: "commit" } },
    ]);
    expect(res.added).toEqual(["run-tests-2", "commit", "commit-2"]);
    expect(res.graph.nodes.map((n) => n.id)).toEqual(["run-tests", "run-tests-2", "commit", "commit-2"]);
  });

  it("keeps a given id and position and fills config defaults", () => {
    const res = applyGraphPatch(chain(), [{ op: "add_node", node: { id: "pr", type: "pr", position: { x: 5, y: 7 } } }]);
    const pr = res.graph.nodes.find((n) => n.id === "pr")!;
    expect(pr.position).toEqual({ x: 5, y: 7 });
    expect(pr.type === "pr" && pr.config.requireApproval).toBe(true);
  });

  it("rejects a duplicate id", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "add_node", node: { id: "b", type: "shell" } }]), "duplicate_node", 0);
  });

  it("rejects an invalid config", () => {
    const err = expectPatchError(
      () => applyGraphPatch(chain(), [{ op: "add_node", node: { id: "x", type: "shell", config: { timeoutSec: -1 } } }]),
      "invalid_node",
    );
    expect(err.message).toMatch(/^op 0: node "x" is invalid/);
  });

  it("places a new node connected later one row below its predecessor, avoiding overlaps", () => {
    const res = applyGraphPatch(chain(), [
      { op: "add_node", node: { id: "lint", type: "shell", config: { run: "pnpm lint" } } },
      { op: "connect", source: "a", target: "lint" },
    ]);
    const lint = res.graph.nodes.find((n) => n.id === "lint")!;
    // a is at (0,0); (0,200) is taken by b, so it moves one column right.
    expect(lint.position).toEqual({ x: LAYOUT_DX, y: LAYOUT_DY });
  });

  it("places a node reached through a failure edge beside its predecessor, to the right", () => {
    const res = applyGraphPatch(chain(), [
      { op: "add_node", node: { id: "notify", type: "shell", config: { run: "echo failed" } } },
      { op: "connect", source: "b", target: "notify", sourcePort: "error" },
    ]);
    expect(res.graph.nodes.find((n) => n.id === "notify")!.position).toEqual({ x: LAYOUT_DX, y: 200 });
  });

  it("places a node with only a successor one row above it", () => {
    const res = applyGraphPatch(chain(), [
      { op: "add_node", node: { id: "setup", type: "shell" } },
      { op: "connect", source: "setup", target: "a" },
    ]);
    expect(res.graph.nodes.find((n) => n.id === "setup")!.position).toEqual({ x: 0, y: -LAYOUT_DY });
  });

  it("places an unconnected node below the graph", () => {
    const res = applyGraphPatch(chain(), [{ op: "add_node", node: { id: "lonely", type: "shell" } }]);
    expect(res.graph.nodes.find((n) => n.id === "lonely")!.position).toEqual({ x: 0, y: 400 + LAYOUT_DY });
  });

  it("lays out a graph made only of new nodes with the layered layout", () => {
    const empty = g([]);
    const res = applyGraphPatch(empty, [
      { op: "add_node", node: { id: "x", type: "shell" } },
      { op: "add_node", node: { id: "y", type: "shell" } },
      { op: "add_node", node: { id: "z", type: "shell" } },
      { op: "connect", source: "x", target: "y" },
      { op: "connect", source: "x", target: "z" },
    ]);
    const pos = Object.fromEntries(res.graph.nodes.map((n) => [n.id, n.position]));
    expect(pos).toEqual({ x: { x: 0, y: 0 }, y: { x: -LAYOUT_DX / 2, y: LAYOUT_DY }, z: { x: LAYOUT_DX / 2, y: LAYOUT_DY } });
  });

  it("places a chain of new nodes top to bottom", () => {
    const res = applyGraphPatch(chain(), [
      { op: "add_node", node: { id: "n1", type: "shell" } },
      { op: "add_node", node: { id: "n2", type: "shell" } },
      { op: "connect", source: "c", target: "n1" },
      { op: "connect", source: "n1", target: "n2" },
    ]);
    const pos = Object.fromEntries(res.graph.nodes.map((n) => [n.id, n.position]));
    expect(pos.n1).toEqual({ x: 0, y: 600 });
    expect(pos.n2).toEqual({ x: 0, y: 800 });
  });
});

describe("update_node", () => {
  it("updates the label and shallow-merges config", () => {
    const graph = g([{ id: "p", type: "prompt", config: { prompt: "old", model: "opus" } }]);
    const res = applyGraphPatch(graph, [{ op: "update_node", id: "p", label: "Plan", config: { prompt: "new" } }]);
    const p = res.graph.nodes[0]!;
    expect(p.label).toBe("Plan");
    expect(p.type === "prompt" && [p.config.prompt, p.config.model]).toEqual(["new", "opus"]);
    expect(res.updated).toEqual(["p"]);
  });

  it("removes config keys set to null and clears onError with null", () => {
    const graph = g([{ id: "p", type: "prompt", config: { prompt: "x", model: "opus" } }]);
    const step1 = applyGraphPatch(graph, [{ op: "update_node", id: "p", onError: "fail-run" }]).graph;
    expect(step1.nodes[0]!.onError).toBe("fail-run");
    const res = applyGraphPatch(step1, [{ op: "update_node", id: "p", config: { model: null }, onError: null }]);
    const p = res.graph.nodes[0]!;
    expect(p.type === "prompt" && p.config.model).toBeUndefined();
    expect(p.onError).toBeUndefined();
  });

  it("keeps id and position unless a position is given", () => {
    const res = applyGraphPatch(chain(), [{ op: "update_node", id: "b", label: "B" }]);
    expect(res.graph.nodes[1]).toMatchObject({ id: "b", position: { x: 0, y: 200 } });
    const moved = applyGraphPatch(chain(), [{ op: "update_node", id: "b", position: { x: 1, y: 2 } }]);
    expect(moved.graph.nodes[1]!.position).toEqual({ x: 1, y: 2 });
  });

  it("rejects unknown config fields instead of silently dropping them", () => {
    const graph = g([{ id: "l1", type: "prompt", config: { prompt: "" } }]);
    const err = expectPatchError(() => applyGraphPatch(graph, [{ op: "update_node", id: "l1", config: { promt: "hello" } }]), "invalid_node", 0);
    expect(err.message).toMatch(/unknown config field "promt" for prompt nodes \(expected: prompt, /);
    expectPatchError(() => applyGraphPatch(graph, [{ op: "add_node", node: { type: "prompt", config: { text: "do it" } } }]), "invalid_node");
    expectPatchError(() => applyGraphPatch(graph, [{ op: "insert_after", after: "l1", node: { type: "shell", config: { cmd: "x" } } }]), "invalid_node");
  });

  it("rejects unknown nodes and invalid configs", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "update_node", id: "zz", label: "x" }]), "unknown_node");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "update_node", id: "a", config: { timeoutSec: "soon" } }]), "invalid_node");
  });

  it("an updated new node is reported as added only", () => {
    const res = applyGraphPatch(chain(), [
      { op: "add_node", node: { id: "x", type: "shell" } },
      { op: "update_node", id: "x", label: "X" },
    ]);
    expect(res.added).toEqual(["x"]);
    expect(res.updated).toEqual([]);
  });
});

describe("remove_node", () => {
  it("bridges predecessors to successors by default", () => {
    const res = applyGraphPatch(chain(), [{ op: "remove_node", id: "b" }]);
    expect(res.graph.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(pairs(res.graph)).toEqual(["a>c"]);
    expect(res.removed).toEqual(["b"]);
    expect(res.removedEdges.sort()).toEqual(["e-a-b", "e-b-c"]);
    expect(res.addedEdges).toEqual(["e-a-c"]);
  });

  it("drops edges without bridging when reconnect is false", () => {
    const res = applyGraphPatch(chain(), [{ op: "remove_node", id: "b", reconnect: false }]);
    expect(res.graph.edges).toEqual([]);
  });

  it("bridges every predecessor to every successor without duplicating existing edges", () => {
    const graph = g(
      [{ id: "a" }, { id: "b" }, { id: "m" }, { id: "x" }, { id: "y" }],
      [
        { source: "a", target: "m" },
        { source: "b", target: "m" },
        { source: "m", target: "x" },
        { source: "m", target: "y" },
        { source: "a", target: "x" },
      ],
    );
    const res = applyGraphPatch(graph, [{ op: "remove_node", id: "m" }]);
    expect(pairs(res.graph)).toEqual(["a>x", "a>y", "b>x", "b>y"]);
  });

  it("keeps the predecessor's branch port and the loop of the successor edge", () => {
    const graph = g(
      [{ id: "t" }, { id: "cond", type: "condition", config: {} }, { id: "fix" }, { id: "done" }],
      [
        { source: "t", target: "cond" },
        { source: "cond", sourcePort: "false", target: "fix", id: "e-f" },
        { source: "cond", sourcePort: "true", target: "done", id: "e-t" },
        { source: "fix", target: "t", loop: { maxIterations: 3 }, id: "e-loop" },
      ],
    );
    const res = applyGraphPatch(graph, [{ op: "remove_node", id: "fix" }]);
    const bridge = res.graph.edges.find((e) => e.source === "cond" && e.target === "t")!;
    expect(bridge.sourcePort).toBe("false");
    expect(bridge.loop?.maxIterations).toBe(3);
  });

  it("bridges only the success path: failure and always handlers are dropped with the node", () => {
    const graph = g(
      [{ id: "p" }, { id: "x" }, { id: "h" }, { id: "f" }, { id: "w" }, { id: "next" }],
      [
        { source: "p", target: "x" },
        { source: "x", sourcePort: "error", target: "h" },
        { source: "x", target: "f", when: "failure" },
        { source: "x", target: "w", when: "always" },
        { source: "x", target: "next" },
      ],
    );
    const res = applyGraphPatch(graph, [{ op: "remove_node", id: "x" }]);
    expect(pairs(res.graph)).toEqual(["p>next"]);
    expect(res.graph.edges[0]!.when).toBeUndefined();
  });

  it("does not bridge condition branches of a removed condition", () => {
    const graph = g(
      [{ id: "t" }, { id: "c", type: "condition", config: {} }, { id: "yes" }, { id: "no" }],
      [
        { source: "t", target: "c" },
        { source: "c", sourcePort: "true", target: "yes" },
        { source: "c", sourcePort: "false", target: "no" },
      ],
    );
    const res = applyGraphPatch(graph, [{ op: "remove_node", id: "c" }]);
    expect(res.graph.edges).toEqual([]);
  });

  it("does not bridge a node to itself", () => {
    const graph = g([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b" }, { source: "b", target: "a", loop: { maxIterations: 2 } }]);
    const res = applyGraphPatch(graph, [{ op: "remove_node", id: "b" }]);
    expect(res.graph.edges).toEqual([]);
  });

  it("a node added then removed in the same patch is reported nowhere", () => {
    const res = applyGraphPatch(chain(), [
      { op: "insert_after", after: "a", node: { id: "tmp", type: "shell" } },
      { op: "remove_node", id: "tmp" },
    ]);
    expect([res.added, res.removed, res.updated]).toEqual([[], [], []]);
    expect(pairs(res.graph)).toEqual(["a>b", "b>c"]);
  });

  it("rejects unknown nodes", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "update_node", id: "a", label: "x" }, { op: "remove_node", id: "q" }]), "unknown_node", 1);
  });
});

describe("connect / disconnect", () => {
  it("connects with a derived id and optional port, when and loop", () => {
    const graph = g([{ id: "c", type: "condition", config: {} }, { id: "x" }, { id: "y" }]);
    const res = applyGraphPatch(graph, [
      { op: "connect", source: "c", target: "x", sourcePort: "true" },
      { op: "connect", source: "x", target: "y", when: "always" },
      { op: "connect", source: "y", target: "c", loop: { maxIterations: 4 } },
    ]);
    expect(res.addedEdges).toEqual(["e-c-true-x", "e-x-y", "e-y-c"]);
    expect(res.graph.edges[1]!.when).toBe("always");
    expect(res.graph.edges[2]!.loop).toEqual({ maxIterations: 4, onExhausted: "fail" });
  });

  it("suffixes derived ids that are taken", () => {
    const graph = g([{ id: "a" }, { id: "b" }], [{ id: "e-a-b", source: "b", target: "a" }]);
    const res = applyGraphPatch(graph, [{ op: "connect", source: "a", target: "b" }]);
    expect(res.addedEdges).toEqual(["e-a-b-2"]);
  });

  it("rejects duplicates and unknown endpoints", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "connect", source: "a", target: "b" }]), "duplicate_edge");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "connect", source: "a", target: "c", id: "e-a-b" }]), "duplicate_edge");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "connect", source: "a", target: "nope" }]), "unknown_node");
  });

  it("disconnects by id or by endpoints", () => {
    expect(pairs(applyGraphPatch(chain(), [{ op: "disconnect", edgeId: "e-a-b" }]).graph)).toEqual(["b>c"]);
    const res = applyGraphPatch(chain(), [{ op: "disconnect", source: "b", target: "c" }]);
    expect(pairs(res.graph)).toEqual(["a>b"]);
    expect(res.removedEdges).toEqual(["e-b-c"]);
  });

  it("reports missing, ambiguous and incomplete disconnects", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "disconnect", edgeId: "nope" }]), "unknown_edge");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "disconnect", source: "a", target: "c" }]), "unknown_edge");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "disconnect", source: "a" }]), "invalid_op");
    const graph = g([{ id: "a" }, { id: "b" }], [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "a", sourcePort: "error", target: "b" },
    ]);
    expectPatchError(() => applyGraphPatch(graph, [{ op: "disconnect", source: "a", target: "b" }]), "ambiguous_edge");
    expect(applyGraphPatch(graph, [{ op: "disconnect", source: "a", target: "b", sourcePort: "error" }]).removedEdges).toEqual(["e2"]);
  });

  it("an edge connected then disconnected is reported nowhere", () => {
    const res = applyGraphPatch(chain(), [
      { op: "connect", source: "a", target: "c" },
      { op: "disconnect", source: "a", target: "c" },
    ]);
    expect([res.addedEdges, res.removedEdges]).toEqual([[], []]);
  });
});

describe("insert_after / insert_before", () => {
  it("insert_after takes over the outgoing edges of the anchor (ids kept)", () => {
    const res = applyGraphPatch(chain(), [{ op: "insert_after", after: "b", node: { id: "lint", type: "shell", config: { run: "pnpm lint" } } }]);
    expect(pairs(res.graph)).toEqual(["a>b", "b>lint", "lint>c"]);
    expect(res.graph.edges.find((e) => e.id === "e-b-c")!.source).toBe("lint");
    expect(res.updatedEdges).toEqual(["e-b-c"]);
    expect(res.addedEdges).toEqual(["e-b-lint"]);
    expect(res.added).toEqual(["lint"]);
    // Existing nodes keep their positions; the new node avoids c's spot.
    expect(res.graph.nodes.filter((n) => n.id !== "lint").map((n) => n.position.y)).toEqual([0, 200, 400]);
    expect(res.graph.nodes.find((n) => n.id === "lint")!.position).toEqual({ x: LAYOUT_DX, y: 400 });
  });

  it("insert_after leaves failure, always and loop edges on the anchor", () => {
    const graph = g(
      [{ id: "a" }, { id: "b" }, { id: "fix" }, { id: "cond", type: "condition", config: {} }, { id: "h" }, { id: "start" }],
      [
        { source: "start", target: "a" },
        { source: "a", target: "b" },
        { source: "a", target: "fix", when: "failure" },
        { source: "a", target: "cond", when: "always" },
        { source: "a", sourcePort: "error", target: "h" },
        { source: "a", target: "start", loop: { maxIterations: 2 } },
      ],
    );
    const res = applyGraphPatch(graph, [{ op: "insert_after", after: "a", node: { id: "lint", type: "shell", config: { run: "pnpm lint" } } }]);
    expect(pairs(res.graph)).toEqual(["a:error>h", "a>cond", "a>fix", "a>lint", "a>start", "lint>b", "start>a"]);
    expect(res.graph.edges.find((e) => e.target === "fix")!.source).toBe("a");
    expect(res.updatedEdges).toEqual(["e-a-b"]);
  });

  it("insert_after on a last node just appends", () => {
    const res = applyGraphPatch(chain(), [{ op: "insert_after", after: "c", node: { type: "commit" } }]);
    expect(pairs(res.graph)).toEqual(["a>b", "b>c", "c>commit"]);
    expect(res.graph.nodes.find((n) => n.id === "commit")!.position).toEqual({ x: 0, y: 600 });
  });

  it("insert_after on a condition port only takes over that branch", () => {
    const graph = g(
      [{ id: "check" }, { id: "c", type: "condition", config: {} }, { id: "yes" }, { id: "no" }],
      [
        { source: "check", target: "c" },
        { id: "t", source: "c", sourcePort: "true", target: "yes" },
        { id: "f", source: "c", sourcePort: "false", target: "no" },
      ],
    );
    const res = applyGraphPatch(graph, [{ op: "insert_after", after: "c", port: "false", node: { id: "notify", type: "shell", config: { run: "echo no" } } }]);
    expect(pairs(res.graph)).toEqual(["c:false>notify", "c:true>yes", "check>c", "notify>no"]);
    expect(validateGraph(res.graph, { phase: 2 }).errors).toEqual([]);
  });

  it("insert_before takes over the incoming edges of the anchor", () => {
    const graph = g(
      [{ id: "a" }, { id: "b" }, { id: "m", type: "merge", config: {} }],
      [{ source: "a", target: "m" }, { source: "b", target: "m" }],
    );
    const res = applyGraphPatch(graph, [{ op: "insert_before", before: "m", node: { id: "pre", type: "shell" } }]);
    expect(pairs(res.graph)).toEqual(["a>pre", "b>pre", "pre>m"]);
    expect(res.updatedEdges.sort()).toEqual(["e-a-m", "e-b-m"]);
  });

  it("insert_before a root just prepends", () => {
    const res = applyGraphPatch(chain(), [{ op: "insert_before", before: "a", node: { id: "setup", type: "shell" } }]);
    expect(pairs(res.graph)).toEqual(["a>b", "b>c", "setup>a"]);
    expect(res.graph.nodes.find((n) => n.id === "setup")!.position).toEqual({ x: 0, y: -LAYOUT_DY });
  });

  it("rejects unknown anchors", () => {
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "insert_after", after: "x", node: { type: "shell" } }]), "unknown_node");
    expectPatchError(() => applyGraphPatch(chain(), [{ op: "insert_before", before: "x", node: { type: "shell" } }]), "unknown_node");
  });

  it("supports a multi-op 'simplify' patch that keeps the result valid", () => {
    const graph = g(
      [
        { id: "plan", type: "prompt", config: { prompt: "plan" } },
        { id: "impl", type: "prompt", x: 300, config: { prompt: "implement" } },
        { id: "test1", x: 600, config: { run: "pnpm test" } },
        { id: "test2", x: 900, config: { run: "pnpm test" } },
      ],
      [{ source: "plan", target: "impl" }, { source: "impl", target: "test1" }, { source: "test1", target: "test2" }],
    );
    const res = applyGraphPatch(graph, [
      { op: "update_node", id: "plan", config: { prompt: "plan, then implement" } },
      { op: "remove_node", id: "impl" },
      { op: "remove_node", id: "test2" },
    ]);
    expect(pairs(res.graph)).toEqual(["plan>test1"]);
    expect(res.removed).toEqual(["impl", "test2"]);
    expect(res.updated).toEqual(["plan"]);
    expect(validateGraph(res.graph).errors).toEqual([]);
  });
});

describe("layout helpers", () => {
  it("isLaidOut: true once every node sits where layeredLayout puts it (half-pixel tolerance)", () => {
    const graph = g([{ id: "a", x: 500, y: 500 }, { id: "b" }], [{ source: "a", target: "b" }]);
    expect(isLaidOut(graph)).toBe(false);
    const pos = layeredLayout(graph);
    const arranged = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: { x: pos.get(n.id)!.x + 0.2, y: pos.get(n.id)!.y } })) };
    expect(isLaidOut(arranged)).toBe(true);
    expect(isLaidOut(g([]))).toBe(true);
  });

  it("layeredLayout places rows by longest path", () => {
    const graph = g([{ id: "a" }, { id: "b" }, { id: "c" }], [{ source: "a", target: "b" }, { source: "a", target: "c" }, { source: "b", target: "c" }]);
    const pos = layeredLayout(graph);
    expect(pos.get("c")).toEqual({ x: 0, y: 2 * LAYOUT_DY });
  });

  it("layeredLayout keeps a condition's true branch left of its false branch", () => {
    const graph = g(
      [{ id: "cond" }, { id: "onFalse" }, { id: "onTrue" }],
      [{ source: "cond", target: "onFalse", sourcePort: "false" }, { source: "cond", target: "onTrue", sourcePort: "true" }],
    );
    const pos = layeredLayout(graph);
    expect(pos.get("onTrue")!.x).toBeLessThan(pos.get("onFalse")!.x);
  });

  it("layeredLayout orders a row under its parents so edges do not cross", () => {
    const graph = g(
      [{ id: "l" }, { id: "r" }, { id: "underR" }, { id: "underL" }],
      [{ source: "l", target: "underL" }, { source: "r", target: "underR" }],
    );
    const pos = layeredLayout(graph);
    expect(pos.get("underL")!.x).toBe(pos.get("l")!.x);
    expect(pos.get("underR")!.x).toBe(pos.get("r")!.x);
  });

  it("layeredLayout puts error handlers beside their source, to the right", () => {
    const graph = g(
      [{ id: "a" }, { id: "notify" }, { id: "b" }],
      [{ source: "a", target: "notify", sourcePort: "error" }, { source: "a", target: "b" }],
    );
    const pos = layeredLayout(graph);
    expect(pos.get("a")).toEqual({ x: -LAYOUT_DX / 2, y: 0 });
    expect(pos.get("notify")).toEqual({ x: LAYOUT_DX / 2, y: 0 });
    expect(pos.get("b")).toEqual({ x: 0, y: LAYOUT_DY });
  });

  it("deriveEdgeId encodes non-default ports and avoids used ids", () => {
    expect(deriveEdgeId({ source: "a", target: "b" }, new Set())).toBe("e-a-b");
    expect(deriveEdgeId({ source: "a", target: "b", sourcePort: "error" }, new Set())).toBe("e-a-error-b");
    expect(deriveEdgeId({ source: "a", target: "b" }, new Set(["e-a-b", "e-a-b-2"]))).toBe("e-a-b-3");
  });
});
