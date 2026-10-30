import type { PgPaths } from "../config/paths.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { LaneManager } from "../workspace/lane-manager.js";
import type { ClaudeRunner } from "./claude/claude-runner.js";
import type { RunnerRegistry } from "./types.js";

export interface RunnerRegistryDeps {
  claude: ClaudeRunner;
  ptys: PtyManager;
  lanes: LaneManager;
  paths: PgPaths;
}

/** Maps every node type to its runner (prompt/command share the ClaudeRunner). */
export function createRunnerRegistry(deps: RunnerRegistryDeps): RunnerRegistry {
  throw new Error("not implemented");
}
