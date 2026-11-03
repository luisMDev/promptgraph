import { API, type ListReposResponse } from "@promptgraph/shared";
import { findDaemon } from "../../daemon/client.js";
import { ApiRequestError } from "../../mcp/client.js";
import type { CliOptions } from "../args.js";
import { CliError, findRegistered, NOT_RUNNING, runCommand, type CliDeps } from "../deps.js";

/**
 * `promptgraph rm|close <repo-dir|repo-id> [--force]` (DESIGN §4.2): DELETE /api/repos/:repoId. Refused
 * (409 repo_active) while the repository has a running run, unless `--force`, which shuts its engine
 * down first (its runs are paused, resumable). Never deletes graph files, runs, worktrees or branches.
 */
export function runRm(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const conn = await findDaemon(deps.paths, { version: deps.version, fetchImpl: deps.fetchImpl });
    if (!conn) throw new CliError(NOT_RUNNING);
    const target = opts.target!;
    const { repos } = await conn.client.get<ListReposResponse>(API.repos);
    const repo = await findRegistered(repos, target, deps.cwd);
    if (!repo) throw new CliError(`${target} is not a registered repository (see promptgraph ls)`);
    try {
      await conn.client.delete(API.removeRepo(repo.id, opts.force));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409 && err.code === "repo_active") {
        throw new CliError(
          `${repo.name} has a running run; cancel it first, or pass --force to interrupt it (its runs are paused and stay resumable)`,
        );
      }
      throw err;
    }
    deps.stdout(`Removed ${repo.name} (${repo.id}). Its graphs, runs and worktrees are kept; promptgraph ${repo.path} adds it back.`);
    return 0;
  });
}
