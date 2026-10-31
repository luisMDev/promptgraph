import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusEvents } from "../src/events/bus.js";
import { EngineError } from "../src/engine/engine.js";
import { runWorkspaceSetup } from "../src/workspace/setup.js";
import { waitFor } from "./helpers.js";
import { allTypes, FakeRunner, makeGraph, runStatus, setup, statusOf, waitRun } from "./support/engine-fakes.js";

vi.mock("../src/workspace/setup.js", () => ({ runWorkspaceSetup: vi.fn() }));

afterEach(() => {
  vi.mocked(runWorkspaceSetup).mockReset();
});

// ---------------------------------------------------------------------------

describe("Engine.startRun", () => {
  it("runs a linear graph to success, passing predecessor outputs and emitting updates", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", type: "shell" }, { id: "c", type: "commit" }], [["a", "b"], ["b", "c"]]));

    const detail = await s.engine.startRun("flow");
    expect(detail.run.status).toBe("running");
    expect(detail.nodeRuns).toHaveLength(3);
    expect(detail.lanes.map((l) => l.id)).toEqual(["main"]);
    expect(s.lanes.calls[0]).toBe("create:main:main");

    await waitRun(s, detail.run.id, "succeeded");
    expect(statusOf(s, detail.run.id)).toEqual({ a: "succeeded", b: "succeeded", c: "succeeded" });
    expect(runner.started.map((e) => e.ctx.node.id)).toEqual(["a", "b", "c"]);
    const b = runner.last("b")!.ctx;
    expect(b.predecessors).toEqual([expect.objectContaining({ nodeId: "a", label: "A", status: "succeeded", output: { text: "out:a" } })]);
    expect(b.nodeRun.status).toBe("running");
    expect(b.lane.id).toBe("main");
    expect(b.previousAttempt).toBeNull();
    expect(s.store.getNodeRun(runner.last("c")!.ctx.nodeRun.id)!.output).toEqual({ text: "out:c" });
    // §6.1: a commit's message describes every node since the previous commit, not only its direct input.
    expect(runner.last("c")!.ctx.laneOutputs.map((p) => p.nodeId)).toEqual(["a", "b"]);
    expect(s.lanes.calls.at(-1)).toBe("cleanup:on-failure:false");
    expect(s.store.getRun(detail.run.id)!.finishedAt).not.toBeNull();
    expect(s.store.getKnownGraphHash(s.graphs.repoPath, "flow")).toBe(s.graphs.get("flow").hash);

    const nodeUpdates = s.events.filter((e) => e.name === "node:update");
    expect(nodeUpdates.length).toBeGreaterThan(6);
    const lastRun = s.events.filter((e) => e.name === "run:update").at(-1)!.payload as BusEvents["run:update"];
    expect(lastRun.run).toMatchObject({ status: "succeeded", cleanedUp: true });
    const types = s.store.listEvents(detail.run.id).map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("node.status");
    expect(types.at(-1)).toBe("run.status");
  });

  it("rejects missing, invalid and unparsable graphs, and a second active run", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    await expect(s.engine.startRun("nope")).rejects.toMatchObject({ code: "not_found" });

    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [["a", "c"], ["b", "c"]])); // non-merge join
    const err = await s.engine.startRun("flow").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: "validation_failed", details: { errors: [expect.objectContaining({ code: "invalid_join" })] } });

    fs.writeFileSync(path.join(s.graphs.repoPath, ".promptgraph", "graphs", "broken.json"), "{");
    await expect(s.engine.startRun("broken")).rejects.toMatchObject({ code: "load_error" });

    s.graphs.save(makeGraph([{ id: "a" }], []));
    const first = await s.engine.startRun("flow");
    await expect(s.engine.startRun("flow")).rejects.toMatchObject({ code: "run_active" });
    expect(s.engine.activeRunForGraph("flow")).toBe(first.run.id);
  });

  it("keeps the run snapshot immutable and blocks graph edits while the run is active", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    const graph = makeGraph([{ id: "a" }], []);
    s.graphs.save(graph);
    const { run } = await s.engine.startRun("flow");

    expect(() => s.graphs.save({ ...graph, name: "Renamed" })).toThrow(EngineError);
    expect(() => s.graphs.delete("flow")).toThrow(/active run/);
    // Even an external edit does not reach the running run.
    fs.writeFileSync(path.join(s.graphs.repoPath, ".promptgraph", "graphs", "flow.json"), JSON.stringify({ ...graph, name: "Outside" }));
    await waitFor(() => runner.started.length === 1);
    expect(s.engine.getRun(run.id).run.graphSnapshot.name).toBe("Flow");
    expect(runner.started[0]!.ctx.run.graphSnapshot.name).toBe("Flow");

    runner.started[0]!.succeed();
    await waitRun(s, run.id, "succeeded");
    expect(s.engine.activeRunForGraph("flow")).toBeNull();
    expect(() => s.graphs.save({ ...graph, name: "Renamed" })).not.toThrow();
  });

  it("fails the run when the root workspace cannot be created", async () => {
    const s = setup(allTypes(new FakeRunner()));
    s.lanes.failCreate = "worktree add failed";
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("worktree add failed");
    expect(statusOf(s, run.id)).toEqual({ a: "cancelled", b: "cancelled" });
  });

  it("refuses graphs with node types that have no runner", async () => {
    const s = setup({ prompt: new FakeRunner() });
    expect(s.engine.supportedNodeTypes()).toEqual(["prompt"]);
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", type: "shell" }], [["a", "b"]]));
    const err = await s.engine.startRun("flow").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "validation_failed", details: { errors: [expect.objectContaining({ code: "unsupported_node_type", nodeId: "b" })] } });
  });

  it("stops collecting commit-message context at the previous commit node", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [{ id: "a" }, { id: "c1", type: "commit" }, { id: "b", type: "shell" }, { id: "c2", type: "commit" }],
        [["a", "c1"], ["c1", "b"], ["b", "c2"]],
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(runner.last("c2")!.ctx.laneOutputs.map((p) => p.nodeId)).toEqual(["b"]);
  });

  it("collects commit-message context through merges into every merged lane (§6.1)", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a", x: 0 },
          { id: "b", x: 200, y: 0 },
          { id: "c", x: 200, y: 100 },
          { id: "m", type: "merge", x: 400 },
          { id: "commit", type: "commit", x: 600 },
        ],
        [["a", "b"], ["a", "c"], ["b", "m"], ["c", "m"], ["m", "commit"]],
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(runner.last("commit")!.ctx.laneOutputs.map((p) => p.nodeId)).toEqual(["a", "b", "c"]);
  });
});

