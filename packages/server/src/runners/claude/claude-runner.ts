import type { NodeRun, Lane, Run } from "@promptgraph/shared";
import type { PgPaths } from "../../config/paths.js";
import type { HookRouter } from "../../hooks/hook-router.js";
import type { PtyManager } from "../../pty/pty-manager.js";
import type { NodeExecution, Runner, RunnerContext } from "../types.js";

export interface ServerEndpoint {
  port: number;
  token: string;
}

export interface ClaudeRunnerDeps {
  ptys: PtyManager;
  hooks: HookRouter;
  paths: PgPaths;
  /** Absolute path of the installed pg-hook (installPgHook). */
  pgHookPath: string;
  /** Filled once the HTTP server listens (hooks need the port). */
  endpoint: () => ServerEndpoint;
  env?: NodeJS.ProcessEnv;
}

/**
 * prompt/command nodes (§7). Per start:
 * 1. resolve options (node config ?? graph defaults); writeHooksSettings for the run (once);
 * 2. autoTrustWorktrees → preTrustDirectory(lane.worktreePath), else watch PTY output for
 *    TRUST_DIALOG_PATTERN → waiting_input {kind:"trust_dialog"};
 * 3. message = buildInitialMessage (or INTERRUPTED_MESSAGE + --resume when previousAttempt was
 *    interrupted; context "resume" → --resume <predecessor sessionId>);
 * 4. spawn claudeBin() in a PTY (id = nodeRun.id, logPath ptyLogPath) with childEnv(PG_PORT, PG_TOKEN,
 *    PG_NODE_RUN_ID); update {ptyId, sessionId, transcriptPath?};
 * 5. hooks: session-start → confirm sessionId/transcriptPath, status running; activity → activity text
 *    (describeToolActivity), waiting_input → running; notification → waiting_input {kind:"notification"};
 *    stop → output.text = last_assistant_message ?? transcript fallback, output.usage =
 *    usageFromTranscript, then CompletionController.onStop;
 * 6. success → write "/exit\r", wait 3s, kill; result succeeded {text, usage};
 *    PTY exit before success → failed "Claude exited unexpectedly (code N)".
 */
export class ClaudeRunner implements Runner {
  constructor(private readonly deps: ClaudeRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }

  /**
   * "Reopen session" (§7.3): `claude --resume <nodeRun.sessionId>` in a new PTY in the lane worktree
   * (or the repo if the worktree is gone), not tracked by the run. Returns the new ptyId (`reopen-<id>`).
   */
  reopen(run: Run, nodeRun: NodeRun, lane: Lane | null, repoPath: string): string {
    throw new Error("not implemented");
  }
}
