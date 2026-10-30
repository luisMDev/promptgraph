import { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { webDistDir } from "../config/paths.js";
import { localhostOnly, tokenAuth } from "./auth.js";
import { toApiError } from "./errors.js";
import { registerGraphRoutes } from "./routes/graphs.js";
import { registerHookRoutes } from "./routes/hooks.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerNodeRunRoutes } from "./routes/node-runs.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerStatic } from "./static.js";

/**
 * Hono app: localhostOnly → tokenAuth (all routes, incl. /hooks) → routes → static web (SPA fallback to
 * index.html). Errors: EngineError/GraphLoadError/zod errors → ApiError with 400/404/409/422.
 */
export function createHttpApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", localhostOnly());
  app.use("*", tokenAuth(ctx.token));
  registerMiscRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerNodeRunRoutes(app, ctx);
  registerHookRoutes(app, ctx);
  registerStatic(app, webDistDir(ctx.env));
  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, code: "not_found" }, 404));
  app.onError((err, c) => {
    const { status, body } = toApiError(err);
    if (status >= 500) console.error(err);
    return c.json(body, status);
  });
  return app;
}
