import { NODE_TYPES, type NodeType } from "@promptgraph/shared";
import type { PgPaths } from "../config/paths.js";
import type { OwnedPtys } from "../pty/pty-manager.js";
import type { LaneManager } from "../workspace/lane-manager.js";
import { ApprovalRunner } from "./approval-runner.js";
import type { ClaudeRunner } from "./claude/claude-runner.js";
import { ConditionRunner } from "./condition-runner.js";
import { CommitRunner } from "./git/commit-runner.js";
import { MergeRunner } from "./git/merge-runner.js";
import { PrRunner } from "./git/pr-runner.js";
import { ShellRunner } from "./shell-runner.js";
import type { RunnerRegistry } from "./types.js";

export interface RunnerRegistryDeps {
  claude: ClaudeRunner;
  ptys: OwnedPtys;
  lanes: LaneManager;
  paths: PgPaths;
  /** Base env for child processes; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Node types createRunnerRegistry implements (GET /api/daemon `supportedNodeTypes`; Engine.supportedNodeTypes per repository). */
export const RUNNER_NODE_TYPES: readonly NodeType[] = NODE_TYPES.filter((t) =>
  (["prompt", "command", "shell", "commit", "merge", "pr", "approval", "condition"] as readonly string[]).includes(t),
);

/**
 * Maps every implemented node type to its runner (prompt/command share the ClaudeRunner; merge uses it
 * for conflicts; condition judges run headless claude).
 */
export function createRunnerRegistry(deps: RunnerRegistryDeps): RunnerRegistry {
  return {
    prompt: deps.claude,
    command: deps.claude,
    shell: new ShellRunner({ ptys: deps.ptys, paths: deps.paths, env: deps.env }),
    commit: new CommitRunner({ lanes: deps.lanes, env: deps.env }),
    merge: new MergeRunner({ lanes: deps.lanes, ptys: deps.ptys, claude: deps.claude, paths: deps.paths, env: deps.env }),
    pr: new PrRunner({ lanes: deps.lanes, env: deps.env }),
    approval: new ApprovalRunner(),
    condition: new ConditionRunner({ env: deps.env }),
  };
}
