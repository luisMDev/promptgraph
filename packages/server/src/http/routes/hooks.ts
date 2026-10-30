import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/** POST /hooks/:nodeRunId/:event → HookRouter.dispatch; always 204 for known events (never blocks Claude). */
export function registerHookRoutes(app: Hono, ctx: AppContext): void {
  throw new Error("not implemented");
}
