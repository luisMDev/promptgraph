import { describe, expect, it } from "vitest";
import { linearGraph, nodeRunOf } from "../test-fixtures";
import { currentNodeRuns, edgeRunState, upsertNodeRun } from "./run-view";

describe("run-view", () => {
  it("picks the latest iteration, then attempt, per node", () => {
    const runs = [
      nodeRunOf({ id: "1", nodeId: "a", attempt: 0, status: "failed" }),
      nodeRunOf({ id: "2", nodeId: "a", attempt: 1, status: "running" }),
      nodeRunOf({ id: "3", nodeId: "b", iteration: 1, attempt: 0 }),
      nodeRunOf({ id: "4", nodeId: "b", iteration: 0, attempt: 3 }),
    ];
    const cur = currentNodeRuns(runs);
    expect(cur.a!.id).toBe("2");
    expect(cur.b!.id).toBe("3");
  });

  it("upserts by id", () => {
    const list = [nodeRunOf({ id: "1", nodeId: "a" })];
    expect(upsertNodeRun(list, nodeRunOf({ id: "1", nodeId: "a", status: "running" }))[0]!.status).toBe("running");
    expect(upsertNodeRun(list, nodeRunOf({ id: "2", nodeId: "b" }))).toHaveLength(2);
  });

  it("animates edges of running sources and colours activated ones", () => {
    const edge = linearGraph().edges[0]!;
    expect(edgeRunState(edge, undefined)).toBe("idle");
    expect(edgeRunState(edge, nodeRunOf({ id: "1", nodeId: "a", status: "running" }))).toBe("flowing");
    expect(edgeRunState(edge, nodeRunOf({ id: "1", nodeId: "a", status: "waiting_input" }))).toBe("flowing");
    expect(edgeRunState(edge, nodeRunOf({ id: "1", nodeId: "a", status: "succeeded" }))).toBe("activated");
    expect(edgeRunState(edge, nodeRunOf({ id: "1", nodeId: "a", status: "failed" }))).toBe("dead");
    expect(edgeRunState({ ...edge, sourcePort: "error" }, nodeRunOf({ id: "1", nodeId: "a", status: "failed" }))).toBe("activated");
    // A user skip is success downstream; a skip from a dead path is not.
    expect(edgeRunState(edge, nodeRunOf({ id: "1", nodeId: "a", status: "skipped", output: { skippedByUser: true } }))).toBe("activated");
    expect(edgeRunState(edge, nodeRunOf({ id: "1", nodeId: "a", status: "skipped" }))).toBe("dead");
  });
});
