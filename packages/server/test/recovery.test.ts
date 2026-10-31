import { describe, expect, it } from "vitest";
import { createEmptyGraph } from "@promptgraph/shared";
import { INTERRUPTED_RUN_ERROR, markInterrupted } from "../src/engine/recovery.js";
import { openDatabase, Store } from "../src/store/store.js";

describe("markInterrupted", () => {
  it("interrupts live node runs, demotes ready ones and pauses running runs", () => {
    const store = new Store(openDatabase(":memory:"));
    const graph = createEmptyGraph("g", "G");
    store.insertRun({ id: "r1", repoPath: "/repo", graph, graphHash: "h", shortId: "a", startedAt: 1 });
    store.insertRun({ id: "r2", repoPath: "/repo", graph, graphHash: "h", shortId: "b", startedAt: 2 });
    store.updateRun("r2", { status: "succeeded", finishedAt: 3 });
    const add = (id: string, runId: string, status: Parameters<Store["insertNodeRun"]>[0]["status"]) =>
      store.insertNodeRun({ id, runId, nodeId: id, iteration: 0, attempt: 0, laneId: "main", status });
    add("running", "r1", "running");
    add("idle", "r1", "idle");
    add("waiting", "r1", "waiting_approval");
    add("ready", "r1", "ready");
    add("done", "r1", "succeeded");
    add("old", "r2", "succeeded");

    expect(markInterrupted(store, { repoPath: "/repo" }, 50)).toEqual(["r1"]);
    const byId = new Map(store.listNodeRuns("r1").map((n) => [n.id, n]));
    expect(byId.get("running")).toMatchObject({ status: "interrupted", finishedAt: 50 });
    expect(byId.get("idle")!.status).toBe("interrupted");
    expect(byId.get("waiting")!.status).toBe("interrupted");
    expect(byId.get("ready")!.status).toBe("pending");
    expect(byId.get("done")!.status).toBe("succeeded");
    expect(store.getRun("r1")).toMatchObject({ status: "paused", error: INTERRUPTED_RUN_ERROR });
    expect(store.getRun("r2")!.status).toBe("succeeded");
    expect(store.listEvents("r1").some((e) => e.type === "run.status")).toBe(true);
    expect(markInterrupted(store, { repoPath: "/repo" })).toEqual([]);
  });

  it("only touches runs of its own repository (and of runIds when given)", () => {
    const store = new Store(openDatabase(":memory:"));
    const graph = createEmptyGraph("g", "G");
    store.insertRun({ id: "a", repoPath: "/repoA", graph, graphHash: "h", shortId: "a", startedAt: 1 });
    store.insertRun({ id: "b", repoPath: "/repoB", graph, graphHash: "h", shortId: "b", startedAt: 2 });
    store.insertRun({ id: "b2", repoPath: "/repoB", graph, graphHash: "h", shortId: "c", startedAt: 3 });
    for (const runId of ["a", "b", "b2"]) {
      store.insertNodeRun({ id: `${runId}-n`, runId, nodeId: "n", iteration: 0, attempt: 0, laneId: "main", status: "running" });
    }
    expect(markInterrupted(store, { repoPath: "/repoB", runIds: ["b"] })).toEqual(["b"]);
    expect(store.getRun("b2")!.status).toBe("running");
    expect(store.getNodeRun("b2-n")!.status).toBe("running");
    expect(markInterrupted(store, { repoPath: "/repoB" })).toEqual(["b2"]);
    expect(store.getRun("a")!.status).toBe("running");
    expect(store.getNodeRun("a-n")!.status).toBe("running");
  });
});
