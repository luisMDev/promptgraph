import { AddRepoRequestSchema, RemoveRepoQuerySchema, type ListReposResponse, type OkResponse, type RepoInfoResponse, type RepoSummary } from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import { currentBranch, listBranches } from "../../git/repo.js";
import { readBody } from "../errors.js";
import { REPO_PREFIX, type App } from "../repo-scope.js";

/**
 * GET /api/repos · POST /api/repos {path} · DELETE /api/repos/:repoId?force=1 · GET /api/repos/:repoId
 * (DESIGN §12.1). Only POST activates; GET loads without side effects.
 */
export function registerRepoRoutes(app: App, daemon: DaemonContext): void {
  const { registry } = daemon;
  app.get("/api/repos", (c) => c.json<ListReposResponse>({ repos: registry.list() }));

  app.post("/api/repos", async (c) => {
    const { path } = await readBody(c, AddRepoRequestSchema);
    return c.json<RepoSummary>(await registry.add(path));
  });

  app.delete(REPO_PREFIX, async (c) => {
    const { force } = RemoveRepoQuerySchema.parse(c.req.query());
    await registry.remove(c.req.param("repoId"), { force: force === "1" });
    return c.json<OkResponse>({ ok: true });
  });

  app.get(REPO_PREFIX, async (c) => {
    const { repo } = await registry.load(c.req.param("repoId"));
    const [branch, branches] = await Promise.all([currentBranch(repo.path), listBranches(repo.path)]);
    return c.json<RepoInfoResponse>({ id: repo.id, path: repo.path, name: repo.name, currentBranch: branch, branches });
  });
}
