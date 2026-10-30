import { describe, expect, it } from "vitest";
import type { NodeType } from "@promptgraph/shared";
import { Scheduler, type SchedulerItem } from "../src/engine/scheduler.js";

const item = (id: string, nodeType: NodeType = "prompt"): SchedulerItem => ({ nodeRunId: id, nodeType, laneId: "main" });

describe("Scheduler", () => {
  it("caps Claude items at maxParallelClaude in FIFO order", () => {
    const started: string[] = [];
    const s = new Scheduler(2, (i) => started.push(i.nodeRunId));
    ["a", "b", "c", "d"].forEach((id) => s.enqueue(item(id)));
    expect(started).toEqual(["a", "b"]);
    expect(s.runningCount).toBe(2);
    expect(s.queuedCount).toBe(2);
    s.release("b");
    expect(started).toEqual(["a", "b", "c"]);
    s.release("a");
    s.release("c");
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("does not cap shell/git items, which may overtake queued Claude items", () => {
    const started: string[] = [];
    const s = new Scheduler(1, (i) => started.push(i.nodeRunId));
    s.enqueue(item("p1"));
    s.enqueue(item("p2", "command"));
    s.enqueue(item("sh", "shell"));
    s.enqueue(item("cm", "commit"));
    s.enqueue(item("mg", "merge"));
    expect(started).toEqual(["p1", "sh", "cm", "mg"]);
    expect(s.queuedCount).toBe(1);
  });

  it("removes queued items, ignores duplicates and unknown releases", () => {
    const started: string[] = [];
    const s = new Scheduler(1, (i) => started.push(i.nodeRunId));
    s.enqueue(item("a"));
    s.enqueue(item("a"));
    s.enqueue(item("b"));
    s.enqueue(item("c"));
    s.remove("b");
    s.release("zzz");
    s.release("a");
    expect(started).toEqual(["a", "c"]);
    expect(s.clear()).toEqual([]);
  });

  it("handles re-entrant enqueue/release from onStart", () => {
    const started: string[] = [];
    const s: Scheduler = new Scheduler(1, (i) => {
      started.push(i.nodeRunId);
      if (i.nodeRunId === "a") {
        s.release("a"); // finished synchronously
        s.enqueue(item("c"));
      }
    });
    s.enqueue(item("a"));
    s.enqueue(item("b"));
    // c was enqueued (inside a's onStart) before b: FIFO keeps that order.
    expect(started).toEqual(["a", "c"]);
    expect(s.runningCount).toBe(1);
    expect(s.queuedCount).toBe(1);
    s.release("c");
    expect(started).toEqual(["a", "c", "b"]);
  });

  it("lets a running merge take a Claude slot ahead of queued Claude items", async () => {
    const started: string[] = [];
    const s = new Scheduler(1, (i) => started.push(i.nodeRunId));
    s.enqueue(item("p1"));
    s.enqueue(item("mg", "merge"));
    s.enqueue(item("p2"));
    expect(started).toEqual(["p1", "mg"]);
    await expect(s.acquireClaudeSlot("p1")).resolves.toBeUndefined(); // Claude items already hold one

    let granted = false;
    const slot = s.acquireClaudeSlot("mg").then(() => (granted = true));
    await Promise.resolve();
    expect(granted).toBe(false);
    s.release("p1");
    await slot;
    expect(started).toEqual(["p1", "mg"]); // p2 still waits: the merge holds the slot
    await expect(s.acquireClaudeSlot("mg")).resolves.toBeUndefined();
    s.release("mg");
    expect(started).toEqual(["p1", "mg", "p2"]);
  });

  it("drops a slot request when its item is released while waiting", () => {
    const started: string[] = [];
    const s = new Scheduler(1, (i) => started.push(i.nodeRunId));
    s.enqueue(item("p1"));
    s.enqueue(item("mg", "merge"));
    void s.acquireClaudeSlot("mg");
    s.release("mg");
    s.enqueue(item("p2"));
    s.release("p1");
    expect(started).toEqual(["p1", "mg", "p2"]);
  });
});
