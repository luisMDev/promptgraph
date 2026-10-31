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
import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";
import { SUPPORTED_PHASE } from "../../config/version.js";
import { HttpError, readBody } from "../errors.js";

/** GET /api/graphs · GET/PUT/DELETE /api/graphs/:id · POST /api/graphs/:id/validate · POST /api/graphs/:id/runs */
export function registerGraphRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/graphs", (c) => c.json<ListGraphsResponse>({ graphs: ctx.graphs.list() }));

  app.get("/api/graphs/:id", (c) => {
    const id = c.req.param("id");
    const { graph, hash } = ctx.graphs.get(id);
    return c.json<GetGraphResponse>({
      graph,
      hash,
      modifiedOutside: ctx.store.getKnownGraphHash(ctx.repo.path, id) !== hash,
      activeRunId: ctx.engine.activeRunForGraph(id),
    });
  });

  // 409 while a run is active comes from the engine's GraphStore write guard.
  app.put("/api/graphs/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c, SaveGraphRequestSchema);
    if (body.id !== id) throw new HttpError(400, "id_mismatch", `Graph id "${body.id}" does not match the URL id "${id}"`);
    const { graph, hash } = ctx.graphs.save(body);
    ctx.store.setKnownGraphHash(ctx.repo.path, id, hash);
    return c.json<SaveGraphResponse>({ graph, hash });
  });

  app.delete("/api/graphs/:id", (c) => {
    ctx.graphs.delete(c.req.param("id"));
    return c.json<OkResponse>({ ok: true });
  });

  app.post("/api/graphs/:id/validate", async (c) => {
    const body = await readBody(c, ValidateGraphRequestSchema);
    const graph = body.graph ?? ctx.graphs.get(c.req.param("id")).graph;
    return c.json<ValidateGraphResponse>(validateGraph(graph, { phase: SUPPORTED_PHASE, supportedNodeTypes: ctx.engine.supportedNodeTypes() }));
  });

  app.post("/api/graphs/:id/runs", async (c) => c.json(await ctx.engine.startRun(c.req.param("id"))));
}
