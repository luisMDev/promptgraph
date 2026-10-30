import type { PgPaths } from "../config/paths.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { NodeExecution, Runner, RunnerContext } from "./types.js";

/** Lines of output kept in output.stdoutTail (§6.1). */
export const SHELL_TAIL_LINES = 200;

/**
 * shell nodes: `sh -c <run>` in a PTY (id = nodeRun.id, viewable live) in the lane worktree with
 * childEnv(config.env). Exit 0 → succeeded; else failed. Timeout (timeoutSec) → kill, failed, timedOut.
 * Output: {exitCode, stdoutTail (ANSI-stripped last 200 lines), timedOut?}.
 */
export class ShellRunner implements Runner {
  constructor(private readonly deps: { ptys: PtyManager; paths: PgPaths }) {}

  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }
}
