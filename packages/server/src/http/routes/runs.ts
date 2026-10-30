import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/** GET /api/runs · GET /api/runs/:id · POST /api/runs/:id/cancel · POST /api/runs/:id/cleanup · GET /api/pending */
export function registerRunRoutes(app: Hono, ctx: AppContext): void {
  throw new Error("not implemented");
}
