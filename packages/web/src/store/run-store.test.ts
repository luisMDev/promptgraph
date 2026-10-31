import type { RunDetail } from "@promptgraph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { laneOf, linearGraph, nodeRunOf, runDetailOf, testFixLoopGraph } from "../test-fixtures";
import { setRunStoreDeps, useRunStore } from "./run-store";

describe("run store", () => {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  let resolveFetch: (d: RunDetail) => void = () => undefined;

  beforeEach(async () => {
    subscribe.mockClear();
    unsubscribe.mockClear();
    setRunStoreDeps({
      subscribe,
      unsubscribe,
      fetchRun: () => new Promise<RunDetail>((r) => (resolveFetch = r)),
    });
    await useRunStore.getState().selectRun(null);
    useRunStore.setState({ graphId: "g1", runs: [] });
  });

  it("subscribes, loads the detail and applies updates received while loading", async () => {
    const graph = linearGraph();
    const pending = useRunStore.getState().selectRun("r1");
    expect(subscribe).toHaveBeenCalledWith("r1");

    // Arrives before the REST detail: buffered, then applied on top of it.
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "na", nodeId: "a", status: "running", activity: "Edit x.ts" }));
    resolveFetch(runDetailOf(graph, [nodeRunOf({ id: "na", nodeId: "a", status: "ready" })]));
    await pending;

    const s = useRunStore.getState();
    expect(s.currentByNode.a).toMatchObject({ status: "running", activity: "Edit x.ts" });
  });

  it("tracks the current attempt per node after a retry", () => {
    const graph = linearGraph();
    useRunStore.getState().showRun(runDetailOf(graph, [nodeRunOf({ id: "na", nodeId: "a", status: "failed" })]));
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "na2", nodeId: "a", attempt: 1, status: "running" }));
    expect(useRunStore.getState().currentByNode.a!.id).toBe("na2");
    expect(useRunStore.getState().detail!.nodeRuns).toHaveLength(2);
  });

  it("keeps the newer node run when a stale REST response arrives after WS updates", () => {
    useRunStore.getState().showRun(runDetailOf(linearGraph(), [nodeRunOf({ id: "na", nodeId: "a", status: "waiting_approval", updatedAt: 10 })]));
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "na", nodeId: "a", status: "succeeded", updatedAt: 30 }));
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "na", nodeId: "a", status: "running", updatedAt: 20 }));
    expect(useRunStore.getState().currentByNode.a!.status).toBe("succeeded");
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "na", nodeId: "a", status: "succeeded", activity: "x", updatedAt: 30 }));
    expect(useRunStore.getState().currentByNode.a!.activity).toBe("x");
  });

  it("ignores updates for other runs and merges run summaries", () => {
    const graph = linearGraph();
    const detail = runDetailOf(graph, []);
    useRunStore.getState().showRun(detail);
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "x", nodeId: "a", runId: "other" }));
    expect(useRunStore.getState().detail!.nodeRuns).toHaveLength(0);

    const { graphSnapshot: _g, ...summary } = detail.run;
    useRunStore.getState().applyRunUpdate({ ...summary, status: "succeeded", finishedAt: 5000 });
    const s = useRunStore.getState();
    expect(s.detail!.run.status).toBe("succeeded");
    expect(s.detail!.run.graphSnapshot).toBe(graph);
    expect(s.runs.map((r) => [r.id, r.status])).toEqual([["r1", "succeeded"]]);
  });

  it("adds runs of the current graph to the history, newest first", () => {
    const { graphSnapshot: _g, ...older } = runDetailOf(linearGraph(), [], "r-old").run;
    useRunStore.getState().applyRunUpdate({ ...older, startedAt: 1 });
    useRunStore.getState().applyRunUpdate({ ...older, id: "r-new", startedAt: 2 });
    useRunStore.getState().applyRunUpdate({ ...older, id: "r-foreign", graphId: "other", startedAt: 3 });
    expect(useRunStore.getState().runs.map((r) => r.id)).toEqual(["r-new", "r-old"]);
  });

  it("unsubscribes when returning to edit mode", async () => {
    useRunStore.getState().showRun(runDetailOf(linearGraph(), []));
    await useRunStore.getState().selectRun(null);
    expect(unsubscribe).toHaveBeenCalledWith("r1");
    expect(useRunStore.getState()).toMatchObject({ selectedRunId: null, detail: null });
  });

  it("loads history details on demand and refreshes them only when status or cleanup changes", async () => {
    const graph = linearGraph();
    const detail = runDetailOf(graph, [nodeRunOf({ id: "na", nodeId: "a", status: "succeeded" })]);
    detail.lanes = [laneOf({ id: "main", index: 0 })];
    const fetchRun = vi.fn(async () => detail);
    setRunStoreDeps({ subscribe, unsubscribe, fetchRun });
    const { graphSnapshot: _g, ...summary } = detail.run;
    useRunStore.getState().applyRunUpdate(summary);

    await useRunStore.getState().loadRunInfo("r1");
    expect(useRunStore.getState().runInfo.r1!.lanes.map((l) => l.branch)).toEqual(["pg/g1/ab12/main"]);
    expect(fetchRun).toHaveBeenCalledTimes(1);

    useRunStore.getState().applyRunUpdate({ ...summary, usage: { ...summary.usage, outputTokens: 99 } });
    expect(fetchRun).toHaveBeenCalledTimes(1);

    detail.lanes = [laneOf({ id: "main", index: 0, status: "removed" })];
    useRunStore.getState().applyRunUpdate({ ...summary, status: "succeeded", cleanedUp: true });
    expect(fetchRun).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(useRunStore.getState().runInfo.r1!.lanes[0]!.status).toBe("removed"));
  });

  it("forgets history details when switching graphs", async () => {
    useRunStore.setState({ runInfo: { r1: { lanes: [], prs: [] } } });
    await useRunStore.getState().loadRuns("g2").catch(() => undefined);
    expect(useRunStore.getState().runInfo).toEqual({});
  });
});

