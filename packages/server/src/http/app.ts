import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";

/**
 * Hono app: localhostOnly → tokenAuth (all routes, incl. /hooks) → routes → static web (SPA fallback to
 * index.html). Errors: EngineError/GraphLoadError/zod errors → ApiError with 400/404/409/422.
 */
export function createHttpApp(ctx: AppContext): Hono {
  throw new Error("not implemented");
}
