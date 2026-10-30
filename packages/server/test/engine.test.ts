import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphSchema,
  type ApprovalRequest,
  type GraphInput,
  type Lane,
  type NodeRunOutput,
  type NodeType,
  type PlannedLane,
  type Run,
} from "@promptgraph/shared";
import { getPaths } from "../src/config/paths.js";
import { Engine, EngineError } from "../src/engine/engine.js";
import { EventBus, type BusEvents } from "../src/events/bus.js";
import { GraphStore } from "../src/graphs/graph-store.js";
import type { PtyManager } from "../src/pty/pty-manager.js";
import type { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import type { NodeExecution, Runner, RunnerContext, RunnerRegistry, RunnerResult } from "../src/runners/types.js";
import { openDatabase, Store } from "../src/store/store.js";
import type { LaneManager } from "../src/workspace/lane-manager.js";
import { runWorkspaceSetup } from "../src/workspace/setup.js";
import { tempDir, waitFor } from "./helpers.js";

vi.mock("../src/workspace/setup.js", () => ({ runWorkspaceSetup: vi.fn() }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  vi.mocked(runWorkspaceSetup).mockReset();
});

// ---------------------------------------------------------------------------
// Fakes (the engine only talks to these through the CONTRACTS interfaces)
// ---------------------------------------------------------------------------

/** A started node; the test settles it (or the runner auto-settles in "auto" mode). */
class FakeExecution {
  readonly calls: string[] = [];
  private settle!: (r: RunnerResult) => void;
  readonly result = new Promise<RunnerResult>((r) => (this.settle = r));
  settled = false;
  constructor(readonly ctx: RunnerContext) {}
  finish(r: RunnerResult): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(r);
  }
  succeed(output: NodeRunOutput = { text: `out:${this.ctx.node.id}` }): void {
    this.finish({ status: "succeeded", output });
  }
  failWith(error = `boom:${this.ctx.node.id}`): void {
    this.finish({ status: "failed", error });
  }
}

class FakeRunner implements Runner {
  readonly started: FakeExecution[] = [];
  constructor(private readonly behaviour: (e: FakeExecution) => void = (e) => queueMicrotask(() => e.succeed())) {}

  start(ctx: RunnerContext): NodeExecution {
    const e = new FakeExecution(ctx);
    this.started.push(e);
    this.behaviour(e);
    return {
      result: e.result,
      controls: {
        done: () => (e.calls.push("done"), e.succeed()),
        fail: (reason?: string) => (e.calls.push(`fail:${reason ?? ""}`), e.failWith(reason ?? "failed by user")),
        setHold: (hold: boolean) => e.calls.push(`hold:${hold}`),
        approve: (req: ApprovalRequest) => (e.calls.push(`approve:${req.approved}`), e.succeed({ approved: req.approved })),
        userInput: () => e.calls.push("input"),
        cancel: async () => {
          e.calls.push("cancel");
          e.finish({ status: "cancelled" });
        },
      },
    };
  }

  byNode(nodeId: string): FakeExecution[] {
    return this.started.filter((e) => e.ctx.node.id === nodeId);
  }
  last(nodeId: string): FakeExecution | undefined {
    return this.byNode(nodeId).at(-1);
  }
}

class FakeLanes {
  readonly calls: string[] = [];
  failCreate: string | null = null;
  private heads = 0;
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly root: string,
  ) {}
  async createLane(run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    this.calls.push(`create:${planned.id}:${fromRef}`);
    if (this.failCreate) throw new Error(this.failCreate);
    const lane = this.store.insertLane({
      id: planned.id,
      runId: run.id,
      branch: `pg/${run.graphId}/${run.shortId}/${planned.id}`,
      worktreePath: path.join(this.root, run.id, planned.id),
      baseRef: fromRef,
      index: planned.index,
    });
    this.bus.emit("lane:update", { lane });
    return lane;
  }
  async checkpoint(lane: Lane, afterLabel: string): Promise<string | null> {
    this.calls.push(`checkpoint:${lane.id}:${afterLabel}`);
    return null;
  }
  async headSha(lane: Lane): Promise<string> {
    return `head-${lane.id}-${++this.heads}`;
  }
  async diff(lane: Lane, base: string) {
    this.calls.push(`diff:${lane.id}:${base}`);
    return { base, head: "h", files: [], patch: "", truncated: false };
  }
  async cleanup(runId: string, opts: { keep: string; failed: boolean; force?: boolean }): Promise<void> {
    this.calls.push(`cleanup:${opts.keep}:${opts.failed}${opts.force ? ":force" : ""}`);
    this.store.updateRun(runId, { cleanedUp: true });
  }
  async prune(): Promise<void> {
    this.calls.push("prune");
  }
}

