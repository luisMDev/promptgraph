import { describe, expect, it, vi } from "vitest";
import type { NodeRunOutput } from "@promptgraph/shared";
import type { RunnerRegistry, RunnerResult } from "../src/runners/types.js";
import { waitFor } from "./helpers.js";
import { allTypes, FakeRunner, makeGraph, runStatus, setup, statusOf, waitRun, type EdgeSpec, type FakeExecution, type NodeSpec } from "./support/engine-fakes.js";

vi.mock("../src/workspace/setup.js", () => ({ runWorkspaceSetup: vi.fn() }));

/** Phase 2 engine semantics (§15): edge conditions, condition ports, dead paths, joins and loops. */

/** Settles each node from a script (one result per execution, the last one repeats); default success. */
function scripted(script: Record<string, RunnerResult[]>, onStart?: (e: FakeExecution) => void): FakeRunner {
  const count = new Map<string, number>();
  return new FakeRunner((e: FakeExecution) => {
    onStart?.(e);
    const id = e.ctx.node.id;
    const n = count.get(id) ?? 0;
    count.set(id, n + 1);
    const results = script[id];
    const result = results ? results[Math.min(n, results.length - 1)]! : { status: "succeeded" as const, output: { text: `out:${id}` } };
    queueMicrotask(() => e.finish(result));
  });
}
const registry = (runner: FakeRunner): RunnerRegistry => ({ ...allTypes(runner), condition: runner });
const yes: RunnerResult = { status: "succeeded", output: { port: "true", result: true, text: "looks good" } };
const no: RunnerResult = { status: "succeeded", output: { port: "false", result: false, text: "tests fail" } };
const failed = (error: string, output?: NodeRunOutput): RunnerResult => ({
  status: "failed",
  error,
  ...(output ? { output } : {}),
});

const loop = (source: string, target: string, maxIterations: number, onExhausted: "fail" | "continue" = "fail", extra = {}): EdgeSpec => ({
  id: `loop-${source}-${target}`,
  source,
  target,
  loop: { maxIterations, onExhausted },
  ...extra,
});
const port = (source: string, target: string, sourcePort: "true" | "false" | "error"): EdgeSpec => ({
  id: `${source}-${sourcePort}-${target}`,
  source,
  target,
  sourcePort,
});

function flow(runner: FakeRunner, nodes: NodeSpec[], edges: EdgeSpec[]) {
  const s = setup(registry(runner), { phase: 2 });
  s.graphs.save(makeGraph(nodes, edges));
  return s;
}

/** impl → test → cond; cond.true → commit; cond.false → fix; fix ⟲ test. */
const TEST_FIX_NODES: NodeSpec[] = [
  { id: "impl", x: 0 },
  { id: "test", type: "shell", x: 100 },
  { id: "cond", type: "condition", x: 200 },
  { id: "commit", type: "commit", x: 300, y: 0 },
  { id: "fix", x: 300, y: 100 },
];
const testFixEdges = (max: number, onExhausted: "fail" | "continue" = "fail"): EdgeSpec[] => [
  ["impl", "test"],
  ["test", "cond"],
  port("cond", "commit", "true"),
  port("cond", "fix", "false"),
  loop("fix", "test", max, onExhausted),
];
const runsOf = (s: ReturnType<typeof setup>, runId: string, nodeId: string) => s.store.listNodeRuns(runId).filter((n) => n.nodeId === nodeId);

