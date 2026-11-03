import { ListRunsQuerySchema, type ListRunsResponse, type OkResponse, type PendingResponse } from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import { REPO_PREFIX, repoOf, type App } from "../repo-scope.js";

const P = REPO_PREFIX;

/**
 * Under /api/repos/:repoId: GET …/runs · GET …/runs/:id · GET …/runs/:id/report · GET …/runs/:id/lanes/:laneId/diff ·
 * POST …/runs/:id/{cancel,resume,cleanup} · GET …/pending. Another repository's run ids are not_found (its engine owns them).
 */
export function registerRunRoutes(app: App, daemon: DaemonContext): void {
  const { store } = daemon;
  app.get(`${P}/runs`, (c) => {
    const query = ListRunsQuerySchema.parse(c.req.query());
    const runs = store.listRuns({ repoPath: repoOf(c).repo.path, graphId: query.graph, limit: query.limit });
    return c.json<ListRunsResponse>({ runs });
  });

  app.get(`${P}/runs/:id`, (c) => c.json(repoOf(c).engine.getRun(c.req.param("id"))));
  app.get(`${P}/runs/:id/report`, async (c) => c.json(await repoOf(c).engine.getReport(c.req.param("id"))));
  app.get(`${P}/runs/:id/lanes/:laneId/diff`, async (c) => c.json(await repoOf(c).engine.getLaneDiff(c.req.param("id"), c.req.param("laneId"))));

  app.post(`${P}/runs/:id/cancel`, async (c) => {
    await repoOf(c).engine.cancelRun(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.post(`${P}/runs/:id/resume`, async (c) => {
    await repoOf(c).engine.resumeRun(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.post(`${P}/runs/:id/cleanup`, async (c) => {
    await repoOf(c).engine.cleanupRun(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.get(`${P}/pending`, (c) => {
    const nodeRuns = store.listNodeRunsByStatus(["waiting_approval"], { repoPath: repoOf(c).repo.path });
    return c.json<PendingResponse>({ nodeRuns });
  });
}
