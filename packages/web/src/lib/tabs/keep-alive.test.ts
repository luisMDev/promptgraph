import { describe, expect, it } from "vitest";
import { planMounted } from "./keep-alive";

const ids = ["a", "b", "c", "d", "e", "f", "g"];

describe("keep-alive plan (DESIGN §13.4)", () => {
  it("adds the active view and evicts the least recently used beyond the maximum", () => {
    const mru = ["g", "f", "e", "d", "c", "b", "a"];
    expect(planMounted(["a", "b", "c", "d", "e", "f"], { tabIds: ids, activeId: "g", mru, pinned: () => false })).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("never evicts a pinned (dirty editor) view or the active one", () => {
    const mru = ["g", "f", "e", "d", "c", "b", "a"];
    expect(planMounted(["a", "b", "c", "d", "e", "f"], { tabIds: ids, activeId: "g", mru, pinned: (id) => id === "a" })).toEqual(["a", "c", "d", "e", "f", "g"]);
    expect(planMounted(["a", "b"], { tabIds: ids, activeId: "c", mru: ["c", "b", "a"], pinned: () => true, max: 2 })).toEqual(["a", "b", "c"]);
  });

  it("drops closed tabs and returns the same array when nothing changes", () => {
    const mounted = ["a", "b"];
    expect(planMounted(mounted, { tabIds: ids, activeId: "a", mru: ["a", "b"], pinned: () => false })).toBe(mounted);
    expect(planMounted(mounted, { tabIds: ["a"], activeId: "a", mru: ["a"], pinned: () => false })).toEqual(["a"]);
  });
});