interface Setup {
  engine: Engine;
  store: Store;
  graphs: GraphStore;
  bus: EventBus;
  lanes: FakeLanes;
  ptys: { killAll: ReturnType<typeof vi.fn> };
  claude: { reopen: ReturnType<typeof vi.fn> };
  events: Array<{ name: keyof BusEvents; payload: unknown }>;
  attention: Array<BusEvents["attention"]>;
  makeEngine: (runners: RunnerRegistry) => Engine;
}

function setup(runners: RunnerRegistry): Setup {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const bus = new EventBus();
  const events: Setup["events"] = [];
  const attention: Setup["attention"] = [];
  for (const name of ["run:update", "node:update", "lane:update"] as const) bus.on(name, (payload) => events.push({ name, payload }));
  bus.on("attention", (a) => attention.push(a));
  const store = new Store(openDatabase(":memory:"));
  const graphs = new GraphStore(t.dir, bus);
  const lanes = new FakeLanes(store, bus, path.join(t.dir, "wt"));
  const ptys = { killAll: vi.fn(async () => {}) };
  const claude = { reopen: vi.fn(() => "reopen-x") };
  const makeEngine = (r: RunnerRegistry) =>
    new Engine({
      store,
      graphs,
      lanes: lanes as unknown as LaneManager,
      ptys: ptys as unknown as PtyManager,
      runners: r,
      claude: claude as unknown as ClaudeRunner,
      bus,
      paths: getPaths({ PG_HOME: path.join(t.dir, "pg-home") }),
      repo: { path: t.dir, name: path.basename(t.dir) },
      phase: 1,
      env: {},
      stopTimeoutMs: 500,
    });
  return { engine: makeEngine(runners), store, graphs, bus, lanes, ptys, claude, events, attention, makeEngine };
}

type NodeSpec = { id: string; type?: NodeType; x?: number; y?: number; onError?: "fail-run" | "pause"; label?: string };

function makeGraph(nodes: NodeSpec[], edges: Array<[string, string]>, settings: GraphInput["settings"] = {}) {
  const config = (type: NodeType) =>
    ({ prompt: { prompt: "do it" }, command: { command: "/simplify" }, shell: { run: "true" } })[type as "prompt"] ?? {};
  return GraphSchema.parse({
    version: 1,
    id: "flow",
    name: "Flow",
    settings,
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type ?? "prompt",
      label: n.label ?? n.id.toUpperCase(),
      position: { x: n.x ?? i * 200, y: n.y ?? 0 },
      config: config(n.type ?? "prompt"),
      ...(n.onError ? { onError: n.onError } : {}),
    })),
    edges: edges.map(([s, t]) => ({ id: `${s}-${t}`, source: s, target: t })),
  });
}

const statusOf = (s: Setup, runId: string) =>
  Object.fromEntries([...new Map(s.store.listNodeRuns(runId).map((n) => [n.nodeId, n])).values()].map((n) => [n.nodeId, n.status]));
const runStatus = (s: Setup, runId: string) => s.store.getRun(runId)!.status;
const waitRun = (s: Setup, runId: string, status: string) => waitFor(() => runStatus(s, runId) === status, 3000);

const allTypes = (runner: Runner): RunnerRegistry =>
  Object.fromEntries((["prompt", "command", "shell", "commit", "pr", "approval", "merge"] as const).map((t) => [t, runner]));

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

  it("fails nodes whose type has no runner", async () => {
    const s = setup({ prompt: new FakeRunner() });
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", type: "shell" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    const b = s.store.listNodeRuns(run.id).find((n) => n.nodeId === "b")!;
    expect(b).toMatchObject({ status: "failed", error: expect.stringContaining("not supported") });
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
    expect(info.predecessorOutputs).toEqual([{ nodeId: "a", label: "A", text: "implemented" }]);
    await expect(s.engine.getApprovalInfo(runner.last("a")!.ctx.nodeRun.id)).rejects.toMatchObject({ code: "invalid_state" });

    await expect(s.engine.getDiff(p.id)).resolves.toMatchObject({ base: "main" });
    expect(s.lanes.calls).toContain("diff:main:main");

    const a = runner.last("a")!.ctx.nodeRun;
    await expect(s.engine.reopenSession(a.id)).rejects.toMatchObject({ code: "invalid_state" });
    s.store.updateNodeRun(a.id, { sessionId: "sess-1" });
    await expect(s.engine.reopenSession(a.id)).resolves.toEqual({ ptyId: "reopen-x" });
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
