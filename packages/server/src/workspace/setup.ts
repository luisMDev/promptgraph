import type { Lane } from "@promptgraph/shared";
import type { PtyManager } from "../pty/pty-manager.js";

export interface WorkspaceSetupResult {
  ok: boolean;
  exitCode: number | null;
  /** `setup-<nodeRunId>`; viewable/replayable like any PTY. */
  ptyId: string;
}

/**
 * §9.4: runs settings.workspaceSetup (`sh -c`) once in a new lane's worktree, in a PTY, before the
 * lane's first node. The engine shows it as `laneSetup` on that node; failure fails the node.
 */
export function runWorkspaceSetup(opts: {
  ptys: PtyManager;
  lane: Lane;
  command: string;
  nodeRunId: string;
  logPath: string;
  env: Record<string, string>;
  signal: AbortSignal;
}): Promise<WorkspaceSetupResult> {
  throw new Error("not implemented");
}