describe("Engine DAG scheduling", () => {
  it("forks lanes after a checkpoint, caps Claude concurrency and joins at a merge", async () => {
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.type !== "prompt") queueMicrotask(() => e.succeed());
    });
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a", x: 0 },
          { id: "b", x: 200, y: 0 },
          { id: "c", x: 200, y: 100 },
          { id: "d", x: 200, y: 200 },
          { id: "m", type: "merge", x: 400 },
        ],
        [["a", "b"], ["a", "c"], ["a", "d"], ["b", "m"], ["c", "m"], ["d", "m"]],
        { maxParallelClaude: 2 },
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    runner.last("a")!.succeed();

    await waitFor(() => runner.started.length === 3);
    expect(runner.started.map((e) => e.ctx.node.id)).toEqual(["a", "b", "c"]);
    expect(statusOf(s, run.id)).toMatchObject({ b: "running", c: "running", d: "ready", m: "pending" });
    // Fork lanes are created from the checkpointed parent head before the successors start.
    expect(s.lanes.calls.filter((c) => c.startsWith("checkpoint"))).toEqual(["checkpoint:main:A", "checkpoint:main:A"]);
    expect(s.lanes.calls.filter((c) => c.startsWith("create:l"))).toEqual([
      expect.stringMatching(/^create:l2:head-main-/),
      expect.stringMatching(/^create:l3:head-main-/),
    ]);
    expect(runner.last("b")!.ctx.lane.id).toBe("main");
    expect(runner.last("c")!.ctx.lane.id).toBe("l2");

    runner.last("c")!.succeed();
    await waitFor(() => runner.last("d"));
    expect(runner.last("d")!.ctx.lane.id).toBe("l3");
    runner.last("d")!.succeed();
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.last("m")).toBeUndefined(); // still waiting for b
    runner.last("b")!.succeed();
    await waitRun(s, run.id, "succeeded");
    expect(runner.last("m")!.ctx.predecessors.map((p) => p.nodeId)).toEqual(["b", "c", "d"]);
    expect(runner.last("m")!.ctx.lane.id).toBe("main");
  });

  it("checkpoints the lane before a pr node (§18 Q1)", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a", label: "Implement" }, { id: "p", type: "pr" }], [["a", "p"]]));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(s.lanes.calls).toContain("checkpoint:main:Implement");
  });

  it("runs workspace setup once per new lane, failing the node when it fails", async () => {
    vi.mocked(runWorkspaceSetup).mockResolvedValueOnce({ ok: false, exitCode: 3, ptyId: "setup-x" });
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]], { workspaceSetup: "pnpm install" }));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    const a = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "a")!;
    expect(a).toMatchObject({ status: "failed", laneSetup: "failed", error: expect.stringContaining("exit code 3") });
    expect(vi.mocked(runWorkspaceSetup)).toHaveBeenCalledWith(expect.objectContaining({ command: "pnpm install", nodeRunId: a.id }));
    expect(runner.started).toHaveLength(0);

    // A retry runs the setup again (it never succeeded), then only once per lane.
    vi.mocked(runWorkspaceSetup).mockResolvedValue({ ok: true, exitCode: 0, ptyId: "setup-y" });
    await s.engine.retry(a.id);
    await waitRun(s, run.id, "succeeded");
    expect(vi.mocked(runWorkspaceSetup)).toHaveBeenCalledTimes(2);
  });

  it("re-runs a lane's setup after a restart when it never completed", async () => {
    vi.mocked(runWorkspaceSetup).mockResolvedValueOnce({ ok: false, exitCode: 1, ptyId: "setup-x" });
    const s = setup(allTypes(new FakeRunner()));
    s.graphs.save(makeGraph([{ id: "a" }], [], { workspaceSetup: "pnpm install" }));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    vi.mocked(runWorkspaceSetup).mockResolvedValue({ ok: true, exitCode: 0, ptyId: "setup-y" });
    const engine = s.makeEngine(allTypes(new FakeRunner()));
    await engine.recover();
    await engine.retry(s.store.listNodeRuns(run.id)[0]!.id);
    await waitRun(s, run.id, "succeeded");
    expect(vi.mocked(runWorkspaceSetup)).toHaveBeenCalledTimes(2);
  });
});

