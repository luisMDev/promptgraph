import { webRoutes } from "@promptgraph/shared";

/**
 * The views of the web app (DESIGN §13.2). Paths are built and parsed with the shared `webRoutes`, so the
 * CLI, `promptgraph mcp` and the desktop shell link to exactly what this router understands.
 */
export type Route =
  | { kind: "home" }
  | { kind: "repo"; repoId: string }
  | { kind: "graph"; repoId: string; graphId: string }
  | { kind: "run"; repoId: string; runId: string }
  | { kind: "nodeRun"; repoId: string; runId: string; nodeRunId: string }
  | { kind: "report"; repoId: string; runId: string }
  | { kind: "notFound"; path: string };

export type RepoRoute = Extract<Route, { repoId: string }>;

function decode(seg: string): string | null {
  try {
    const s = decodeURIComponent(seg);
    return s === "" ? null : s;
  } catch {
    return null;
  }
}

/** Parses a path (query and fragment ignored; a trailing slash is allowed). Anything else is `notFound`. */
export function parseRoute(path: string): Route {
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const segs = pathname.split("/").filter((s, i, all) => !(s === "" && (i === 0 || i === all.length - 1)));
  const notFound: Route = { kind: "notFound", path };
  if (segs.length === 0) return { kind: "home" };
  if (segs[0] !== "r" || segs.length < 2) return notFound;
  // Odd positions after "r" are ids (decoded), even ones are fixed words.
  const [repoId, section, id, sub, subId] = segs.slice(1).map((s, i) => (i % 2 === 0 ? decode(s) : s));
  if (!repoId) return notFound;
  if (segs.length === 2) return { kind: "repo", repoId };
  if (section === "graphs" && id && segs.length === 4) return { kind: "graph", repoId, graphId: id };
  if (section !== "runs" || !id) return notFound;
  if (segs.length === 4) return { kind: "run", repoId, runId: id };
  if (segs.length === 5 && sub === "report") return { kind: "report", repoId, runId: id };
  if (segs.length === 6 && sub === "nodes" && subId) return { kind: "nodeRun", repoId, runId: id, nodeRunId: subId };
  return notFound;
}

/** Path of a route (`notFound` keeps its path). */
export function routeHref(route: Route): string {
  switch (route.kind) {
    case "home":
      return webRoutes.home();
    case "repo":
      return webRoutes.repo(route.repoId);
    case "graph":
      return webRoutes.graph(route.repoId, route.graphId);
    case "run":
      return webRoutes.run(route.repoId, route.runId);
    case "nodeRun":
      return webRoutes.nodeRun(route.repoId, route.runId, route.nodeRunId);
    case "report":
      return webRoutes.report(route.repoId, route.runId);
    case "notFound":
      return route.path;
  }
}

/** Run id of the run-scoped routes, else null. */
export function routeRunId(route: Route): string | null {
  return route.kind === "run" || route.kind === "nodeRun" || route.kind === "report" ? route.runId : null;
}

export function isRepoRoute(route: Route): route is RepoRoute {
  return "repoId" in route;
}
