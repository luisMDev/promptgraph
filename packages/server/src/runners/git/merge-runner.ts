import type { PtyManager } from "../../pty/pty-manager.js";
import type { LaneManager } from "../../workspace/lane-manager.js";
import type { ClaudeRunner } from "../claude/claude-runner.js";
import type { NodeExecution, Runner, RunnerContext } from "../types.js";

/** Prompt given to Claude on conflict (§9.5). */
export function conflictPrompt(files: string[]): string {
  return `Resolve the merge conflicts in: ${files.join(", ")}. Keep the intent of both branches. Run the tests if available. Then stage the files.`;
}

/**
 * merge nodes (§9.5, §18 Q4): for each source lane in LanePlan.mergeSources order, LaneManager.merge.
 * On conflict: onConflict "claude" → a Claude PTY (via ClaudeRunner, ptyId = nodeRun.id) with
 * conflictPrompt, then concludeMerge; "pause" → waiting_input {kind:"merge_conflict"} with a shell PTY
 * (`shell-<nodeRunId>`) in the worktree until done() → concludeMerge (or fail() → abortMerge).
 * Output {sha, conflictedFiles}.
 */
export class MergeRunner implements Runner {
  constructor(private readonly deps: { lanes: LaneManager; ptys: PtyManager; claude: ClaudeRunner }) {}

  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }
}
