import {
  GRAPH_CONFLICT_CODE,
  SaveGraphQuerySchema,
  SaveGraphRequestSchema,
  ValidateGraphRequestSchema,
  validateGraph,
  type GetGraphResponse,
  type GraphOverview,
  type GraphRunStats,
  type ListGraphOverviewsResponse,
  type ListGraphsResponse,
  type OkResponse,
  type SaveGraphResponse,
  type ValidateGraphResponse,
} from "@promptgraph/shared";
import { SUPPORTED_PHASE } from "../../config/version.js";
import type { DaemonContext } from "../../daemon/context.js";
import { HttpError, readBody } from "../errors.js";
import { REPO_PREFIX, repoOf, type App } from "../repo-scope.js";

const P = REPO_PREFIX;

const NO_RUNS: GraphRunStats = { total: 0, active: 0, costUsd: 0, lastRun: null };

/** …/graphs · …/graph-overviews · GET/PUT/DELETE …/graphs/:id · POST …/graphs/:id/validate · POST …/graphs/:id/runs (under /api/repos/:repoId) */
export function registerGraphRoutes(app: App, daemon: DaemonContext): void {
  const { store } = daemon;
  app.get(`${P}/graphs`, (c) => c.json<ListGraphsResponse>({ graphs: repoOf(c).graphs.list() }));

  // The graph list with what each card shows (DESIGN §13.3): a thumbnail (node types and positions, edges) and the
  // graph's run stats. A graph that fails to load (or is removed meanwhile) has no thumbnail.
  app.get(`${P}/graph-overviews`, (c) => {
    const { graphs, repo } = repoOf(c);
    const stats = store.graphRunStats(repo.path);
    const overviews = graphs.list().map((item): GraphOverview => {
      let preview: GraphOverview["preview"] = null;
      if (!item.loadError) {
        try {
          const { graph } = graphs.get(item.id);
          preview = {
            nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, x: n.position.x, y: n.position.y })),
            edges: graph.edges.map((e) => ({ source: e.source, target: e.target })),
          };
        } catch {
          preview = null;
        }
      }
      return { ...item, preview, runs: stats.get(item.id) ?? NO_RUNS };
    });
    return c.json<ListGraphOverviewsResponse>({ graphs: overviews });
  });

  app.get(`${P}/graphs/:id`, (c) => {
    const { graphs, engine, repo } = repoOf(c);
    const id = c.req.param("id");
    const { graph, hash } = graphs.get(id);
    return c.json<GetGraphResponse>({
      graph,
      hash,
      modifiedOutside: store.getKnownGraphHash(repo.path, id) !== hash,
      activeRunId: engine.activeRunForGraph(id),
    });
  });

  // 409 while a run is active comes from the engine's GraphStore write guard. With ?baseHash= the save
  // is also refused (409 graph_conflict) when the file changed since the caller read it (§21.7).
  app.put(`${P}/graphs/:id`, async (c) => {
    const { graphs, repo } = repoOf(c);
    const id = c.req.param("id");
    const { baseHash } = SaveGraphQuerySchema.parse({ baseHash: c.req.query("baseHash") || undefined });
    const body = await readBody(c, SaveGraphRequestSchema);
    if (body.id !== id) throw new HttpError(400, "id_mismatch", `Graph id "${body.id}" does not match the URL id "${id}"`);
    if (baseHash !== undefined) {
      // Check and write are synchronous, so no other save can slip in between.
      const current = graphs.currentHash(id);
      if (current !== baseHash) {
        const message =
          current === null
            ? `Graph "${id}" does not exist anymore; it was deleted since it was read`
            : `Graph "${id}" changed since it was read (hash ${baseHash.slice(0, 12)}… is stale); read it again and retry`;
        throw new HttpError(409, GRAPH_CONFLICT_CODE, message, { currentHash: current });
      }
    }
    const { graph, hash } = graphs.save(body);
    store.setKnownGraphHash(repo.path, id, hash);
    return c.json<SaveGraphResponse>({ graph, hash });
  });

  app.delete(`${P}/graphs/:id`, (c) => {
    repoOf(c).graphs.delete(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.post(`${P}/graphs/:id/validate`, async (c) => {
    const { graphs, engine } = repoOf(c);
    const body = await readBody(c, ValidateGraphRequestSchema);
    const graph = body.graph ?? graphs.get(c.req.param("id")).graph;
    return c.json<ValidateGraphResponse>(validateGraph(graph, { phase: SUPPORTED_PHASE, supportedNodeTypes: engine.supportedNodeTypes() }));
  });

  app.post(`${P}/graphs/:id/runs`, async (c) => c.json(await repoOf(c).engine.startRun(c.req.param("id"))));
}
