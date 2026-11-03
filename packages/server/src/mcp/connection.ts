import fs from "node:fs";
import path from "node:path";
import { API, type RepoApiPaths } from "@promptgraph/shared";
import { isInWorktreesDir, type PgPaths } from "../config/paths.js";
import { VERSION } from "../config/version.js";
import { ensureDaemon, findDaemon, registerRepo, type DaemonConnection, type EnsuredDaemon } from "../daemon/client.js";
import { resolveMainWorktree, resolveRepoRoot } from "../git/repo.js";
import { errorMessage } from "../util/text.js";
import { ApiRequestError, PromptgraphClient } from "./client.js";

/** Where the MCP server runs and how it reaches the daemon (DESIGN §19.1, §19.2). */
export interface McpEnvironment {
  /** Directory Claude Code started the MCP server in (the project); `PROMPTGRAPH_REPO` overrides it. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  paths: PgPaths;
  /** argv that runs this promptgraph CLI ([node, ...execArgv, entry]); ensureDaemon appends `daemon`. */
  serverCommand: readonly string[];
  fetchImpl?: typeof fetch;
  /** Version the daemon must have (default VERSION). */
  version?: string;
}

/** The daemon and this repository's registration: every repository call goes through `api`. */
export interface Connection {
  daemon: DaemonConnection;
  client: PromptgraphClient;
  repoPath: string;
  repoId: string;
  api: RepoApiPaths;
}

export const NOT_RUNNING = "promptgraph is not running; call start_server";

/** Git top level (realpath) per directory: it does not change while the MCP server runs (one git call per dir). */
const repoRoots = new Map<string, Promise<string>>();

/**
 * The repository a tool works on: the git top level (realpath) of `repo`, `PROMPTGRAPH_REPO` or the cwd.
 * Inside a lane worktree (a Claude step of a run calling the plugin's tools) it is the repository that
 * worktree belongs to: a lane worktree is never registered as a repository of its own (DESIGN §19.2).
 */
export function resolveRepo(mcpEnv: McpEnvironment, repo?: string): Promise<string> {
  const dir = path.resolve(mcpEnv.cwd, repo ?? mcpEnv.env.PROMPTGRAPH_REPO ?? mcpEnv.cwd);
  let root = repoRoots.get(dir);
  if (!root) {
    root = resolveRepoRoot(dir)
      .then((r) => fs.realpathSync(r))
      .catch(() => {
        throw new Error(`${dir} is not inside a git repository; promptgraph works on git repositories.`);
      })
      .then(async (top) => {
        if (!isInWorktreesDir(mcpEnv.paths, top)) return top;
        let main: string;
        try {
          main = fs.realpathSync(await resolveMainWorktree(top));
        } catch (err) {
          throw new Error(`${top} is a promptgraph lane worktree whose repository could not be found: ${errorMessage(err)}`);
        }
        if (isInWorktreesDir(mcpEnv.paths, main)) throw new Error(`${top} is a promptgraph lane worktree; pass the repository it belongs to as repo.`);
        return main;
      })
      .catch((err: unknown) => {
        repoRoots.delete(dir);
        throw err;
      });
    repoRoots.set(dir, root);
  }
  return root;
}

/** repoId per (daemon pid + start time, repository path): a restarted daemon re-registers once. */
const repoIds = new Map<string, string>();
const cacheKey = (d: DaemonConnection, repoPath: string) => `${d.info.pid}:${d.info.pidStart}:${repoPath}`;

/** The verified daemon of this client's version, or null. @throws DaemonVersionMismatch (its message is the §4.1 item 4 text). */
export function findConnection(mcpEnv: McpEnvironment): Promise<DaemonConnection | null> {
  return findDaemon(mcpEnv.paths, { version: mcpEnv.version ?? VERSION, fetchImpl: mcpEnv.fetchImpl });
}

const isUnknownRepo = (err: unknown): boolean => err instanceof ApiRequestError && err.status === 404 && err.code === "unknown_repo";

/**
 * Client of one repository's connection. The cached repoId outlives a removal while the same daemon keeps
 * running (DELETE /api/repos/:repoId from the UI or another client): a repository call answered 404
 * unknown_repo re-registers the repository once and retries under the id it got back (the same one: ids
 * derive from the path). Retrying is safe, the daemon did nothing for an unknown repository.
 */
class RepoClient extends PromptgraphClient {
  constructor(
    daemon: DaemonConnection,
    private readonly repoPath: string,
    private repoId: string,
    private readonly key: string,
    fetchImpl?: typeof fetch,
  ) {
    super(daemon.origin, daemon.token, fetchImpl);
  }

  protected override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await super.request<T>(method, path, body);
    } catch (err) {
      const base = API.repo(this.repoId).info;
      if (!isUnknownRepo(err) || (path !== base && !path.startsWith(`${base}/`))) throw err;
      repoIds.delete(this.key);
      this.repoId = (await registerRepo(this, this.repoPath)).id;
      repoIds.set(this.key, this.repoId);
      return super.request<T>(method, `${API.repo(this.repoId).info}${path.slice(base.length)}`, body);
    }
  }
}

async function withRepo(mcpEnv: McpEnvironment, daemon: DaemonConnection, repoPath: string): Promise<Connection> {
  const key = cacheKey(daemon, repoPath);
  let repoId = repoIds.get(key);
  if (!repoId) {
    repoId = (await registerRepo(daemon.client, repoPath)).id;
    repoIds.set(key, repoId);
  }
  const client = new RepoClient(daemon, repoPath, repoId, key, mcpEnv.fetchImpl);
  return { daemon, client, repoPath, repoId, api: API.repo(repoId) };
}

/** Finds the daemon and registers the repository on first use. @throws when no daemon runs (NOT_RUNNING) or on a version mismatch. */
export async function connect(mcpEnv: McpEnvironment, repo?: string): Promise<Connection> {
  const repoPath = await resolveRepo(mcpEnv, repo);
  const daemon = await findConnection(mcpEnv);
  if (!daemon) throw new Error(NOT_RUNNING);
  return withRepo(mcpEnv, daemon, repoPath);
}

/** start_server: ensureDaemon (spawns a detached daemon when none runs) + register the repository. */
export async function startDaemonFor(
  mcpEnv: McpEnvironment,
  repo: string | undefined,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<{ connection: Connection; daemon: EnsuredDaemon }> {
  const repoPath = await resolveRepo(mcpEnv, repo);
  const daemon = await ensureDaemon({
    paths: mcpEnv.paths,
    serverCommand: mcpEnv.serverCommand,
    port: opts.port,
    env: mcpEnv.env,
    version: mcpEnv.version ?? VERSION,
    timeoutMs: opts.timeoutMs,
    fetchImpl: mcpEnv.fetchImpl,
  });
  return { connection: await withRepo(mcpEnv, daemon, repoPath), daemon };
}
