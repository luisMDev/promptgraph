import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyGraph, GraphSchema, type TokenUsage } from "@promptgraph/shared";
import { MIGRATIONS } from "../src/store/schema.js";
import { openDatabase, Store } from "../src/store/store.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const graph = GraphSchema.parse({
  version: 1,
  id: "demo",
  name: "Demo",
  nodes: [{ id: "a", type: "prompt", config: { prompt: "hi" } }],
});

function newStore(now = () => 1000): Store {
  return new Store(openDatabase(":memory:"), now);
}

function usage(costUsd: number, model = "claude-opus-5-5"): TokenUsage {
  return { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, costUsd, model };
}

describe("openDatabase", () => {
  it("creates the parent dir, enables WAL and applies every migration", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = path.join(t.dir, "nested", "state.db");
    const db = openDatabase(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
    // Re-opening an up-to-date database is a no-op.
    const again = openDatabase(file);
    expect(again.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    again.close();
  });
});

describe("Store", () => {
  it("round-trips runs with their snapshot and lists newest first", () => {
    const store = newStore();
    const r1 = store.insertRun({ id: "r1", repoPath: "/repo", graph, graphHash: "h1", shortId: "abcd", startedAt: 1 });
    store.insertRun({ id: "r2", repoPath: "/repo", graph, graphHash: "h2", shortId: "beef", startedAt: 2 });
    store.insertRun({ id: "r3", repoPath: "/other", graph, graphHash: "h3", shortId: "cafe", startedAt: 3 });
    expect(r1).toMatchObject({ id: "r1", graphId: "demo", graphName: "Demo", status: "running", finishedAt: null, cleanedUp: false });
    expect(r1.graphSnapshot).toEqual(graph);
    expect(store.listRuns({ repoPath: "/repo", limit: 10 }).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(store.listRuns({ repoPath: "/repo", graphId: "nope", limit: 10 })).toEqual([]);
    expect(store.listRuns({ repoPath: "/repo", limit: 1 }).map((r) => r.id)).toEqual(["r2"]);

    const updated = store.updateRun("r1", { status: "failed", error: "boom", finishedAt: 9, cleanedUp: true });
    expect(updated).toMatchObject({ status: "failed", error: "boom", finishedAt: 9, cleanedUp: true });
    expect(store.listRunsByStatus(["running"]).map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(store.getRun("missing")).toBeUndefined();
    expect(() => store.updateRun("missing", { status: "failed" })).toThrow();
  });

  it("round-trips node runs incl. JSON columns and derives run counters and usage", () => {
    let t = 100;
    const store = newStore(() => t);
    store.insertRun({ id: "r1", repoPath: "/repo", graph, graphHash: "h", shortId: "abcd", startedAt: 1 });
    const nr = store.insertNodeRun({ id: "n1", runId: "r1", nodeId: "a", iteration: 0, attempt: 0, laneId: "main", status: "pending" });
    expect(nr).toMatchObject({ status: "pending", hold: false, output: null, waitingReason: null, updatedAt: 100 });

    t = 200;
    const patched = store.updateNodeRun("n1", {
      status: "waiting_input",
      hold: true,
      waitingReason: { kind: "notification", notificationType: "permission_prompt", message: "Needs permission" },
      output: { text: "hello", usage: usage(0.5) },
      ptyId: "n1",
      startedAt: 150,
    });
    expect(patched).toMatchObject({
      status: "waiting_input",
      hold: true,
      waitingReason: { kind: "notification", message: "Needs permission" },
      output: { text: "hello" },
      ptyId: "n1",
      startedAt: 150,
      updatedAt: 200,
    });
    // null clears, undefined leaves unchanged
    expect(store.updateNodeRun("n1", { waitingReason: null, activity: undefined })).toMatchObject({ waitingReason: null, hold: true });

    store.insertNodeRun({ id: "n2", runId: "r1", nodeId: "b", iteration: 0, attempt: 0, laneId: "main", status: "waiting_approval" });
    store.insertNodeRun({ id: "n3", runId: "r1", nodeId: "c", iteration: 0, attempt: 0, laneId: "main", status: "idle" });
    store.updateNodeRun("n3", { output: { usage: usage(0.25) } });

    const summary = store.getRunSummary("r1")!;
    expect(summary.pendingApprovals).toBe(1);
    expect(summary.waitingInput).toBe(2); // waiting_input + idle
    expect(summary.usage.costUsd).toBeCloseTo(0.75);
    expect(summary.usage.inputTokens).toBe(2);
    expect(summary.usage.model).toBe("claude-opus-5-5");

    expect(store.listNodeRunsByStatus(["idle", "waiting_approval"]).map((n) => n.id)).toEqual(["n2", "n3"]);
    expect(store.findNodeRunByPtyId("n1")?.id).toBe("n1");
    expect(store.findNodeRunByPtyId("n2")?.id).toBe("n2"); // node pty id === node run id
    expect(store.findNodeRunByPtyId("zzz")).toBeUndefined();
  });

  it("orders node runs by node, iteration and attempt", () => {
    const store = newStore();
    store.insertRun({ id: "r1", repoPath: "/repo", graph, graphHash: "h", shortId: "abcd", startedAt: 1 });
    store.insertNodeRun({ id: "x2", runId: "r1", nodeId: "b", iteration: 0, attempt: 1, laneId: null, status: "pending" });
    store.insertNodeRun({ id: "x1", runId: "r1", nodeId: "b", iteration: 0, attempt: 0, laneId: null, status: "failed" });
    store.insertNodeRun({ id: "x0", runId: "r1", nodeId: "a", iteration: 0, attempt: 0, laneId: null, status: "succeeded" });
    expect(store.listNodeRuns("r1").map((n) => n.id)).toEqual(["x0", "x1", "x2"]);
  });

  it("stores lanes, events and known graph hashes", () => {
    const store = newStore();
    store.insertRun({ id: "r1", repoPath: "/repo", graph, graphHash: "h", shortId: "abcd", startedAt: 1 });
    store.insertLane({ id: "l2", runId: "r1", branch: "pg/demo/abcd/l2", worktreePath: "/wt/l2", baseRef: "s2", index: 1 });
    const main = store.insertLane({ id: "main", runId: "r1", branch: "pg/demo/abcd/main", worktreePath: "/wt/main", baseRef: "s1", index: 0 });
    expect(main).toMatchObject({ status: "active", pushed: false, index: 0 });
    expect(store.listLanes("r1").map((l) => l.id)).toEqual(["main", "l2"]);
    expect(store.updateLane("r1", "l2", { status: "merged", pushed: true })).toMatchObject({ status: "merged", pushed: true });
    expect(store.getLane("r1", "nope")).toBeUndefined();

    const e1 = store.appendEvent("r1", null, "run.started", { a: 1 });
    store.appendEvent("r1", "n1", "node.status", null);
    store.appendEvent("r1", "n1", "node.status", { status: "running" });
    expect(e1).toMatchObject({ runId: "r1", type: "run.started", payload: { a: 1 }, at: 1000 });
    expect(store.listEvents("r1").map((e) => e.payload)).toEqual([{ a: 1 }, null, { status: "running" }]);
    expect(store.listEvents("r1", { afterId: e1.id, limit: 1 })).toHaveLength(1);

    expect(store.getKnownGraphHash("/repo", "demo")).toBeUndefined();
    store.setKnownGraphHash("/repo", "demo", "h1");
    store.setKnownGraphHash("/repo", "demo", "h2");
    expect(store.getKnownGraphHash("/repo", "demo")).toBe("h2");
  });

  it("rolls back a failed transaction", () => {
    const store = newStore();
    expect(() =>
      store.transaction(() => {
        store.insertRun({ id: "r1", repoPath: "/repo", graph: createEmptyGraph("x", "X"), graphHash: "h", shortId: "a", startedAt: 1 });
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(store.getRun("r1")).toBeUndefined();
  });
});
