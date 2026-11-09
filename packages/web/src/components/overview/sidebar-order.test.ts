import { describe, expect, it } from "vitest";
import { summaryOf } from "../../test-daemon";
import { arrangeRepos, clampSidebarWidth, moveRepo, positionOf, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar-order";

const repos = ["a", "b", "c", "d"].map((id) => summaryOf({ id, name: id }));
const names = (list: { id: string }[]) => list.map((r) => r.id);

describe("repositories column order (DESIGN §13.3)", () => {
  it("puts favourites first, each section in the user's order, unplaced repositories last in the daemon's order", () => {
    const arranged = arrangeRepos(repos, ["c", "gone", "a"], ["a", "d"]);
    expect(names(arranged.favorites)).toEqual(["a", "d"]);
    expect(names(arranged.others)).toEqual(["c", "b"]);
  });

  it("moves a repository within its own section and returns the full order", () => {
    const arranged = arrangeRepos(repos, [], ["d"]);
    expect(moveRepo(arranged, "c", 0)).toEqual(["d", "c", "a", "b"]);
    expect(moveRepo(arranged, "a", 99)).toEqual(["d", "b", "c", "a"]);
    expect(moveRepo(arranged, "nope", 0)).toEqual(["d", "a", "b", "c"]);
    expect(positionOf(arranged, "d")).toEqual({ section: "favorites", index: 0 });
    expect(positionOf(arranged, "c")).toEqual({ section: "others", index: 2 });
  });

  it("clamps the column's width", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(250.4)).toBe(250);
  });
});
