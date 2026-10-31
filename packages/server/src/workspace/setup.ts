import type { Lane } from "@promptgraph/shared";
import type { PtyManager } from "../pty/pty-manager.js";

export interface WorkspaceSetupResult {
  ok: boolean;
  exitCode: number | null;
  /** `setup-<nodeRunId>`; viewable/replayable like any PTY. */
  ptyId: string;
}

const KILL_WAIT_MS = 3000;

/**
 * §9.4: runs settings.workspaceSetup (`sh -c`) once in a new lane's worktree, in a PTY, before the
 * lane's first node. The engine shows it as `laneSetup` on that node; failure fails the node.
 */
export async function runWorkspaceSetup(opts: {
  ptys: PtyManager;
  lane: Lane;
  command: string;
  nodeRunId: string;
  logPath: string;
  env: Record<string, string>;
  signal: AbortSignal;
}): Promise<WorkspaceSetupResult> {
  const ptyId = `setup-${opts.nodeRunId}`;
  const handle = opts.ptys.spawn({
    id: ptyId,
    file: "sh",
    args: ["-c", opts.command],
    cwd: opts.lane.worktreePath,
    env: opts.env,
    logPath: opts.logPath,
  });
  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    handle.kill("SIGTERM");
    killTimer = setTimeout(() => handle.kill("SIGKILL"), KILL_WAIT_MS);
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
  const exit = await handle.exited;
  clearTimeout(killTimer);
  opts.signal.removeEventListener("abort", onAbort);
  return { ok: exit.code === 0 && !opts.signal.aborted, exitCode: exit.code, ptyId };
}
