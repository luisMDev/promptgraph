import { describe, expect, it } from "vitest";
import {
  GraphSchema,
  computeLanePlan,
  costFromUsage,
  defaultNodeConfig,
  edgeMatches,
  validateGraph,
  type Graph,
  type GraphInput,
  type ValidationCode,
} from "../src/index.js";

type N = { id: string; type: string; x?: number; y?: number; config?: Record<string, unknown>; label?: string };
type E = { id?: string; source: string; target: string; sourcePort?: string; when?: string; loop?: { maxIterations: number } };

function g(nodes: N[], edges: E[] = [], settings: Record<string, unknown> = {}): Graph {
  const input = {
    version: 1,
    id: "test",
    name: "Test",
    settings,
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      label: n.label ?? n.id,
      position: { x: n.x ?? i * 100, y: n.y ?? 0 },
      config: n.config ?? defaultConfigFor(n.type),
    })),
    edges: edges.map((e, i) => ({ id: e.id ?? `e${i}`, ...e })),
  } as GraphInput;
  return GraphSchema.parse(input);
}

function defaultConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "prompt":
      return { prompt: "do it" };
    case "command":
      return { command: "/simplify" };
    case "shell":
      return { run: "true" };
    default:
      return {};
  }
}

const codes = (r: { code: ValidationCode }[]) => r.map((i) => i.code);

describe("schema defaults", () => {
  it("fills node config and settings defaults", () => {
    const graph = g([{ id: "a", type: "prompt", config: { prompt: "x" } }, { id: "c", type: "commit" }]);
    expect(graph.settings).toMatchObject({
      baseBranch: "main",
      maxParallelClaude: 3,
      keepWorktrees: "on-failure",
      autoTrustWorktrees: true,
      defaults: { permissionMode: "acceptEdits", completion: { mode: "auto", graceSec: 5 } },
    });
    expect(graph.nodes[0]!.config).toMatchObject({ prompt: "x", context: "fresh" });
    expect(graph.nodes[1]!.config).toEqual({ generateMessage: true, squashCheckpoints: true });
    expect(defaultNodeConfig("pr")).toEqual({ draft: true, requireApproval: true });
    expect(defaultNodeConfig("condition")).toEqual({ evaluator: { kind: "exitCode", equals: 0 } });
  });
});

