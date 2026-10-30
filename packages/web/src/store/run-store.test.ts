import type { RunDetail } from "@promptgraph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, nodeRunOf, runDetailOf } from "../test-fixtures";
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
});
