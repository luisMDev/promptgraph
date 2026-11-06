import { describe, expect, it } from "vitest";
import { parseRoute } from "../router/routes";
import { deriveTabTitle } from "./titles";

const R = "/r/repo-0123abcd";
const graphs = [{ id: "g1", name: "Ship it", loadError: null, updatedAt: 1, hash: "h" }];
const run = { graphName: "Ship it", shortId: "3f9a" };

describe("tab titles (DESIGN §13.4)", () => {
  it("derives the documented shapes from data", () => {
    expect(deriveTabTitle(parseRoute("/"), {})).toBe("Home");
    expect(deriveTabTitle(parseRoute(`${R}/graphs/g1`), { repoName: "repo", graphs })).toBe("repo · Ship it");
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1`), { run })).toBe("Ship it #3f9a");
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1/nodes/n1`), { run, nodeLabel: "Implement" })).toBe("Implement · #3f9a");
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1/report`), { run })).toBe("Report #3f9a");
    expect(deriveTabTitle(parseRoute(R), { repoName: "repo" })).toBe("repo");
  });

  it("falls back to the persisted title, then to the route's shape, never a raw id", () => {
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1`), {}, "Ship it #3f9a")).toBe("Ship it #3f9a");
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1`), {})).toBe("Run");
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1/nodes/n1`), {})).toBe("Step");
    expect(deriveTabTitle(parseRoute(`${R}/runs/r1/report`), {})).toBe("Report");
    expect(deriveTabTitle(parseRoute(`${R}/graphs/g2`), { repoName: "repo", graphs })).toBe("repo · Graph");
    expect(deriveTabTitle(parseRoute(R), {})).toBe("Repository");
    expect(deriveTabTitle(parseRoute("/nope"), {})).toBe("Not found");
    // Data wins over a stale persisted title (a renamed graph).
    expect(deriveTabTitle(parseRoute(`${R}/graphs/g1`), { repoName: "repo", graphs }, "repo · Old name")).toBe("repo · Ship it");
  });
});