describe("validateGraph", () => {
  it("accepts a valid linear graph", () => {
    const r = validateGraph(
      g([{ id: "a", type: "prompt" }, { id: "b", type: "shell" }, { id: "c", type: "commit" }], [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ]),
    );
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it("rejects an empty graph", () => {
    expect(codes(validateGraph(g([])).errors)).toEqual(["empty_graph"]);
  });

  it("detects cycles but ignores loop edges", () => {
    const nodes: N[] = [{ id: "a", type: "prompt" }, { id: "b", type: "shell" }];
    const cyclic = validateGraph(g(nodes, [{ source: "a", target: "b" }, { source: "b", target: "a" }]));
    expect(codes(cyclic.errors)).toContain("cycle");
    const loop = validateGraph(
      g(nodes, [{ source: "a", target: "b" }, { source: "b", target: "a", loop: { maxIterations: 3 } }]),
    );
    expect(loop.errors).toEqual([]);
  });

  it("phrases the cycle fix for the phase: loops exist only in phase 2", () => {
    const nodes: N[] = [{ id: "a", type: "prompt" }, { id: "b", type: "shell" }];
    const edges = [{ source: "a", target: "b" }, { source: "b", target: "a" }];
    const cycle = (phase: 1 | 2) => validateGraph(g(nodes, edges), { phase }).errors.find((e) => e.code === "cycle")!.message;
    expect(cycle(2)).toContain("Mark a back-edge as a loop");
    expect(cycle(1)).toContain("Remove one of these edges");
  });

  it("rejects node types the engine does not support yet", () => {
    const graph = g([{ id: "a", type: "prompt" }, { id: "p", type: "approval" }], [{ source: "a", target: "p" }]);
    expect(validateGraph(graph).errors).toEqual([]);
    const r = validateGraph(graph, { supportedNodeTypes: ["prompt", "command", "shell", "commit"] });
    expect(r.errors).toEqual([expect.objectContaining({ code: "unsupported_node_type", nodeId: "p" })]);
  });

  it("rejects an empty marker token on nodes and in the graph defaults", () => {
    const marker = { mode: "marker", token: " " };
    const node = validateGraph(g([{ id: "a", type: "prompt", config: { prompt: "x", completion: marker } }]));
    expect(node.errors).toEqual([expect.objectContaining({ code: "invalid_config", nodeId: "a" })]);
    const defaults = validateGraph(g([{ id: "a", type: "command", config: { command: "/x" } }], [], { defaults: { completion: marker } }));
    expect(codes(defaults.errors)).toEqual(["invalid_config"]);
  });

  it("rejects loop edges that do not point to an ancestor", () => {
    const r = validateGraph(
      g([{ id: "a", type: "prompt" }, { id: "b", type: "shell" }, { id: "c", type: "shell" }], [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "c", loop: { maxIterations: 2 } },
      ]),
    );
    expect(codes(r.errors)).toContain("invalid_loop");
  });

  it("rejects non-merge multi-input nodes and accepts merge joins", () => {
    const nodes: N[] = [
      { id: "a", type: "prompt", y: 0 },
      { id: "b", type: "prompt", y: 100 },
      { id: "j", type: "shell", x: 300 },
    ];
    const bad = validateGraph(g(nodes, [{ source: "a", target: "j" }, { source: "b", target: "j" }]));
    expect(codes(bad.errors)).toEqual(["invalid_join"]);

    const merge = validateGraph(
      g([...nodes.slice(0, 2), { id: "m", type: "merge", x: 300 }], [
        { source: "a", target: "m" },
        { source: "b", target: "m" },
      ]),
    );
    expect(merge.errors).toEqual([]);
  });

  it("requires two inputs on merge nodes", () => {
    const r = validateGraph(g([{ id: "a", type: "prompt" }, { id: "m", type: "merge" }], [{ source: "a", target: "m" }]));
    expect(codes(r.errors)).toContain("merge_input_count");
  });

  it("allows joins of mutually exclusive condition branches in phase 2 only", () => {
    const graph = g(
      [
        { id: "t", type: "shell" },
        { id: "c", type: "condition" },
        { id: "fix", type: "prompt", y: 0 },
        { id: "ok", type: "prompt", y: 100 },
        { id: "j", type: "shell", x: 500 },
      ],
      [
        { source: "t", target: "c" },
        { source: "c", sourcePort: "true", target: "ok" },
        { source: "c", sourcePort: "false", target: "fix" },
        { source: "ok", target: "j" },
        { source: "fix", target: "j" },
      ],
    );
    expect(validateGraph(graph, { phase: 2 }).errors).toEqual([]);
    const p1 = codes(validateGraph(graph, { phase: 1 }).errors);
    expect(p1).toContain("phase2_unsupported");
    expect(p1).toContain("invalid_join");
  });

  it("allows success/failure branch joins in phase 2", () => {
    const graph = g(
      [
        { id: "build", type: "shell" },
        { id: "fix", type: "prompt", y: 100 },
        { id: "next", type: "shell", x: 400 },
      ],
      [
        { source: "build", target: "next" },
        { source: "build", sourcePort: "error", target: "fix" },
        { source: "fix", target: "next" },
      ],
    );
    expect(validateGraph(graph).errors).toEqual([]);
  });

  it("validates ports", () => {
    const r = validateGraph(
      g([{ id: "a", type: "shell" }, { id: "b", type: "shell" }], [{ source: "a", sourcePort: "true", target: "b" }]),
    );
    expect(codes(r.errors)).toContain("invalid_port");
    const r2 = validateGraph(
      g([{ id: "a", type: "shell" }, { id: "b", type: "shell" }], [
        { source: "a", sourcePort: "error", when: "success", target: "b" },
      ]),
    );
    expect(codes(r2.errors)).toContain("invalid_port");
  });

  it("flags dangling edges, self loops, duplicates", () => {
    const r = validateGraph(
      g([{ id: "a", type: "shell" }, { id: "b", type: "shell" }], [
        { id: "x", source: "a", target: "zzz" },
        { id: "y", source: "a", target: "a" },
        { id: "z", source: "a", target: "b" },
        { id: "z", source: "a", target: "b" },
      ]),
    );
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["dangling_edge", "self_loop", "duplicate_edge_id", "duplicate_edge"]));
  });

  it("reports missing required config", () => {
    const r = validateGraph(
      g([
        { id: "p", type: "prompt", config: { prompt: " " } },
        { id: "c", type: "command", config: { command: "simplify" } },
        { id: "s", type: "shell", config: { run: "" } },
        { id: "k", type: "commit", config: { generateMessage: false } },
        { id: "j", type: "condition", config: { evaluator: { kind: "judge", question: "" } } },
        { id: "r", type: "condition", config: { evaluator: { kind: "regex", pattern: "(" } } },
      ]),
    );
    // (The unconnected conditions also report condition_input.)
    const byNode = Object.fromEntries(r.errors.filter((e) => e.code !== "condition_input").map((e) => [e.nodeId, e.code]));
    expect(byNode).toEqual({
      p: "missing_config",
      c: "invalid_config",
      s: "missing_config",
      k: "missing_config",
      j: "missing_config",
      r: "invalid_config",
    });
  });

  it("requires approval on pr nodes unless unlocked", () => {
    const nodes: N[] = [{ id: "p", type: "pr", config: { requireApproval: false } }];
    expect(codes(validateGraph(g(nodes)).errors)).toEqual(["pr_requires_approval"]);
    expect(validateGraph(g(nodes, [], { allowPrWithoutApproval: true })).errors).toEqual([]);
  });

  it("rejects branch prefixes that are not plain ref names", () => {
    const nodes: N[] = [{ id: "a", type: "shell", config: { run: "true" } }];
    for (const ok of ["", "pg/x", "feature/my_team-1.2", " pg "]) expect(validateGraph(g(nodes, [], { branchPrefix: ok })).errors).toEqual([]);
    for (const bad of ["+pg", "-pg", ":pg", "pg/../x", "a b", "pg/", "/pg", "pg.lock", "pg/.x", "x."]) {
      expect(codes(validateGraph(g(nodes, [], { branchPrefix: bad })).errors), bad).toEqual(["invalid_config"]);
    }
  });

  describe("resume context", () => {
    const resume = { prompt: "continue", context: "resume" };
    it("is valid after a single Claude predecessor in the same lane", () => {
      const r = validateGraph(
        g([{ id: "a", type: "prompt" }, { id: "b", type: "prompt", config: resume }], [{ source: "a", target: "b" }]),
      );
      expect(r.errors).toEqual([]);
    });
    it("is invalid without predecessor, after non-Claude nodes, or across lanes", () => {
      const root = validateGraph(g([{ id: "b", type: "prompt", config: resume }]));
      expect(codes(root.errors)).toEqual(["invalid_resume_context"]);

      const afterShell = validateGraph(
        g([{ id: "a", type: "shell" }, { id: "b", type: "prompt", config: resume }], [{ source: "a", target: "b" }]),
      );
      expect(codes(afterShell.errors)).toEqual(["invalid_resume_context"]);

      // Fan-out: first target by canvas order (y=0) keeps the lane, the other forks a new lane.
      const fan = validateGraph(
        g(
          [
            { id: "a", type: "prompt", x: 0 },
            { id: "keep", type: "prompt", x: 200, y: 0, config: resume },
            { id: "fork", type: "prompt", x: 200, y: 100, config: resume },
          ],
          [
            { source: "a", target: "fork" },
            { source: "a", target: "keep" },
          ],
        ),
      );
      expect(fan.errors.map((e) => [e.nodeId, e.code])).toEqual([["fork", "invalid_resume_context"]]);
    });
  });

  describe("uncommitted work warnings (§18 Q1)", () => {
    it("warns for pr after work without commit", () => {
      const r = validateGraph(g([{ id: "a", type: "prompt" }, { id: "p", type: "pr" }], [{ source: "a", target: "p" }]));
      expect(r.errors).toEqual([]);
      expect(codes(r.warnings)).toEqual(["uncommitted_before_pr"]);
    });
    it("does not warn when a commit precedes the pr", () => {
      const r = validateGraph(
        g([{ id: "a", type: "prompt" }, { id: "c", type: "commit" }, { id: "ap", type: "approval" }, { id: "p", type: "pr" }], [
          { source: "a", target: "c" },
          { source: "c", target: "ap" },
          { source: "ap", target: "p" },
        ]),
      );
      expect(r.warnings).toEqual([]);
    });
    it("does not warn for a merge whose input lanes all end with a commit", () => {
      const r = validateGraph(
        g(
          [
            { id: "a", type: "prompt", y: 0 },
            { id: "ca", type: "commit", y: 0, x: 100 },
            { id: "b", type: "shell", y: 100 },
            { id: "cb", type: "commit", y: 100, x: 100 },
            { id: "m", type: "merge", x: 300 },
          ],
          [
            { source: "a", target: "ca" },
            { source: "ca", target: "m" },
            { source: "b", target: "cb" },
            { source: "cb", target: "m" },
          ],
        ),
      );
      expect(r).toEqual({ errors: [], warnings: [] });
    });
    it("warns for merge when an input lane has uncommitted work", () => {
      const r = validateGraph(
        g(
          [
            { id: "a", type: "prompt", y: 0 },
            { id: "ca", type: "commit", y: 0, x: 100 },
            { id: "b", type: "prompt", y: 100 },
            { id: "m", type: "merge", x: 300 },
          ],
          [
            { source: "a", target: "ca" },
            { source: "ca", target: "m" },
            { source: "b", target: "m" },
          ],
        ),
      );
      expect(codes(r.warnings)).toEqual(["uncommitted_before_merge"]);
    });
  });
});

