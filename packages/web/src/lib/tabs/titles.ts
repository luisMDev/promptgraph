import type { GraphListItem } from "@promptgraph/shared";
import type { Route } from "../router/routes";

/** What is known about a tab's route; anything missing falls back (DESIGN §13.4 Titles). */
export interface TabTitleData {
  repoName?: string | null;
  graphs?: GraphListItem[] | null;
  /** The run the route shows, once loaded (a mounted view knows it). */
  run?: { graphName: string; shortId: string } | null;
  /** Label of the node of a nodeRun route, once loaded. */
  nodeLabel?: string | null;
}

/** The title of a route's shape alone: never a raw id. */
export function routeShapeTitle(route: Route): string {
  switch (route.kind) {
    case "home":
      return "Home";
    case "repo":
      return "Repository";
    case "graph":
      return "Graph";
    case "run":
      return "Run";
    case "nodeRun":
      return "Step";
    case "report":
      return "Report";
    case "notFound":
      return "Not found";
  }
}

/** The title from data alone, or null when the data it needs is not known. */
export function tabTitleFromData(route: Route, d: TabTitleData): string | null {
  switch (route.kind) {
    case "home":
      return "Home";
    case "notFound":
      return "Not found";
    case "repo":
      return d.repoName ?? null;
    case "graph": {
      const graph = d.graphs?.find((g) => g.id === route.graphId)?.name;
      if (!graph) return null;
      return d.repoName ? `${d.repoName} · ${graph}` : graph;
    }
    case "run":
      return d.run ? `${d.run.graphName} #${d.run.shortId}` : null;
    case "nodeRun":
      return d.run && d.nodeLabel ? `${d.nodeLabel} · #${d.run.shortId}` : null;
    case "report":
      return d.run ? `Report #${d.run.shortId}` : null;
  }
}

/**
 * A tab's title (DESIGN §13.4): `<repo> · <graph>`, `<graph> #<shortId>`, `<node label> · #<shortId>`,
 * `Report #<shortId>`, `Home`, the repository's name for `/r/<repoId>`. Without the data: the title last
 * derived for this path (`persisted`), else the route's shape (`Run`, `Step`…), never a raw id.
 */
export function deriveTabTitle(route: Route, data: TabTitleData, persisted?: string): string {
  const known = tabTitleFromData(route, data);
  if (known) return known;
  if (persisted) return persisted;
  const shape = routeShapeTitle(route);
  return route.kind === "graph" && data.repoName ? `${data.repoName} · ${shape}` : shape;
}
