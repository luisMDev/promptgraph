import { describe, expect, it } from "vitest";
import { tabDragTarget, tabShift } from "./TabStrip";

// Three 100px tabs side by side, starting at x = 10.
const slots = [0, 1, 2].map((i) => ({ left: 10 + i * 100, width: 100 }));

describe("tab drag geometry", () => {
  it("keeps the slot until the leading edge passes a neighbour's middle", () => {
    expect(tabDragTarget(slots, 0, 0)).toEqual({ dx: 0, to: 0 });
    expect(tabDragTarget(slots, 0, 49)).toEqual({ dx: 49, to: 0 });
    expect(tabDragTarget(slots, 0, 51)).toEqual({ dx: 51, to: 1 });
    expect(tabDragTarget(slots, 0, 151)).toEqual({ dx: 151, to: 2 });
    expect(tabDragTarget(slots, 2, -49)).toEqual({ dx: -49, to: 2 });
    expect(tabDragTarget(slots, 2, -51)).toEqual({ dx: -51, to: 1 });
  });

  it("clamps the dragged tab to the strip", () => {
    expect(tabDragTarget(slots, 0, 999)).toEqual({ dx: 200, to: 2 });
    expect(tabDragTarget(slots, 0, -50)).toEqual({ dx: 0, to: 0 });
    expect(tabDragTarget(slots, 1, -999)).toEqual({ dx: -100, to: 0 });
  });

  it("slides the passed tabs aside by the dragged tab's width", () => {
    // Tab 0 hovering over slot 2: tabs 1 and 2 move left.
    expect([0, 1, 2].map((i) => tabShift(i, 0, 2, 100))).toEqual([0, -100, -100]);
    // Tab 2 hovering over slot 0: tabs 0 and 1 move right.
    expect([0, 1, 2].map((i) => tabShift(i, 2, 0, 100))).toEqual([100, 100, 0]);
    expect([0, 1, 2].map((i) => tabShift(i, 1, 1, 100))).toEqual([0, 0, 0]);
  });
});