describe("computeLanePlan", () => {
  it("assigns lanes for fan-out and merge", () => {
    const graph = g(
      [
        { id: "a", type: "prompt", x: 0 },
        { id: "b", type: "prompt", x: 100, y: 0 },
        { id: "c", type: "prompt", x: 100, y: 100 },
        { id: "d", type: "prompt", x: 100, y: 200 },
        { id: "m", type: "merge", x: 200 },
        { id: "r2", type: "shell", x: 0, y: 500 },
      ],
      [
        { source: "a", target: "c" },
        { source: "a", target: "b" },
        { source: "a", target: "d" },
        { source: "b", target: "m" },
        { source: "c", target: "m" },
        { source: "d", target: "m" },
      ],
    );
    const plan = computeLanePlan(graph);
    expect(Object.fromEntries(plan.laneOf)).toEqual({ a: "main", r2: "l2", b: "main", c: "l3", d: "l4", m: "main" });
    expect(plan.mergeSources.get("m")).toEqual(["l3", "l4"]);
    expect(plan.lanes.find((l) => l.id === "l3")).toMatchObject({ parentLaneId: "main", forkAfterNodeId: "a", firstNodeId: "c" });
    expect(plan.lanes.find((l) => l.id === "l2")).toMatchObject({ parentLaneId: null, firstNodeId: "r2" });
  });

  it("continues a merge in the lane of its first input by canvas position", () => {
    const nodes = (bY: number): N[] => [
      { id: "a", type: "prompt", x: 0, y: 0 },
      { id: "b", type: "prompt", x: 0, y: bY },
      { id: "m", type: "merge", x: 200 },
    ];
    const edges = [
      { source: "a", target: "m" },
      { source: "b", target: "m" },
    ];
    const below = computeLanePlan(g(nodes(100), edges));
    expect(Object.fromEntries(below.laneOf)).toEqual({ a: "main", b: "l2", m: "main" });
    expect(below.mergeSources.get("m")).toEqual(["l2"]);
    // Moving b above a makes b the first root and the merge's first input.
    const above = computeLanePlan(g(nodes(-100), edges));
    expect(Object.fromEntries(above.laneOf)).toEqual({ b: "main", a: "l2", m: "main" });
    expect(above.mergeSources.get("m")).toEqual(["l2"]);
  });

  it("records the lane each edge grants, including fork lanes that start at a merge", () => {
    const graph = g(
      [
        { id: "a", type: "prompt", x: 0 },
        { id: "b", type: "prompt", x: -100, y: 100 },
        { id: "m", type: "merge", x: 200 },
      ],
      [
        { id: "ab", source: "a", target: "b" },
        { id: "am", source: "a", target: "m" },
        { id: "bm", source: "b", target: "m" },
      ],
    );
    const plan = computeLanePlan(graph);
    expect(Object.fromEntries(plan.edgeLane)).toEqual({ ab: "main", am: "l2", bm: "main" });
    expect(plan.lanes.find((l) => l.id === "l2")).toMatchObject({ parentLaneId: "main", forkAfterNodeId: "a", firstNodeId: "m" });
    expect(plan.laneOf.get("m")).toBe("main");
    expect(plan.mergeSources.get("m")).toEqual(["l2"]);
  });

  it("keeps condition branches in the same lane", () => {
    const graph = g(
      [
        { id: "c", type: "condition" },
        { id: "t", type: "shell", y: 0 },
        { id: "f", type: "shell", y: 100 },
      ],
      [
        { source: "c", sourcePort: "true", target: "t" },
        { source: "c", sourcePort: "false", target: "f" },
      ],
    );
    const plan = computeLanePlan(graph);
    expect(plan.lanes).toHaveLength(1);
    expect(new Set(plan.laneOf.values())).toEqual(new Set(["main"]));
  });
});

