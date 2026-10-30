import {
  ApprovalRequestSchema,
  FailNodeRequestSchema,
  HoldNodeRequestSchema,
  type NodeRun,
  type NodeRunResponse,
  type OkResponse,
} from "@promptgraph/shared";
import type { Context, Hono } from "hono";
import type { AppContext } from "../../app/context.js";
import { readBody } from "../errors.js";

/**
 * POST /api/node-runs/:id/{done,fail,retry,skip,hold} · GET|POST /api/node-runs/:id/approval ·
 * GET /api/node-runs/:id/diff · POST /api/node-runs/:id/reopen · DELETE /api/ptys/:ptyId (reopened sessions)
 */
export function registerNodeRunRoutes(app: Hono, ctx: AppContext): void {
  const { engine } = ctx;
  const respond = (c: Context, nodeRun: NodeRun) => c.json<NodeRunResponse>({ nodeRun });

  app.post("/api/node-runs/:id/done", async (c) => respond(c, await engine.done(c.req.param("id"))));
  app.post("/api/node-runs/:id/retry", async (c) => respond(c, await engine.retry(c.req.param("id"))));
  app.post("/api/node-runs/:id/skip", async (c) => respond(c, await engine.skip(c.req.param("id"))));
  app.post("/api/node-runs/:id/fail", async (c) => {
    const { reason } = await readBody(c, FailNodeRequestSchema);
    return respond(c, await engine.fail(c.req.param("id"), reason));
  });
  app.post("/api/node-runs/:id/hold", async (c) => {
    const { hold } = await readBody(c, HoldNodeRequestSchema);
    return respond(c, await engine.setHold(c.req.param("id"), hold));
  });

  app.get("/api/node-runs/:id/approval", async (c) => c.json(await engine.getApprovalInfo(c.req.param("id"))));
  app.post("/api/node-runs/:id/approval", async (c) => {
    const req = await readBody(c, ApprovalRequestSchema);
    return respond(c, await engine.submitApproval(c.req.param("id"), req));
  });

  app.get("/api/node-runs/:id/diff", async (c) => c.json(await engine.getDiff(c.req.param("id"))));
  app.post("/api/node-runs/:id/reopen", async (c) => c.json(await engine.reopenSession(c.req.param("id"))));
  app.delete("/api/ptys/:ptyId", (c) => {
    engine.closeReopenedSession(c.req.param("ptyId"));
    return c.json<OkResponse>({ ok: true });
  });
}
