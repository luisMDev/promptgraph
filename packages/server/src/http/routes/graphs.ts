import {
  SaveGraphRequestSchema,
  ValidateGraphRequestSchema,
  validateGraph,
  type GetGraphResponse,
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

/** …/graphs · GET/PUT/DELETE …/graphs/:id · POST …/graphs/:id/validate · POST …/graphs/:id/runs (under /api/repos/:repoId) */
export function registerGraphRoutes(app: App, daemon: DaemonContext): void {
  const { store } = daemon;
  app.get(`${P}/graphs`, (c) => c.json<ListGraphsResponse>({ graphs: repoOf(c).graphs.list() }));

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

  // 409 while a run is active comes from the engine's GraphStore write guard.
  app.put(`${P}/graphs/:id`, async (c) => {
    const { graphs, repo } = repoOf(c);
    const id = c.req.param("id");
    const body = await readBody(c, SaveGraphRequestSchema);
    if (body.id !== id) throw new HttpError(400, "id_mismatch", `Graph id "${body.id}" does not match the URL id "${id}"`);
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
