#!/usr/bin/env node
import { EXIT_DAEMON_LOCKED, loginUrl, webRoutes } from "@promptgraph/shared";
import open from "open";
import { VERSION } from "../config/version.js";
import { DaemonLockedError, installProcessHandlers, startDaemon, type RunningDaemon } from "../daemon/start.js";
import { resolveRepoRoot } from "../git/repo.js";
import { errorMessage } from "../util/text.js";
import { parseCliArgs, USAGE, type CliOptions } from "./args.js";
import { checkPrereqs } from "./prereqs.js";

/**
 * `promptgraph` bin (DESIGN §4). `promptgraph mcp` runs the MCP server (§19.2); `promptgraph daemon`
 * runs the daemon in this terminal (lock held → exit 3); `promptgraph [repo-dir]` (with or without
 * `--foreground`, until the detached start lands) runs the daemon in this process, registers the
 * repository and opens it. SIGINT/SIGTERM/SIGHUP → graceful stop (Claude PTYs get /exit, ≤5 s) → exit 0;
 * a second SIGINT force-exits.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  if (opts.command === "mcp") {
    // §19.2: MCP server on stdio for Claude Code. Loaded lazily; stdout is the protocol channel.
    const { runMcpStdio } = await import("../mcp/server.js");
    await runMcpStdio();
    return 0;
  }
  if (opts.command === "daemon") return runDaemon(opts);
  return runForeground(opts);
}

function listeningLine(daemon: RunningDaemon): string {
  return `Listening: ${daemon.origin} (pid ${process.pid}, promptgraph ${VERSION})`;
}

/** `promptgraph daemon`: the daemon in this terminal (also what ensureDaemon spawns detached). */
async function runDaemon(opts: CliOptions): Promise<number> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ port: opts.port ?? undefined });
  } catch (err) {
    console.error(`error: ${errorMessage(err)}`);
    return err instanceof DaemonLockedError ? EXIT_DAEMON_LOCKED : 1;
  }
  console.log(listeningLine(daemon));
  return serveUntilStopped(daemon);
}

/** `promptgraph [repo-dir] --foreground`: daemon in this process + register + open. */
async function runForeground(opts: CliOptions): Promise<number> {
  const prereqs = await checkPrereqs();
  for (const e of prereqs.errors) console.error(`error: ${e}`);
  if (prereqs.errors.length > 0) return 1;
  for (const w of prereqs.warnings) console.warn(`warning: ${w}`);

  let repoPath: string;
  try {
    repoPath = await resolveRepoRoot(opts.repoDir);
  } catch {
    console.error(`error: ${opts.repoDir} is not inside a git repository`);
    return 1;
  }

  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ port: opts.port ?? undefined, warnings: prereqs.warnings });
  } catch (err) {
    console.error(`error: ${errorMessage(err)}${err instanceof DaemonLockedError ? "; --foreground needs it stopped (promptgraph stop)" : ""}`);
    return 1;
  }
  console.log(listeningLine(daemon));
  let repoId: string;
  try {
    const repo = await daemon.ctx.registry.add(repoPath);
    if (repo.error) console.warn(`warning: ${repo.error}`);
    repoId = repo.id;
  } catch (err) {
    console.error(`error: ${errorMessage(err)}`);
    await daemon.close();
    return 1;
  }
  const url = `${daemon.origin}${webRoutes.repo(repoId)}`;
  console.log(`Open: ${url}`);
  // The browser signs in with a one-time login code (DESIGN §14); the printed URL holds no credential.
  if (opts.open) {
    const { code } = daemon.ctx.loginCodes.mint();
    open(loginUrl(daemon.origin, code, webRoutes.repo(repoId))).catch(() => console.warn("warning: could not open a browser; open the URL above"));
  }
  return serveUntilStopped(daemon);
}

function serveUntilStopped(daemon: RunningDaemon): Promise<number> {
  installProcessHandlers(daemon);
  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) {
        if (signal === "SIGINT") process.exit(130);
        return;
      }
      stopping = true;
      console.log("\nStopping: asking running sessions to exit (up to 5s)…");
      daemon.close().then(
        () => resolve(0),
        (err: unknown) => {
          console.error(errorMessage(err));
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  },
);
