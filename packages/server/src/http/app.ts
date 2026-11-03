import { Hono } from "hono";
import { webDistDir } from "../config/paths.js";
import type { DaemonContext } from "../daemon/context.js";
import { localhostOnly, tokenAuth } from "./auth.js";
import { toApiError } from "./errors.js";
import { registerRepoScope, type AppEnv } from "./repo-scope.js";
import { registerDaemonRoutes } from "./routes/daemon.js";
import { registerGraphRoutes } from "./routes/graphs.js";
import { registerHookRoutes } from "./routes/hooks.js";
import { registerRepoMiscRoutes, registerSettingsRoutes } from "./routes/misc.js";
import { registerNodeRunRoutes } from "./routes/node-runs.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerStatic } from "./static.js";

/**
 * Hono app of the daemon: localhostOnly (port getter) → tokenAuth (per-request token; hook tokens; public
 * hello) → daemon routes (/api/daemon, /api/repos, /api/settings, /hooks) → repository scope
 * (/api/repos/:repoId/*: load, activate before non-GET) → repository routes → static web (SPA fallback
 * to index.html). Errors: HttpError/EngineError/GraphLoadError/zod errors → ApiError with 4xx/5xx.
 */
export function createHttpApp(daemon: DaemonContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", localhostOnly(() => daemon.port));
  app.use("*", tokenAuth({ getToken: () => daemon.getToken(), hookSecret: daemon.hookSecret }));
  registerDaemonRoutes(app, daemon);
  registerSettingsRoutes(app, daemon);
  registerHookRoutes(app, daemon);
  registerRepoScope(app, daemon);
  registerRepoRoutes(app, daemon);
  registerGraphRoutes(app, daemon);
  registerRunRoutes(app, daemon);
  registerNodeRunRoutes(app);
  registerRepoMiscRoutes(app, daemon);
  registerStatic(app, webDistDir(daemon.env));
  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, code: "not_found" }, 404));
  app.onError((err, c) => {
    const { status, body } = toApiError(err);
    if (status >= 500) console.error(err);
    return c.json(body, status);
  });
  return app;
}