describe("Engine lanes (§9)", () => {
  it("gives every root its own lane from baseBranch and passes checkpointed merge sources", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 0, y: 100 },
          { id: "m", type: "merge", x: 200 },
        ],
        [["a", "m"], ["b", "m"]],
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(s.lanes.calls.filter((c) => c.startsWith("create"))).toEqual(["create:main:main", "create:l2:main"]);
    const m = runner.last("m")!.ctx;
    expect(m.lane.id).toBe("main");
    expect(m.mergeSources.map((l) => [l.id, l.branch])).toEqual([["l2", `pg/flow/${run.shortId}/l2`]]);
    // §9.3: every lane the merge reads is checkpointed first, labelled after its input node.
    expect(s.lanes.calls.filter((c) => c.startsWith("checkpoint"))).toEqual(["checkpoint:main:A", "checkpoint:l2:B"]);
    expect(runner.last("a")!.ctx.mergeSources).toEqual([]);
    expect(s.engine.getRun(run.id).lanes.map((l) => [l.id, l.index, l.status])).toEqual([
      ["main", 0, "active"],
      ["l2", 1, "active"],
    ]);
  });

  it("forks the lane of a fan-out edge straight into a merge when the parent finishes", async () => {
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.id !== "b") queueMicrotask(() => e.succeed());
    });
    const s = setup(allTypes(runner));
    // b sits left of a, so it is the merge's first input (lane main) and a→m grants fork lane l2.
    s.graphs.save(
      makeGraph(
        [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: -200, y: 100 },
          { id: "m", type: "merge", x: 200 },
        ],
        [["a", "b"], ["a", "m"], ["b", "m"]],
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("b"));
    // l2 captured a's state before b could change the parent lane.
    expect(s.lanes.calls).toEqual(["create:main:main", "checkpoint:main:A", expect.stringMatching(/^create:l2:head-main-/)]);
    runner.last("b")!.succeed();
    await waitRun(s, run.id, "succeeded");
    expect(runner.last("m")!.ctx.lane.id).toBe("main");
    expect(runner.last("m")!.ctx.mergeSources.map((l) => l.id)).toEqual(["l2"]);
  });

  it("resets a lane left mid-merge before a merge node checkpoints it", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 100 }, { id: "m", type: "merge", x: 200 }], [["a", "m"], ["b", "m"]]));
    s.lanes.midMerge.add("main");
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    const calls = s.lanes.calls.filter((c) => /^(reset-merge|checkpoint):main/.test(c));
    expect(calls).toEqual(["reset-merge:main", "checkpoint:main:A"]);
    const m = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "m")!;
    expect(s.store.listEvents(run.id).filter((e) => e.nodeRunId === m.id).map((e) => e.type)).toContain("merge:reset_interrupted");
  });

  it("passes the fork points of lanes not merged yet to the runners", async () => {
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.id !== "c") queueMicrotask(() => e.succeed());
    });
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a", x: 0 },
          { id: "b", type: "commit", x: 200, y: 0 },
          { id: "c", x: 200, y: 100 },
        ],
        [["a", "b"], ["a", "c"]],
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("b") && runner.last("c"));
    const l2 = s.store.getLane(run.id, "l2")!;
    expect(runner.last("b")!.ctx.forkPoints).toEqual([l2.baseRef]);
    expect(runner.last("c")!.ctx.forkPoints).toEqual([]);
    runner.last("c")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });

  it("gives pr runners their base branch", async () => {
    const runner = new FakeRunner();
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a" },
          { id: "p", type: "pr", config: { base: "release" } },
          { id: "q", type: "pr", x: 400, y: 100, config: { base: "  " } },
        ],
        [["a", "p"], ["a", "q"]],
        { baseBranch: "develop" },
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(runner.last("a")!.ctx.baseBranch).toBe("develop");
    expect(runner.last("p")!.ctx.baseBranch).toBe("release");
    expect(runner.last("q")!.ctx).toMatchObject({ baseBranch: "develop", lane: { id: "l2" } });
    // The approval dialog shows the same base, and the diff of what the push publishes against it.
    const [p, q] = [runner.last("p")!.ctx.nodeRun.id, runner.last("q")!.ctx.nodeRun.id];
    expect((await s.engine.getApprovalInfo(p)).pr?.base).toBe("release");
    expect((await s.engine.getApprovalInfo(q)).pr?.base).toBe("develop");
    await s.engine.getDiff(p);
    await s.engine.getDiff(q);
    expect(s.lanes.calls.filter((c) => c.startsWith("diff:"))).toEqual(["diff:main:release:committed", "diff:l2:develop:committed"]);
  });

  it("merge nodes take a Claude slot under maxParallelClaude before resolving with Claude", async () => {
    const granted: string[] = [];
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.type === "prompt") return;
      if (e.ctx.node.type !== "merge") return queueMicrotask(() => e.succeed());
      void e.ctx.claudeSlot().then(
        () => granted.push("slot"),
        (err: Error) => granted.push(`rejected:${err.message}`),
      );
    });
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a", type: "shell", x: 0, y: 0 },
          { id: "b", type: "shell", x: 0, y: 100 },
          { id: "c", x: 0, y: 200 },
          { id: "m", type: "merge", x: 200 },
        ],
        [["a", "m"], ["b", "m"]],
        { maxParallelClaude: 1 },
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("m"));
    await new Promise((r) => setTimeout(r, 20));
    expect(granted).toEqual([]); // c holds the only slot
    runner.last("c")!.succeed();
    await waitFor(() => granted.length === 1);
    expect(granted).toEqual(["slot"]);
    runner.last("m")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });

  it("rejects a pending Claude slot when the run is cancelled", async () => {
    const granted: string[] = [];
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.type === "prompt") return;
      if (e.ctx.node.type !== "merge") return queueMicrotask(() => e.succeed());
      void e.ctx.claudeSlot().catch((err: Error) => granted.push(`rejected:${err.message}`));
    });
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [
          { id: "a", type: "shell", x: 0, y: 0 },
          { id: "b", type: "shell", x: 0, y: 100 },
          { id: "c", x: 0, y: 200 },
          { id: "m", type: "merge", x: 200 },
        ],
        [["a", "m"], ["b", "m"]],
        { maxParallelClaude: 1 },
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("m"));
    await s.engine.cancelRun(run.id);
    expect(granted).toEqual(["rejected:Cancelled"]);
  });
});