describe("edgeMatches", () => {
  const base = { id: "e", source: "a", target: "b", targetPort: "in" as const };
  it("matches success/failure/always and condition ports", () => {
    expect(edgeMatches({ ...base, sourcePort: "out" }, { kind: "success" })).toBe(true);
    expect(edgeMatches({ ...base, sourcePort: "out" }, { kind: "failure" })).toBe(false);
    expect(edgeMatches({ ...base, sourcePort: "error" }, { kind: "failure" })).toBe(true);
    expect(edgeMatches({ ...base, sourcePort: "out", when: "always" }, { kind: "failure" })).toBe(true);
    expect(edgeMatches({ ...base, sourcePort: "true" }, { kind: "success", port: "true" })).toBe(true);
    expect(edgeMatches({ ...base, sourcePort: "true" }, { kind: "success", port: "false" })).toBe(false);
  });
});

describe("costFromUsage", () => {
  it("matches Claude Code's reported cost for opus 5.5 with a 1h cache write", () => {
    // Real `claude -p --output-format json` envelope: total_cost_usd 0.1756.
    const cost = costFromUsage("claude-opus-5-5", {
      input_tokens: 2,
      output_tokens: 76,
      cache_creation_input_tokens: 21759,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 21759, ephemeral_5m_input_tokens: 0 },
    });
    expect(cost).toBeCloseTo(0.1756, 4);
  });
  it("resolves aliases and returns 0 for unknown models", () => {
    expect(costFromUsage("opus", { output_tokens: 1_000_000 })).toBe(20);
    expect(costFromUsage("claude-opus-5-5[1m]", { input_tokens: 1_000_000 })).toBe(4);
    expect(costFromUsage("gpt-9", { input_tokens: 1000 })).toBe(0);
  });
});
