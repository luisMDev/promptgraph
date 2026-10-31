import { describe, expect, it } from "vitest";
import { forkMergeGraph, laneOf, linearGraph, nodeRunOf } from "../test-fixtures";
import { laneLegend, laneSwatch, mergeInputLabels, nodeLanes } from "./lanes";

describe("lanes", () => {
  it("gives neighbouring lanes distinct colours and wraps around the palette", () => {
    const hexes = Array.from({ length: 8 }, (_, i) => laneSwatch(i).hex);
    expect(new Set(hexes).size).toBe(8);
    expect(laneSwatch(8)).toBe(laneSwatch(0));
    expect(laneSwatch(-1)).toBe(laneSwatch(7));
  });

  it("colours nodes by their planned lane before the engine created it", () => {
    const lanes = nodeLanes(forkMergeGraph(), { main: laneOf({ id: "main", index: 0 }) }, {});
    expect(Object.fromEntries(lanes)).toEqual({
      a: { id: "main", index: 0 },
      b: { id: "main", index: 0 },
      c: { id: "l2", index: 1 },
      m: { id: "main", index: 0 },
    });
  });

  it("prefers the node run's lane and the created lane's index", () => {
    const lanes = nodeLanes(linearGraph(), { l7: laneOf({ id: "l7", index: 6 }) }, { b: nodeRunOf({ id: "nb", nodeId: "b", laneId: "l7" }) });
    expect(lanes.get("b")).toEqual({ id: "l7", index: 6 });
    expect(lanes.get("a")).toEqual({ id: "main", index: 0 });
  });

  it("builds the run legend from the plan, with created lanes and setup state", () => {
    const legend = laneLegend(
      forkMergeGraph(),
      { main: laneOf({ id: "main", index: 0, pushed: true }) },
      { a: nodeRunOf({ id: "na", nodeId: "a", laneSetup: "succeeded" }), c: nodeRunOf({ id: "nc", nodeId: "c", laneId: "l2", laneSetup: "running" }) },
    );
    expect(legend.map((e) => [e.id, e.index, e.lane?.branch ?? null, e.setup])).toEqual([
      ["main", 0, "pg/g1/ab12/main", "succeeded"],
      ["l2", 1, null, "running"],
    ]);
    expect(legend[0]!.lane?.pushed).toBe(true);
    expect(legend[0]!.nodeLabels).toEqual(["Plan", "Backend", "Join"]);
    expect(legend[1]!.nodeLabels).toEqual(["Frontend"]);
  });

  it("lists merge inputs in canvas order of their sources, whatever the edge order", () => {
    expect(mergeInputLabels(forkMergeGraph(), "m")).toEqual(["Backend", "Frontend"]);
    expect(mergeInputLabels(forkMergeGraph(), "a")).toEqual([]);
  });
});
