import { webRoutes } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, routeRunId, type Route } from "./routes";

const R = "demo-0123abcd";

describe("routes", () => {
  it("parses every route of DESIGN §13.2", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute(`/r/${R}`)).toEqual({ kind: "repo", repoId: R });
    expect(parseRoute(`/r/${R}/graphs/g1`)).toEqual({ kind: "graph", repoId: R, graphId: "g1" });
    expect(parseRoute(`/r/${R}/runs/run1`)).toEqual({ kind: "run", repoId: R, runId: "run1" });
    expect(parseRoute(`/r/${R}/runs/run1/nodes/nr1`)).toEqual({ kind: "nodeRun", repoId: R, runId: "run1", nodeRunId: "nr1" });
    expect(parseRoute(`/r/${R}/runs/run1/report`)).toEqual({ kind: "report", repoId: R, runId: "run1" });
  });

  it("round-trips through the shared webRoutes, encoded ids included", () => {
    const routes: Route[] = [
      { kind: "home" },
      { kind: "repo", repoId: R },
      { kind: "graph", repoId: R, graphId: "my graph/ü" },
      { kind: "run", repoId: R, runId: "r 1" },
      { kind: "nodeRun", repoId: R, runId: "r1", nodeRunId: "n/1" },
      { kind: "report", repoId: R, runId: "r1" },
    ];
    for (const route of routes) expect(parseRoute(routeHref(route))).toEqual(route);
    expect(routeHref({ kind: "graph", repoId: R, graphId: "a b" })).toBe(webRoutes.graph(R, "a b"));
  });

  it("ignores a trailing slash, the query and the fragment", () => {
    expect(parseRoute(`/r/${R}/graphs/g1/`)).toEqual({ kind: "graph", repoId: R, graphId: "g1" });
    expect(parseRoute(`/r/${R}/runs/r1?x=1#top`)).toEqual({ kind: "run", repoId: R, runId: "r1" });
  });

  it("anything else is notFound", () => {
    for (const path of ["/r", "/r/", `/r/${R}/graphs`, `/r/${R}/graphs/g1/extra`, `/r/${R}/runs/r1/nodes`, `/r/${R}/runs/r1/other`, "/settings", "/r/%E0%A4%A/graphs/g", `/r/${R}//g1`]) {
      expect(parseRoute(path), path).toEqual({ kind: "notFound", path });
    }
  });

  it("routeRunId", () => {
    expect(routeRunId(parseRoute(`/r/${R}/runs/r1/report`))).toBe("r1");
    expect(routeRunId(parseRoute(`/r/${R}/graphs/g1`))).toBeNull();
  });
});
