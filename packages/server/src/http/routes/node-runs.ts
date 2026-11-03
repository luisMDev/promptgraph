import {
  ApprovalRequestSchema,
  DiffQuerySchema,
  FailNodeRequestSchema,
  HoldNodeRequestSchema,
  type NodeRun,
  type NodeRunResponse,
  type OkResponse,
} from "@promptgraph/shared";
import type { Context } from "hono";
import { readBody } from "../errors.js";
import { REPO_PREFIX, repoOf, type App, type AppEnv } from "../repo-scope.js";

const P = REPO_PREFIX;

/**
 * Under /api/repos/:repoId: POST …/node-runs/:id/{done,fail,retry,skip,hold} · GET|POST …/node-runs/:id/approval ·
 * GET …/node-runs/:id/diff?scope=lane|node · POST …/node-runs/:id/reopen · DELETE …/ptys/:ptyId (reopened sessions)
 */
export function registerNodeRunRoutes(app: App): void {
  const respond = (c: Context<AppEnv>, nodeRun: NodeRun) => c.json<NodeRunResponse>({ nodeRun });
  const engine = (c: Context<AppEnv>) => repoOf(c).engine;

  app.post(`${P}/node-runs/:id/done`, async (c) => respond(c, await engine(c).done(c.req.param("id"))));
  app.post(`${P}/node-runs/:id/retry`, async (c) => respond(c, await engine(c).retry(c.req.param("id"))));
  app.post(`${P}/node-runs/:id/skip`, async (c) => respond(c, await engine(c).skip(c.req.param("id"))));
  app.post(`${P}/node-runs/:id/fail`, async (c) => {
    const { reason } = await readBody(c, FailNodeRequestSchema);
    return respond(c, await engine(c).fail(c.req.param("id"), reason));
  });
  app.post(`${P}/node-runs/:id/hold`, async (c) => {
    const { hold } = await readBody(c, HoldNodeRequestSchema);
    return respond(c, await engine(c).setHold(c.req.param("id"), hold));
  });

  app.get(`${P}/node-runs/:id/approval`, async (c) => c.json(await engine(c).getApprovalInfo(c.req.param("id"))));
  app.post(`${P}/node-runs/:id/approval`, async (c) => {
    const req = await readBody(c, ApprovalRequestSchema);
    return respond(c, await engine(c).submitApproval(c.req.param("id"), req));
  });

  app.get(`${P}/node-runs/:id/diff`, async (c) => {
    const { scope } = DiffQuerySchema.parse(c.req.query());
    return c.json(await engine(c).getDiff(c.req.param("id"), scope));
  });
  app.post(`${P}/node-runs/:id/reopen`, async (c) => c.json(await engine(c).reopenSession(c.req.param("id"))));
  app.delete(`${P}/ptys/:ptyId`, (c) => {
    engine(c).closeReopenedSession(c.req.param("ptyId"));
    return c.json<OkResponse>({ ok: true });
  });
}