describe("Engine failure handling and manual controls", () => {
  it("onError pause: pauses when nothing else can progress; retry creates a new attempt", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("a"));
    runner.last("a")!.failWith("tests failed");
    await waitRun(s, run.id, "paused");
    expect(s.store.getRun(run.id)!.error).toContain("tests failed");
    expect(statusOf(s, run.id)).toEqual({ a: "failed", b: "pending" });

    const failed = runner.last("a")!.ctx.nodeRun;
    await expect(s.engine.done(failed.id)).rejects.toMatchObject({ code: "invalid_state" });
    const retried = await s.engine.retry(failed.id);
    expect(retried).toMatchObject({ attempt: 1, nodeId: "a" });
    expect(runStatus(s, run.id)).toBe("running");
    await waitFor(() => runner.byNode("a").length === 2);
    expect(runner.last("a")!.ctx.previousAttempt).toMatchObject({ id: failed.id, status: "failed" });
    await expect(s.engine.retry(failed.id)).rejects.toMatchObject({ code: "invalid_state" }); // not the latest attempt

    runner.last("a")!.succeed();
    await waitFor(() => runner.last("b"));
    runner.last("b")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });

  it("onError fail-run: cancels the other branches and fails the run", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(
      makeGraph(
        [{ id: "a", y: 0, onError: "fail-run" }, { id: "b", y: 100 }, { id: "c", y: 200 }],
        [],
        { maxParallelClaude: 2 },
      ),
    );
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 2);
    runner.last("a")!.failWith("bad");
    await waitRun(s, run.id, "failed");
    expect(s.store.getRun(run.id)!.error).toContain("bad");
    expect(statusOf(s, run.id)).toEqual({ a: "failed", b: "cancelled", c: "cancelled" });
    expect(runner.last("b")!.calls).toContain("cancel");
    expect(s.lanes.calls.at(-1)).toBe("cleanup:on-failure:true");
  });

  it("skip treats a failed node as success downstream", async () => {
    const runner = new FakeRunner((e) => queueMicrotask(() => (e.ctx.node.id === "a" ? e.failWith() : e.succeed())));
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    const a = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "a")!;
    await expect(s.engine.skip(a.id)).resolves.toMatchObject({ status: "skipped" });
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toEqual({ a: "skipped", b: "succeeded" });
    expect(s.store.getNodeRun(a.id)!.output).toMatchObject({ skippedByUser: true });
    await expect(s.engine.skip(a.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("skip on a pending node lets its successors run without it", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [["a", "b"], ["b", "c"]]));
    const { run } = await s.engine.startRun("flow");
    const b = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "b")!;
    await s.engine.skip(b.id);
    await waitFor(() => runner.last("c"));
    runner.last("c")!.succeed();
    await waitFor(() => runner.last("a"));
    runner.last("a")!.succeed();
    await waitRun(s, run.id, "succeeded");
    expect(runner.byNode("b")).toHaveLength(0);
  });

  it("forwards done/fail/hold/approval/user input to the live execution", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a", y: 0 }, { id: "g", type: "approval", y: 100 }, { id: "c", y: 200 }], []));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 3);
    const [a, g, c] = ["a", "g", "c"].map((id) => runner.last(id)!);

    await expect(s.engine.setHold(a!.ctx.nodeRun.id, true)).resolves.toMatchObject({ hold: true });
    expect(a!.calls).toContain("hold:true");
    s.engine.handleUserInput(a!.ctx.nodeRun.id);
    expect(a!.calls).toContain("input");

    await expect(s.engine.submitApproval(g!.ctx.nodeRun.id, { approved: true })).rejects.toMatchObject({ code: "invalid_state" });
    g!.ctx.update({ status: "waiting_approval" });
    await s.engine.submitApproval(g!.ctx.nodeRun.id, { approved: true });
    expect(g!.calls).toContain("approve:true");

    await s.engine.done(a!.ctx.nodeRun.id);
    await s.engine.fail(c!.ctx.nodeRun.id, "nope");
    expect(c!.calls).toContain("fail:nope");
    await waitRun(s, run.id, "paused");
    expect(statusOf(s, run.id)).toEqual({ a: "succeeded", g: "succeeded", c: "failed" });
    const actions = s.store.listEvents(run.id).filter((e) => e.type === "node.action").map((e) => (e.payload as { action: string }).action);
    expect(actions).toEqual(["hold", "approval", "done", "fail"]);
  });

  it("runner updates: attention once per transition, live usage in run:update, no final statuses", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }], []));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("a"));
    const ctx = runner.last("a")!.ctx;

    ctx.update({ status: "waiting_input", waitingReason: { kind: "notification", message: "Claude needs your permission" } });
    ctx.update({ status: "waiting_input" });
    ctx.update({ status: "running" });
    ctx.update({ status: "idle" });
    expect(s.attention.map((a) => [a.kind, a.message, a.nodeLabel, a.graphName])).toEqual([
      ["waiting_input", "Claude needs your permission", "A", "Flow"],
      ["idle", "Claude finished a turn", "A", "Flow"],
    ]);
    expect(() => ctx.update({ status: "succeeded" })).toThrow(/cannot set/);

    const usage = { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.12, model: "claude-opus-5-5" };
    ctx.update({ output: { usage } });
    const last = s.events.filter((e) => e.name === "run:update").at(-1)!.payload as BusEvents["run:update"];
    expect(last.run.usage.costUsd).toBeCloseTo(0.12);
    expect(last.run.waitingInput).toBe(1);

    ctx.event("custom.thing", { x: 1 });
    expect(s.store.listEvents(run.id).some((e) => e.type === "custom.thing" && e.nodeRunId === ctx.nodeRun.id)).toBe(true);

    runner.last("a")!.succeed({ text: "final" });
    await waitRun(s, run.id, "succeeded");
    // usage from the partial output survives the final output merge
    expect(s.store.getNodeRun(ctx.nodeRun.id)!.output).toEqual({ usage, text: "final" });
    // Late hooks after the node settled cannot change its status.
    expect(ctx.update({ status: "running" }).status).toBe("succeeded");
  });

  it("cancelRun stops live executions, cancels queued nodes and cleans up", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("a"));
    await s.engine.cancelRun(run.id);
    expect(runStatus(s, run.id)).toBe("cancelled");
    expect(statusOf(s, run.id)).toEqual({ a: "cancelled", b: "cancelled" });
    expect(runner.last("a")!.calls).toEqual(["cancel"]);
    expect(s.lanes.calls.at(-1)).toBe("cleanup:on-failure:true");
    await expect(s.engine.cancelRun(run.id)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(s.engine.retry(runner.last("a")!.ctx.nodeRun.id)).rejects.toMatchObject({ code: "invalid_state" });

    await s.engine.cleanupRun(run.id);
    expect(s.lanes.calls.at(-1)).toBe("cleanup:on-failure:true:force");
  });

  it("serves approval info, diffs and reopen", async () => {
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.id === "a") queueMicrotask(() => e.succeed({ text: "implemented" }));
    });
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "p", type: "pr" }], [["a", "p"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("p"));
    const p = runner.last("p")!.ctx.nodeRun;
    runner.last("p")!.ctx.update({ status: "waiting_approval", output: { title: "Gen title", body: "Gen body" } });

    const info = await s.engine.getApprovalInfo(p.id);
    expect(info.pr).toEqual({ title: "Gen title", body: "Gen body", base: "main", draft: true });
    // Approving a pr binds it to the reviewed commit.
    s.lanes.heads_.set("main", "sha-reviewed");
    await expect(s.engine.submitApproval(p.id, { approved: true })).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("headSha") });
    await expect(s.engine.submitApproval(p.id, { approved: true, headSha: "sha-old" })).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("changed since"),
    });
    expect(info.predecessorOutputs).toEqual([{ nodeId: "a", label: "A", text: "implemented" }]);
    await expect(s.engine.getApprovalInfo(runner.last("a")!.ctx.nodeRun.id)).rejects.toMatchObject({ code: "invalid_state" });

    await expect(s.engine.getDiff(p.id)).resolves.toMatchObject({ base: "main" });
    expect(s.lanes.calls).toContain("diff:main:main:committed");
    await s.engine.getDiff(runner.last("a")!.ctx.nodeRun.id);
    expect(s.lanes.calls).toContain("diff:main:main");

    const a = runner.last("a")!.ctx.nodeRun;
    await expect(s.engine.reopenSession(a.id)).rejects.toMatchObject({ code: "invalid_state" });
    await s.engine.submitApproval(p.id, { approved: true, headSha: "sha-reviewed" });
    expect(runner.last("p")!.calls).toEqual(["approve:true"]);
    s.store.updateNodeRun(a.id, { sessionId: "sess-1" });
    await expect(s.engine.reopenSession(a.id)).resolves.toEqual({ ptyId: "reopen-x", notice: null });
    s.claude.isSessionActive.mockReturnValueOnce(true);
    await expect(s.engine.reopenSession(a.id)).rejects.toMatchObject({ code: "invalid_state" });
    expect(s.claude.reopen).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }), expect.objectContaining({ id: a.id }), expect.objectContaining({ id: "main" }), s.graphs.repoPath);
    await expect(s.engine.getDiff("missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Engine crash recovery and shutdown", () => {
  it("recover() interrupts a crashed run; retry resumes it in a new engine", async () => {
    const crashed = new FakeRunner((e) => {
      if (e.ctx.node.id === "a") queueMicrotask(() => e.succeed());
    });
    const s = setup(allTypes(crashed));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [["a", "b"], ["b", "c"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => crashed.last("b"));
    crashed.last("b")!.ctx.update({ sessionId: "sess-b" });

    // "Restart": a new engine over the same store; the old one is simply dropped.
    const runner = new FakeRunner();
    const engine = s.makeEngine(allTypes(runner));
    await engine.recover();
    expect(s.lanes.calls).toContain("prune");
    expect(runStatus(s, run.id)).toBe("paused");
    expect(statusOf(s, run.id)).toEqual({ a: "succeeded", b: "interrupted", c: "pending" });
    expect(engine.activeRunForGraph("flow")).toBe(run.id);

    const b = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "b")!;
    await engine.retry(b.id);
    await waitRun(s, run.id, "succeeded");
    expect(runner.last("b")!.ctx.previousAttempt).toMatchObject({ id: b.id, status: "interrupted", sessionId: "sess-b" });
    expect(runner.byNode("a")).toHaveLength(0);
    expect(runner.last("c")!.ctx.predecessors[0]!.output).toEqual({ text: "out:b" });
  });

  it("restored runs treat user-skipped nodes as success and re-enqueue pending ready nodes", async () => {
    const crashed = new FakeRunner((e) => {
      if (e.ctx.node.id === "a") queueMicrotask(() => e.failWith());
    });
    const s = setup(allTypes(crashed));
    s.graphs.save(makeGraph([{ id: "a", y: 0 }, { id: "b", y: 100 }, { id: "c", x: 400 }], [["a", "c"]], { maxParallelClaude: 1 }));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => crashed.last("b"));
    const a = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "a")!;
    expect(a.status).toBe("failed");
    await s.engine.skip(a.id); // c becomes ready but waits for b's Claude slot
    expect(statusOf(s, run.id)).toEqual({ a: "skipped", b: "running", c: "ready" });

    const runner = new FakeRunner();
    const engine = s.makeEngine(allTypes(runner));
    await engine.recover();
    expect(statusOf(s, run.id)).toEqual({ a: "skipped", b: "interrupted", c: "pending" });
    const b = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "b")!;
    await engine.retry(b.id);
    await waitRun(s, run.id, "succeeded");
    expect(runner.started.map((e) => e.ctx.node.id).sort()).toEqual(["b", "c"]);
  });

  it("a run stopped while fork lanes were being created can be resumed", async () => {
    const s = setup(allTypes(new FakeRunner()));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", y: 0 }, { id: "c", y: 100 }], [["a", "b"], ["a", "c"]]));
    s.lanes.gate = { laneIds: ["l2"], until: new Promise(() => {}) }; // the old process never finishes it
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => s.lanes.calls.some((c) => c.startsWith("checkpoint:main")));
    await s.engine.shutdown();

    s.lanes.gate = null;
    const runner = new FakeRunner();
    const engine = s.makeEngine(allTypes(runner));
    await engine.recover();
    expect(runStatus(s, run.id)).toBe("paused");
    expect(statusOf(s, run.id)).toEqual({ a: "succeeded", b: "pending", c: "pending" });
    await engine.resumeRun(run.id);
    await waitRun(s, run.id, "succeeded");
    expect(runner.started.map((e) => e.ctx.node.id).sort()).toEqual(["b", "c"]);
    await expect(engine.resumeRun(run.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("resumeRun refuses a run that is paused on a failed node", async () => {
    const runner = new FakeRunner((e) => queueMicrotask(() => e.failWith()));
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }], []));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    await expect(s.engine.resumeRun(run.id)).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("retry or skip") });
  });

  it("cancel during fork-lane creation waits for it, so cleanup removes the new lane too", async () => {
    let release!: () => void;
    const s = setup(allTypes(new FakeRunner()));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", y: 0 }, { id: "c", y: 100 }], [["a", "b"], ["a", "c"]], { keepWorktrees: "never" }));
    s.lanes.gate = { laneIds: ["l2"], until: new Promise((r) => (release = r)) };
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => s.lanes.calls.some((c) => c.startsWith("checkpoint:main")));
    const cancelling = s.engine.cancelRun(run.id);
    setTimeout(release, 50);
    await cancelling;
    const created = s.lanes.calls.findIndex((c) => c.startsWith("create:l2"));
    const cleaned = s.lanes.calls.findIndex((c) => c.startsWith("cleanup"));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(cleaned);
  });

  it("shutdown() stops executions, interrupts node runs and pauses runs", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.last("a"));
    await s.engine.shutdown();
    expect(runner.last("a")!.calls).toEqual(["cancel"]);
    expect(s.ptys.killAll).toHaveBeenCalled();
    expect(runStatus(s, run.id)).toBe("paused");
    expect(statusOf(s, run.id)).toEqual({ a: "interrupted", b: "pending" });
  });
});
