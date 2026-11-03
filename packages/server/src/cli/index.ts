#!/usr/bin/env node
import { errorMessage } from "../util/text.js";
import { parseCliArgs, USAGE, UsageError, type CliOptions } from "./args.js";
import { runDaemon, runForeground } from "./commands/daemon.js";
import { runLs } from "./commands/ls.js";
import { runOpenRepo } from "./commands/open-repo.js";
import { runOpen } from "./commands/open.js";
import { runRm } from "./commands/rm.js";
import { runSessions, runSessionsRevoke } from "./commands/sessions.js";
import { runStop } from "./commands/stop.js";
import { runTokenRotate } from "./commands/token.js";
import { defaultDeps, type CliDeps } from "./deps.js";

const COMMANDS: Record<Exclude<CliOptions["command"], "mcp">, (opts: CliOptions, deps: CliDeps) => Promise<number>> = {
  "open-repo": (opts, deps) => (opts.foreground ? runForeground(opts, deps) : runOpenRepo(opts, deps)),
  daemon: runDaemon,
  ls: runLs,
  open: runOpen,
  rm: runRm,
  stop: runStop,
  "token-rotate": runTokenRotate,
  sessions: runSessions,
  "sessions-revoke": runSessionsRevoke,
};

/**
 * `promptgraph` bin (DESIGN §4). Exit codes: 0 ok, 1 error (also "not running" and a version mismatch),
 * 2 usage, 3 (`daemon` only) another daemon holds the lock.
 */
export async function main(argv: readonly string[], makeDeps: () => CliDeps = () => defaultDeps()): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : errorMessage(err)}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // --version is global: checked before `mcp`, which would otherwise start the stdio server and block.
  if (opts.version) {
    const deps = makeDeps();
    deps.stdout(deps.version);
    return 0;
  }
  if (opts.command === "mcp") {
    // §19.2: MCP server on stdio for Claude Code. Loaded lazily; stdout is the protocol channel.
    const { runMcpStdio } = await import("../mcp/server.js");
    await runMcpStdio();
    return 0;
  }
  return COMMANDS[opts.command](opts, makeDeps());
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  },
);
