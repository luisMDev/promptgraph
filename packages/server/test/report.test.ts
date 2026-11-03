import { describe, expect, it } from "vitest";
import type { RunEvent } from "@promptgraph/shared";
import { waitingTimes } from "../src/engine/report.js";

const status = (id: number, nodeRunId: string, s: string, at: number): RunEvent => ({
  id,
  runId: "r",
  nodeRunId,
  type: "node.status",
  payload: { status: s },
  at,
});

describe("waitingTimes", () => {
  it("sums the time each node run spent in idle, waiting_input and waiting_approval", () => {
    const events = [
      status(1, "a", "running", 0),
      status(2, "a", "idle", 1_000),
      status(3, "a", "running", 4_000),
      status(4, "a", "waiting_input", 5_000),
      status(5, "a", "succeeded", 7_000),
      status(6, "b", "running", 0),
      status(7, "b", "succeeded", 9_000),
      { id: 8, runId: "r", nodeRunId: "c", type: "node.action", payload: { action: "hold" }, at: 1 },
    ];
    // Node runs that never waited are absent.
    expect(waitingTimes(events, 100_000)).toEqual(new Map([["a", 5_000]]));
  });

  it("counts a wait that is still open up to now", () => {
    const events = [status(1, "a", "running", 0), status(2, "a", "waiting_approval", 2_000)];
    expect(waitingTimes(events, 10_000).get("a")).toBe(8_000);
  });
});
