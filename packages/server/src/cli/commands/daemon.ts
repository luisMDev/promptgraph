import { EXIT_DAEMON_LOCKED, loginUrl, webRoutes } from "@promptgraph/shared";
import { findDaemon } from "../../daemon/client.js";
import { DaemonLockedError, installProcessHandlers, startDaemon, type RunningDaemon } from "../../daemon/start.js";
import { errorMessage } from "../../util/text.js";
import type { CliOptions } from "../args.js";
import { CliError, repoRootOf, runCommand, type CliDeps } from "../deps.js";
import { checkPrereqs } from "../prereqs.js";

function listeningLine(daemon: RunningDaemon, deps: CliDeps): string {
  return `Listening: ${daemon.origin} (pid ${process.pid}, promptgraph ${deps.version})`;
}

/** `promptgraph daemon`: the daemon in this terminal, also what ensureDaemon spawns detached (lock held → exit 3). */
export async function runDaemon(opts: CliOptions, deps: CliDeps): Promise<number> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ port: opts.port ?? undefined, env: deps.env });
  } catch (err) {
    deps.stderr(`error: ${errorMessage(err)}`);
    return err instanceof DaemonLockedError ? EXIT_DAEMON_LOCKED : 1;
  }
  // Signal handlers go in before the Listening line: whoever waits for it may signal right away.
  const stopped = serveUntilStopped(daemon, deps);
  deps.stdout(listeningLine(daemon, deps));
  return stopped;
}

/**
 * `promptgraph [repo-dir] --foreground` (DESIGN §4.2): the daemon in this process (refused while another
 * daemon runs), registers the repository, prints `Open: <origin>/r/<repoId>` and opens the browser with a
 * one-time login URL minted in this process, never printed. Stops with SIGINT, SIGTERM or SIGHUP.
 */
export function runForeground(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const prereqs = await checkPrereqs(deps.env);
    for (const e of prereqs.errors) deps.stderr(`error: ${e}`);
    if (prereqs.errors.length > 0) return 1;
    for (const w of prereqs.warnings) deps.stderr(`warning: ${w}`);
    const repoPath = await repoRootOf(opts.repoDir);

    const running = await findDaemon(deps.paths, { fetchImpl: deps.fetchImpl });
    if (running) {
      throw new CliError(`promptgraph daemon is already running (pid ${running.info.pid}, ${running.origin}); --foreground needs it stopped (promptgraph stop)`);
    }
    let daemon: RunningDaemon;
    try {
      daemon = await startDaemon({ port: opts.port ?? undefined, env: deps.env, warnings: prereqs.warnings });
    } catch (err) {
      throw new CliError(`${errorMessage(err)}${err instanceof DaemonLockedError ? "; --foreground needs it stopped (promptgraph stop)" : ""}`);
    }
    // Signal handlers go in before the Listening line: whoever waits for it may signal right away.
    const stopped = serveUntilStopped(daemon, deps);
    deps.stdout(listeningLine(daemon, deps));
    let repoId: string;
    try {
      const repo = await daemon.ctx.registry.add(repoPath);
      if (repo.error) deps.stderr(`warning: ${repo.error}`);
      repoId = repo.id;
    } catch (err) {
      await daemon.close();
      throw err;
    }
    deps.stdout(`Open: ${daemon.origin}${webRoutes.repo(repoId)}`);
    if (opts.open) {
      const { code } = daemon.ctx.loginCodes.mint();
      deps.openBrowser(loginUrl(daemon.origin, code, webRoutes.repo(repoId))).catch(() => deps.stderr("warning: could not open a browser; run promptgraph open in a terminal"));
    }
    return stopped;
  });
}

/**
 * Installs the stop handlers synchronously: SIGINT/SIGTERM/SIGHUP → graceful stop (Claude PTYs get /exit,
 * ≤5 s) → 0; a second SIGINT force-exits.
 */
function serveUntilStopped(daemon: RunningDaemon, deps: CliDeps): Promise<number> {
  installProcessHandlers(daemon);
  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) {
        if (signal === "SIGINT") process.exit(130);
        return;
      }
      stopping = true;
      deps.stdout("Stopping: asking running sessions to exit (up to 5s)…");
      daemon.close().then(
        () => resolve(0),
        (err: unknown) => {
          deps.stderr(errorMessage(err));
          resolve(1);
        },
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // A foreground daemon stops with its terminal (DESIGN §4.1 item 6).
    process.on("SIGHUP", stop);
  });
}
