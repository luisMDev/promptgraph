import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/**
 * POST /api/node-runs/:id/{done,fail,retry,skip,hold} · GET|POST /api/node-runs/:id/approval ·
 * GET /api/node-runs/:id/diff · POST /api/node-runs/:id/reopen
 */
export function registerNodeRunRoutes(app: Hono, ctx: AppContext): void {
  throw new Error("not implemented");
}
