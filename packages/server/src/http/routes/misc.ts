import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/** GET /api/repo · GET/PUT /api/settings · GET /api/commands */
export function registerMiscRoutes(app: Hono, ctx: AppContext): void {
  throw new Error("not implemented");
}
