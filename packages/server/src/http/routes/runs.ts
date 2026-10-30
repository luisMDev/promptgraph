import { ListRunsQuerySchema, type ListRunsResponse, type OkResponse, type PendingResponse } from "@promptgraph/shared";
import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/** GET /api/runs · GET /api/runs/:id · POST /api/runs/:id/cancel · POST /api/runs/:id/cleanup · GET /api/pending */
export function registerRunRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/runs", (c) => {
    const query = ListRunsQuerySchema.parse(c.req.query());
    const runs = ctx.store.listRuns({ repoPath: ctx.repo.path, graphId: query.graph, limit: query.limit });
    return c.json<ListRunsResponse>({ runs });
  });

  app.get("/api/runs/:id", (c) => c.json(ctx.engine.getRun(c.req.param("id"))));

  app.post("/api/runs/:id/cancel", async (c) => {
    await ctx.engine.cancelRun(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.post("/api/runs/:id/cleanup", async (c) => {
    await ctx.engine.cleanupRun(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.get("/api/pending", (c) => {
    const nodeRuns = ctx.store
      .listNodeRunsByStatus(["waiting_approval"])
      .filter((nr) => ctx.store.getRun(nr.runId)?.repoPath === ctx.repo.path);
    return c.json<PendingResponse>({ nodeRuns });
  });
}