describe("run store: loops and iterations", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await useRunStore.getState().selectRun(null);
  });

  it("follows the latest iteration and resets the iteration selection on node change", () => {
    const s = useRunStore.getState();
    s.showRun(runDetailOf(testFixLoopGraph(), [nodeRunOf({ id: "t0", nodeId: "test", status: "failed" })]));
    s.selectNode("test");
    s.selectIteration(0);
    expect(useRunStore.getState().selectedIteration).toBe(0);
    // Same node again keeps it; another node resets it.
    s.selectNode("test");
    expect(useRunStore.getState().selectedIteration).toBe(0);
    s.selectNode("fix");
    expect(useRunStore.getState()).toMatchObject({ selectedNodeId: "fix", selectedIteration: null });
    // A new iteration becomes the current node run.
    s.applyNodeUpdate(nodeRunOf({ id: "t1", nodeId: "test", iteration: 1, status: "running" }));
    expect(useRunStore.getState().currentByNode.test!.id).toBe("t1");
  });

  it("derives loop counts and refetches the server loop state when a loop iterates", async () => {
    vi.useFakeTimers();
    const graph = testFixLoopGraph();
    const fetchRun = vi.fn();
    setRunStoreDeps({ subscribe: vi.fn(), unsubscribe: vi.fn(), fetchRun });
    const detail = { ...runDetailOf(graph, [nodeRunOf({ id: "f0", nodeId: "fix", status: "running" })]), loops: [{ edgeId: "loop", iteration: 0, maxIterations: 3, exhausted: false }] };
    useRunStore.getState().showRun(detail);
    expect(useRunStore.getState().loops.loop).toEqual({ iteration: 0, maxIterations: 3, exhausted: false });

    fetchRun.mockResolvedValue({ ...detail, nodeRuns: [], loops: [{ edgeId: "loop", iteration: 1, maxIterations: 3, exhausted: false }] });
    // Burst: the loop source settles and the loop body gets new iterations; one refetch.
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "f0", nodeId: "fix", status: "succeeded", updatedAt: 2 }));
    useRunStore.getState().applyNodeUpdate(nodeRunOf({ id: "t1", nodeId: "test", iteration: 1, status: "pending", updatedAt: 2 }));
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchRun).toHaveBeenCalledTimes(1);
    const s = useRunStore.getState();
    expect(s.loops.loop).toEqual({ iteration: 1, maxIterations: 3, exhausted: false });
    // Only the loop state is taken from the refetch: node runs stay WS-driven.
    expect(s.detail!.nodeRuns.map((n) => n.id)).toEqual(["f0", "t1"]);
    vi.useRealTimers();
  });
});
