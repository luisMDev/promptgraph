import { describe, expect, it } from "vitest";
import type { NodeRun } from "@promptgraph/shared";
import { forkMergeGraph, laneOf, linearGraph, nodeRunOf, runDetailOf } from "../test-fixtures";
import { cardNote, currentNodeRuns, edgeRunState, enteredMergeConflict, runInfoOf, upsertNodeRun } from "./run-view";
import { nodeRunStyle } from "./status-style";

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

  describe("cardNote", () => {
    const merge = { type: "merge" as const };
    const conflict: Partial<NodeRun> = { status: "waiting_input", ptyId: "shell-m", waitingReason: { kind: "merge_conflict", message: "Conflicts in a.ts" } };

    it("describes merge conflict states", () => {
      expect(cardNote(merge, nodeRunOf({ id: "m", nodeId: "m", ...conflict }))?.tone).toBe("amber");
      expect(cardNote(merge, nodeRunOf({ id: "m", nodeId: "m", status: "running", output: { conflictedFiles: ["a.ts"] } }))).toEqual({ text: "Resolving 1 conflicted file", tone: "blue" });
      expect(cardNote(merge, nodeRunOf({ id: "m", nodeId: "m", status: "succeeded", output: { conflictedFiles: ["a", "b"] } }))).toEqual({ text: "Resolved 2 conflicted files", tone: "green" });
      expect(cardNote(merge, nodeRunOf({ id: "m", nodeId: "m", status: "succeeded", output: { sha: "x" } }))).toBeNull();
    });

    it("marks failures that were handled downstream", () => {
      const handled = nodeRunOf({ id: "b", nodeId: "b", status: "failed", output: { exitCode: 2, failureHandled: true } });
      expect(cardNote({ type: "shell" }, handled)).toEqual({ text: "Handled: its failure path ran instead", tone: "zinc" });
      expect(nodeRunStyle(handled).label).toBe("Failed — handled");
      expect(cardNote({ type: "shell" }, nodeRunOf({ id: "b", nodeId: "b", status: "failed" }))).toBeNull();
    });

    it("describes approval gates", () => {
      expect(cardNote({ type: "pr" }, nodeRunOf({ id: "p", nodeId: "p", status: "waiting_approval" }))?.tone).toBe("violet");
      expect(cardNote({ type: "approval" }, nodeRunOf({ id: "p", nodeId: "p", status: "failed", output: { approved: false, comment: "tests missing" } }))).toEqual({
        text: "Rejected: tests missing",
        tone: "red",
      });
      expect(cardNote({ type: "approval" }, nodeRunOf({ id: "p", nodeId: "p", status: "succeeded", output: { approved: true } }))?.text).toBe("Approved");
      // A pushed PR shows its link instead.
      expect(cardNote({ type: "pr" }, nodeRunOf({ id: "p", nodeId: "p", status: "succeeded", output: { approved: true, prUrl: "u" } }))).toBeNull();
      expect(cardNote({ type: "prompt" }, nodeRunOf({ id: "p", nodeId: "p", status: "waiting_approval" }))).toBeNull();
    });

    it("detects the transition into a merge-conflict pause once", () => {
      const paused = nodeRunOf({ id: "m", nodeId: "m", ...conflict });
      expect(enteredMergeConflict(nodeRunOf({ id: "m", nodeId: "m", status: "running" }), paused)).toBe(true);
      expect(enteredMergeConflict(undefined, paused)).toBe(true);
      expect(enteredMergeConflict(paused, { ...paused, updatedAt: 9 })).toBe(false);
      expect(enteredMergeConflict(undefined, { ...paused, ptyId: null })).toBe(false);
      expect(enteredMergeConflict(undefined, nodeRunOf({ id: "m", nodeId: "m", status: "waiting_input", ptyId: "m" }))).toBe(false);
    });
  });

  it("summarises a run for the history: lanes in index order and PR links of current attempts", () => {
    const graph = forkMergeGraph();
    const detail = runDetailOf(graph, [
      nodeRunOf({ id: "m0", nodeId: "m", status: "failed", output: { prUrl: "https://github.com/o/r/pull/1" } }),
      nodeRunOf({ id: "m1", nodeId: "m", attempt: 1, status: "succeeded", output: { prUrl: "https://github.com/o/r/pull/2" } }),
    ]);
    detail.lanes = [laneOf({ id: "l2", index: 1 }), laneOf({ id: "main", index: 0, pushed: true })];
    const info = runInfoOf(detail);
    expect(info.lanes.map((l) => l.id)).toEqual(["main", "l2"]);
    expect(info.prs).toEqual([{ nodeId: "m", label: "Join", url: "https://github.com/o/r/pull/2" }]);
  });
});