describe("Engine Phase 2: edge conditions (§15.1)", () => {
  it("a failure routed by a failure edge does not pause; its output reaches the fix node", async () => {
    const runner = scripted({ build: [failed("Exit code 2", { exitCode: 2, stdoutTail: "error TS2304" })] });
    const s = flow(runner, [{ id: "build", type: "shell", onError: "fail-run" }, { id: "deploy", y: 0 }, { id: "fix", y: 100 }], [
      ["build", "deploy"],
      port("build", "fix", "error"),
    ]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toEqual({ build: "failed", deploy: "skipped", fix: "succeeded" });
    const fix = runner.last("fix")!.ctx;
    expect(fix.predecessors).toEqual([
      expect.objectContaining({ nodeId: "build", status: "failed", error: "Exit code 2", output: { exitCode: 2, stdoutTail: "error TS2304" } }),
    ]);
    // The routed failure cannot be retried (its flow already continued).
    await expect(s.engine.retry(runsOf(s, run.id, "build")[0]!.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it('"always" edges fire on success and failure; failure edges are skipped on success', async () => {
    const runner = scripted({});
    const s = flow(runner, [{ id: "a" }, { id: "notify", y: 0 }, { id: "fix", y: 100 }], [
      { id: "a-notify", source: "a", target: "notify", when: "always" },
      port("a", "fix", "error"),
    ]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toEqual({ a: "succeeded", notify: "succeeded", fix: "skipped" });
  });

  it("an unhandled failure still follows onError (pause), and a failure with only skipped successors pauses", async () => {
    const runner = scripted({ a: [failed("nope")] });
    const s = flow(runner, [{ id: "a" }, { id: "b" }], [["a", "b"]]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    expect(statusOf(s, run.id)).toEqual({ a: "failed", b: "pending" });
  });
});

describe("Engine Phase 2: condition ports and dead paths (§15.2, §15.3)", () => {
  it("routes on output.port, skips the other branch and joins exclusive branches in one lane", async () => {
    const runner = scripted({ cond: [no] });
    const s = flow(
      runner,
      [
        { id: "check", type: "shell", x: 0 },
        { id: "cond", type: "condition", x: 100 },
        { id: "ok", x: 200, y: 0 },
        { id: "repair", x: 200, y: 100 },
        { id: "after", x: 300, y: 100 },
        { id: "join", x: 400 },
      ],
      [["check", "cond"], port("cond", "ok", "true"), port("cond", "repair", "false"), ["repair", "after"], ["ok", "join"], ["after", "join"]],
    );
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toEqual({ check: "succeeded", cond: "succeeded", ok: "skipped", repair: "succeeded", after: "succeeded", join: "succeeded" });
    expect(s.store.getNodeRun(runsOf(s, run.id, "cond")[0]!.id)!.output).toMatchObject({ port: "false" });
    // Only the branch that ran is context for the join; both branches stay in the main lane.
    expect(runner.last("join")!.ctx.predecessors.map((p) => p.nodeId)).toEqual(["after"]);
    expect(runner.last("repair")!.ctx.predecessors.map((p) => p.nodeId)).toEqual(["cond"]);
    expect(new Set(s.store.listNodeRuns(run.id).map((n) => n.laneId))).toEqual(new Set(["main"]));
    expect(s.store.listLanes(run.id).map((l) => l.id)).toEqual(["main"]);
  });

  it("a failed condition follows its error port; its true/false branches are dead", async () => {
    const runner = scripted({ cond: [failed("Judge returned no verdict")] });
    const s = flow(
      runner,
      [{ id: "a", type: "shell", x: 0 }, { id: "cond", type: "condition", x: 100 }, { id: "t", x: 200, y: 0 }, { id: "f", x: 200, y: 100 }, { id: "e", x: 200, y: 200 }],
      [["a", "cond"], port("cond", "t", "true"), port("cond", "f", "false"), port("cond", "e", "error")],
    );
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toEqual({ a: "succeeded", cond: "failed", t: "skipped", f: "skipped", e: "succeeded" });
  });
});

describe("Engine Phase 2: loops (§15.4)", () => {
  it("test-fix loop: repeats the body with new iterations and continues after the last pass", async () => {
    const runner = scripted({ test: [failed("1 failing", { exitCode: 1, stdoutTail: "FAIL a.test" }), { status: "succeeded", output: { exitCode: 0 } }], cond: [no, yes] });
    // A failing test with no failure edge would pause: route it into the condition with "always".
    const edges = testFixEdges(3).map((e) => (Array.isArray(e) && e[0] === "test" ? { id: "test-cond", source: "test", target: "cond", when: "always" as const } : e));
    const s = flow(runner, TEST_FIX_NODES, edges);
    const detail = await s.engine.startRun("flow");
    expect(detail.loops).toEqual([{ edgeId: "loop-fix-test", iteration: 0, maxIterations: 3, exhausted: false }]);
    const runId = detail.run.id;
    await waitRun(s, runId, "succeeded");

    expect(runsOf(s, runId, "test").map((n) => [n.iteration, n.status])).toEqual([[0, "failed"], [1, "succeeded"]]);
    expect(runsOf(s, runId, "cond").map((n) => [n.iteration, n.status])).toEqual([[0, "succeeded"], [1, "succeeded"]]);
    expect(runsOf(s, runId, "fix").map((n) => [n.iteration, n.status])).toEqual([[0, "succeeded"], [1, "skipped"]]);
    expect(runsOf(s, runId, "impl").map((n) => n.iteration)).toEqual([0]);
    expect(runsOf(s, runId, "commit").map((n) => [n.iteration, n.status])).toEqual([[0, "succeeded"]]);
    expect(runner.byNode("commit")).toHaveLength(1);

    // Context: fix sees the failing condition; the second test pass sees the fix that looped back.
    expect(runner.byNode("fix")[0]!.ctx.predecessors.map((p) => p.nodeId)).toEqual(["cond"]);
    expect(runner.byNode("fix")[0]!.ctx).toMatchObject({ previousIteration: null, inLoopBody: true });
    const test2 = runner.byNode("test")[1]!.ctx;
    expect(test2.nodeRun.iteration).toBe(1);
    expect(test2.predecessors.map((p) => [p.nodeId, p.status])).toEqual([["impl", "succeeded"], ["fix", "succeeded"]]);
    expect(test2.previousIteration).toMatchObject({ nodeId: "test", iteration: 0, status: "failed" });
    expect(runner.last("commit")!.ctx.predecessors.map((p) => p.nodeId)).toEqual(["cond"]);
    expect(runner.last("commit")!.ctx.predecessors[0]!.output).toMatchObject({ port: "true" });

    const final = s.engine.getRun(runId);
    expect(final.loops).toEqual([{ edgeId: "loop-fix-test", iteration: 1, maxIterations: 3, exhausted: false }]);
    const loopEvents = s.store.listEvents(runId).filter((e) => e.type === "loop.iteration");
    expect(loopEvents.map((e) => e.payload)).toEqual([expect.objectContaining({ edgeId: "loop-fix-test", iteration: 1, body: ["test", "cond", "fix"] })]);
    // Clients learn about a new iteration from the node:update of its pending node runs (and refetch the detail).
    expect(s.events.some((e) => e.name === "node:update" && (e.payload as { nodeRun: { nodeId: string; iteration: number } }).nodeRun.iteration === 1)).toBe(true);
  });

  it('exhausted with "fail": the loop source fails and pauses; skipping it continues past the loop', async () => {
    const runner = scripted({ cond: [no] });
    const s = flow(runner, TEST_FIX_NODES, testFixEdges(1));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    const fixes = runsOf(s, run.id, "fix");
    expect(fixes.map((n) => [n.iteration, n.status])).toEqual([[0, "succeeded"], [1, "failed"]]);
    expect(fixes[1]!.error).toBe('Loop back to "TEST" reached its limit of 1 iteration');
    expect(fixes[1]!.output).toEqual({ text: "out:fix" }); // the work is kept
    expect(s.engine.getRun(run.id).loops).toEqual([{ edgeId: "loop-fix-test", iteration: 1, maxIterations: 1, exhausted: true }]);
    expect(statusOf(s, run.id).commit).toBe("pending");

    await s.engine.skip(fixes[1]!.id);
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toMatchObject({ fix: "skipped", commit: "skipped" });
  });

  it('exhausted with "fail" is routable through a failure edge of the source', async () => {
    const runner = scripted({ cond: [no] });
    const s = flow(runner, [...TEST_FIX_NODES, { id: "giveup", x: 400, y: 100 }], [...testFixEdges(1), port("fix", "giveup", "error")]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(statusOf(s, run.id)).toEqual({ impl: "succeeded", test: "succeeded", cond: "succeeded", fix: "failed", commit: "skipped", giveup: "succeeded" });
    expect(runner.last("giveup")!.ctx.predecessors[0]).toMatchObject({ nodeId: "fix", status: "failed", error: expect.stringContaining("limit") });
  });

  it('exhausted with "continue": the loop edge delivers a skip and the flow goes on', async () => {
    const runner = scripted({ cond: [no] });
    const s = flow(runner, [...TEST_FIX_NODES, { id: "report", x: 400, y: 100 }], [...testFixEdges(2, "continue"), ["fix", "report"]]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(runsOf(s, run.id, "fix").map((n) => n.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(statusOf(s, run.id)).toMatchObject({ commit: "skipped", report: "succeeded" });
    expect(runner.byNode("report")).toHaveLength(1);
    expect(runner.last("report")!.ctx.predecessors[0]!.output).toEqual({ text: "out:fix" });
    expect(s.engine.getRun(run.id).loops).toEqual([{ edgeId: "loop-fix-test", iteration: 2, maxIterations: 2, exhausted: true }]);
  });

  it("a failure loop edge retries one node until it passes (self-loop)", async () => {
    const runner = scripted({ flaky: [failed("flake"), failed("flake"), { status: "succeeded", output: { exitCode: 0 } }] });
    const s = flow(runner, [{ id: "flaky", type: "shell" }, { id: "next" }], [
      ["flaky", "next"],
      { id: "retry", source: "flaky", target: "flaky", sourcePort: "error", loop: { maxIterations: 3, onExhausted: "fail" } },
    ]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    expect(runsOf(s, run.id, "flaky").map((n) => [n.iteration, n.status])).toEqual([[0, "failed"], [1, "failed"], [2, "succeeded"]]);
    expect(runner.byNode("next")).toHaveLength(1);
    expect(runner.byNode("flaky")[1]!.ctx.previousIteration).toMatchObject({ iteration: 0, status: "failed" });
  });

  it("an exhausted failure loop without a failure route pauses (onError)", async () => {
    const runner = scripted({ flaky: [failed("flake")] });
    const s = flow(runner, [{ id: "flaky", type: "shell" }, { id: "next" }], [
      ["flaky", "next"],
      { id: "retry", source: "flaky", target: "flaky", sourcePort: "error", loop: { maxIterations: 1, onExhausted: "fail" } },
    ]);
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    expect(runsOf(s, run.id, "flaky").map((n) => n.status)).toEqual(["failed", "failed"]);
    // Retry runs the same iteration again (new attempt).
    const last = runsOf(s, run.id, "flaky")[1]!;
    const retried = await s.engine.retry(last.id);
    expect(retried).toMatchObject({ iteration: 1, attempt: 1 });
    await waitRun(s, run.id, "paused");
    expect(runStatus(s, run.id)).toBe("paused");
  });

  it("an unhandled failure inside the body pauses; retry keeps the iteration and the loop goes on", async () => {
    const runner = scripted({ fix: [{ status: "succeeded", output: { text: "fixed" } }, failed("crashed"), { status: "succeeded", output: { text: "fixed again" } }], cond: [no, no, yes] });
    const s = flow(runner, TEST_FIX_NODES, testFixEdges(3));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "paused");
    const failedFix = runsOf(s, run.id, "fix").at(-1)!;
    expect(failedFix).toMatchObject({ iteration: 1, attempt: 0, status: "failed" });
    await s.engine.retry(failedFix.id);
    await waitRun(s, run.id, "succeeded");
    expect(runsOf(s, run.id, "fix").map((n) => [n.iteration, n.attempt, n.status])).toEqual([
      [0, 0, "succeeded"],
      [1, 0, "failed"],
      [1, 1, "succeeded"],
      [2, 0, "skipped"],
    ]);
    expect(s.engine.getRun(run.id).loops![0]!.iteration).toBe(2);
  });

  it("resume context: later iterations continue the node's own session", async () => {
    // The fake runner reports a session like the ClaudeRunner does.
    const runner = scripted({ cond: [no, no, yes] }, (e) => e.ctx.update({ sessionId: `sess-${e.ctx.nodeRun.id}` }));
    const s = setup(registry(runner), { phase: 2 });
    const nodes = TEST_FIX_NODES.map((n) => (n.id === "fix" ? { ...n, config: { prompt: "fix it", context: "resume" } } : n));
    s.graphs.save(makeGraph(nodes, testFixEdges(3)));
    const { run } = await s.engine.startRun("flow");
    await waitRun(s, run.id, "succeeded");
    const fixes = runner.byNode("fix");
    expect(fixes).toHaveLength(2);
    expect(fixes[0]!.ctx.previousIteration).toBeNull();
    expect(fixes[1]!.ctx.previousIteration).toMatchObject({ id: fixes[0]!.ctx.nodeRun.id, sessionId: `sess-${fixes[0]!.ctx.nodeRun.id}` });
  });

  it("cancel during a loop cancels the current iteration", async () => {
    const runner = new FakeRunner((e) => {
      if (e.ctx.node.id === "cond") queueMicrotask(() => e.finish(no));
      else if (!(e.ctx.node.id === "test" && e.ctx.nodeRun.iteration === 1)) queueMicrotask(() => e.succeed());
    });
    const s = flow(runner, TEST_FIX_NODES, testFixEdges(3));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.byNode("test").length === 2);
    await s.engine.cancelRun(run.id);
    expect(runStatus(s, run.id)).toBe("cancelled");
    expect(runsOf(s, run.id, "test").map((n) => n.status)).toEqual(["succeeded", "cancelled"]);
    expect(statusOf(s, run.id)).toMatchObject({ cond: "cancelled", fix: "cancelled", commit: "cancelled" });
  });

  it("crash recovery mid-loop: the restored run keeps iterations, counters and held exits", async () => {
    const crashed = new FakeRunner((e) => {
      if (e.ctx.node.id === "cond") queueMicrotask(() => e.finish(no));
      else if (!(e.ctx.node.id === "test" && e.ctx.nodeRun.iteration === 1)) queueMicrotask(() => e.succeed());
    });
    const s = flow(crashed, TEST_FIX_NODES, testFixEdges(3));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => crashed.byNode("test").length === 2);

    const runner = scripted({ cond: [yes] });
    const engine = s.makeEngine(registry(runner));
    await engine.recover();
    expect(runStatus(s, run.id)).toBe("paused");
    expect(engine.getRun(run.id).loops![0]!.iteration).toBe(1);
    const test = runsOf(s, run.id, "test").at(-1)!;
    expect(test).toMatchObject({ iteration: 1, status: "interrupted" });
    await engine.retry(test.id);
    await waitRun(s, run.id, "succeeded");
    expect(runner.started.map((e) => e.ctx.node.id)).toEqual(["test", "cond", "commit"]);
    expect(statusOf(s, run.id)).toMatchObject({ fix: "skipped", commit: "succeeded" });
  });

  it("crash right after the loop source finished: the restored run starts the next iteration", async () => {
    const crashed = new FakeRunner((e) => {
      if (e.ctx.node.id === "cond") queueMicrotask(() => e.finish(no));
      else if (e.ctx.node.id !== "fix") queueMicrotask(() => e.succeed());
    });
    const s = flow(crashed, TEST_FIX_NODES, testFixEdges(3));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => crashed.last("fix"));
    // The process dies after persisting fix's success but before creating iteration 1.
    s.store.updateNodeRun(crashed.last("fix")!.ctx.nodeRun.id, { status: "succeeded", output: { text: "fixed" }, finishedAt: Date.now() });

    const runner = scripted({ cond: [yes] });
    const engine = s.makeEngine(registry(runner));
    await engine.recover();
    expect(runStatus(s, run.id)).toBe("paused");
    await engine.resumeRun(run.id);
    await waitRun(s, run.id, "succeeded");
    expect(runner.started.map((e) => [e.ctx.node.id, e.ctx.nodeRun.iteration])).toEqual([["test", 1], ["cond", 1], ["commit", 0]]);
    expect(runner.byNode("test")[0]!.ctx.predecessors.at(-1)).toMatchObject({ nodeId: "fix", output: { text: "fixed" } });
    expect(engine.getRun(run.id).loops![0]!.iteration).toBe(1);
  });
});
