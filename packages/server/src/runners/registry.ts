import type { PgPaths } from "../config/paths.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { LaneManager } from "../workspace/lane-manager.js";
import type { ClaudeRunner } from "./claude/claude-runner.js";
import { CommitRunner } from "./git/commit-runner.js";
import { ShellRunner } from "./shell-runner.js";
import type { RunnerRegistry } from "./types.js";

export interface RunnerRegistryDeps {
  claude: ClaudeRunner;
  ptys: PtyManager;
  lanes: LaneManager;
  paths: PgPaths;
  /** Base env for child processes; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Maps every implemented node type to its runner (prompt/command share the ClaudeRunner). merge, pr,
 * approval and condition are added by their milestones (M3–M5).
 */
export function createRunnerRegistry(deps: RunnerRegistryDeps): RunnerRegistry {
  return {
    prompt: deps.claude,
    command: deps.claude,
    shell: new ShellRunner({ ptys: deps.ptys, paths: deps.paths, env: deps.env }),
    commit: new CommitRunner({ lanes: deps.lanes, env: deps.env }),
  };
}
