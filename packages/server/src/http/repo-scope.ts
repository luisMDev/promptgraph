import type { Context, Hono } from "hono";
import type { DaemonContext } from "../daemon/context.js";
import type { RepoContext } from "../daemon/repo-context.js";

/** Hono environment of the daemon app: repository routes find their RepoContext in `c.get("repo")`. */
export type AppEnv = { Variables: { repo: RepoContext } };
export type App = Hono<AppEnv>;

/** Prefix of every repository route (DESIGN §12.1). */
export const REPO_PREFIX = "/api/repos/:repoId";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** A path below a repository (`/api/repos/<id>/<something>`), not the bare prefix. */
const REPO_SUBPATH = /^\/api\/repos\/[^/]+\/./;

/**
 * `/api/repos/:repoId/*`: loads the repository's context for every request (404 unknown_repo, 409
 * repo_unavailable; waits while it is being removed) and activates it before any non-GET request, so a
 * GET never makes the daemon write into a repository (DESIGN §4.2, §14). The prefix itself
 * (`GET`/`DELETE /api/repos/:repoId`) is skipped here (Hono's trailing `/*` also matches the bare
 * prefix) and handled by the repos routes: removing a repository must never load or activate it.
 */
export function registerRepoScope(app: App, daemon: DaemonContext): void {
  app.use(`${REPO_PREFIX}/*`, async (c, next) => {
    if (!REPO_SUBPATH.test(c.req.path)) return next();
    const repoId = c.req.param("repoId")!;
    const repo = SAFE_METHODS.has(c.req.method) ? await daemon.registry.load(repoId) : await daemon.registry.activate(repoId);
    c.set("repo", repo);
    await next();
  });
}

/** The RepoContext set by registerRepoScope. */
export function repoOf(c: Context<AppEnv>): RepoContext {
  return c.get("repo");
}
