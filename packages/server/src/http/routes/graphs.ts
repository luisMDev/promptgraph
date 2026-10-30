import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/** GET /api/graphs · GET/PUT/DELETE /api/graphs/:id · POST /api/graphs/:id/validate · POST /api/graphs/:id/runs */
export function registerGraphRoutes(app: Hono, ctx: AppContext): void {
  throw new Error("not implemented");
}
