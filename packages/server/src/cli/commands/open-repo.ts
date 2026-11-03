import { webRoutes } from "@promptgraph/shared";
import { ensureDaemon, mintLoginUrl, registerRepo } from "../../daemon/client.js";
import type { CliOptions } from "../args.js";
import { repoRootOf, runCommand, type CliDeps } from "../deps.js";
import { checkPrereqs } from "../prereqs.js";

/**
 * `promptgraph [repo-dir]` (DESIGN §4.2): prerequisite warnings → git top level (realpath) → ensureDaemon
 * (a detached daemon when none runs; `--port` only forwarded when given, with a warning when the running
 * daemon has another one) → register → open the browser with a one-time login URL (not with `--no-open`)
 * → `Opened <name>: http://127.0.0.1:<port>/r/<repoId>` → exit 0.
 */
export function runOpenRepo(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const prereqs = await checkPrereqs(deps.env);
    for (const e of prereqs.errors) deps.stderr(`error: ${e}`);
    if (prereqs.errors.length > 0) return 1;
    for (const w of prereqs.warnings) deps.stderr(`warning: ${w}`);
    const repoPath = await repoRootOf(opts.repoDir);

    const daemon = await ensureDaemon({
      paths: deps.paths,
      serverCommand: deps.serverCommand,
      port: opts.portExplicit ? (opts.port ?? undefined) : undefined,
      env: deps.env,
      version: deps.version,
      fetchImpl: deps.fetchImpl,
    });
    if (daemon.started) deps.stdout(`Started the promptgraph daemon (pid ${daemon.info.pid}); it keeps running, stop it with promptgraph stop`);
    else if (opts.portExplicit && opts.port !== daemon.info.port) {
      deps.stderr(`warning: the promptgraph daemon is already running on port ${daemon.info.port}; --port ${opts.port} was not used`);
    }
    const repo = await registerRepo(daemon.client, repoPath);
    if (repo.error) deps.stderr(`warning: ${repo.error}`);
    const target = webRoutes.repo(repo.id);
    if (opts.open) {
      // A mint failure is a daemon API error (it never carries a login URL): it reaches runCommand as is.
      const loginUrl = await mintLoginUrl(daemon, target);
      try {
        await deps.openBrowser(loginUrl);
      } catch {
        // The error could quote the login URL: a fixed message only.
        deps.stderr(`warning: could not open a browser; run promptgraph open ${repo.id}`);
      }
    }
    deps.stdout(`Opened ${repo.name}: ${daemon.origin}${target}`);
    return 0;
  });
}
