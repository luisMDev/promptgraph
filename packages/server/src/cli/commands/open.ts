import path from "node:path";
import {
  API,
  EXIT_VERSION_MISMATCH,
  OPEN_URL_RESULT_VERSION,
  OpenUrlResultSchema,
  REPO_ID_PATTERN,
  webRoutes,
  type ListReposResponse,
  type RepoSummary,
} from "@promptgraph/shared";
import { ensureDaemon, mintLoginUrl, registerRepo, type DaemonConnection } from "../../daemon/client.js";
import { openWithPolicy } from "../../daemon/handover.js";
import { activateRuntime, isInstalledRuntime } from "../../desktop/runtime.js";
import { errorMessage } from "../../util/text.js";
import type { CliOptions } from "../args.js";
import { CliError, repoRootOf, runCommand, uiOrigin, type CliDeps } from "../deps.js";

/**
 * The repository `open` targets: a repoId the daemon knows, else a directory, registered (idempotent).
 * Ids are tried first because they cannot contain a slash: `./name` always means a directory.
 */
async function resolveOpenTarget(conn: DaemonConnection, target: string, deps: CliDeps): Promise<RepoSummary> {
  if (REPO_ID_PATTERN.test(target)) {
    const { repos } = await conn.client.get<ListReposResponse>(API.repos);
    const known = repos.find((r) => r.id === target);
    if (known) return known;
  }
  let repoPath: string;
  try {
    repoPath = await repoRootOf(path.resolve(deps.cwd, target));
  } catch {
    throw new CliError(`${target} is neither a git repository nor a registered repository id (see promptgraph ls)`);
  }
  return registerRepo(conn.client, repoPath);
}

/**
 * Runtime activation (DESIGN §4.3): once the daemon runs this CLI's version and this CLI is an installed
 * desktop runtime, `current` (and with it the ~/.local/bin command) follows it. Never fails `open`.
 */
async function activateIfRuntime(deps: CliDeps): Promise<void> {
  try {
    if (!isInstalledRuntime(deps.env, deps.runtimeRoot)) return;
    await activateRuntime(deps.env, deps.runtimeRoot);
  } catch (err) {
    deps.stderr(`warning: could not switch the promptgraph runtime to ${deps.version}: ${errorMessage(err)}`);
  }
}

/**
 * `promptgraph open [repo-dir|repo-id] [--next <path>] [--print-url] [--json] [--web-port <p>]` (DESIGN
 * §4.3): ensureDaemon, register the repository when one is given, mint a one-time login URL for
 * `/r/<repoId>` (Home without a target, `--next` replaces the path), then open it in the browser, or
 * print it (`--print-url`), or print exactly one OpenUrlResult line and nothing else on stdout (`--json`,
 * the desktop shell's interface, §20). Warnings go to stderr. With `--on-version-mismatch` the daemon
 * comes from openWithPolicy (§4.3): a `mismatch` prints one OpenMismatchResult line and exits 4.
 */
export function runOpen(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    let conn: DaemonConnection;
    if (opts.onVersionMismatch === null) {
      conn = await ensureDaemon({
        paths: deps.paths,
        serverCommand: deps.serverCommand,
        env: deps.env,
        version: deps.version,
        fetchImpl: deps.fetchImpl,
      });
    } else {
      const outcome = await openWithPolicy(deps, opts.onVersionMismatch);
      if (outcome.kind === "mismatch") {
        // The caller (the desktop shell) asks the user (DESIGN §20.9): exactly one line, nothing changed.
        deps.stdout(JSON.stringify(outcome.result));
        return EXIT_VERSION_MISMATCH;
      }
      conn = outcome.conn;
      if (conn.serverVersion === deps.version) await activateIfRuntime(deps);
    }
    const repo = opts.target === null ? null : await resolveOpenTarget(conn, opts.target, deps);
    if (repo?.error) deps.stderr(`warning: ${repo.error}`);
    const next = opts.next ?? (repo ? webRoutes.repo(repo.id) : webRoutes.home());
    const origin = uiOrigin(conn, opts.webPort);
    // `--json` is the desktop shell's interface (DESIGN §20.1): its session is labelled "promptgraph
    // desktop", since a WebKitGTK user agent does not say Tauri.
    const url = await mintLoginUrl(conn, next, { webPort: opts.webPort ?? undefined, desktop: opts.json });

    if (opts.json) {
      // The port of the URL's origin: the desktop shell allows exactly that origin (DESIGN §20.1 item 3).
      const result = OpenUrlResultSchema.parse({
        v: OPEN_URL_RESULT_VERSION,
        cliVersion: deps.version,
        url,
        port: Number(new URL(origin).port),
        repoId: repo?.id ?? null,
      });
      deps.stdout(JSON.stringify(result));
      return 0;
    }
    if (opts.printUrl) {
      deps.stdout(url);
      return 0;
    }
    try {
      await deps.openBrowser(url);
    } catch {
      // The error could quote the login URL: a fixed message only.
      throw new CliError("could not open a browser; run promptgraph open --print-url and open the URL within 30 s");
    }
    deps.stdout(`Opened ${repo?.name ?? "promptgraph"}: ${origin}${next}`);
    return 0;
  });
}
