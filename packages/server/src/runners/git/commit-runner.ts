import type { LaneManager } from "../../workspace/lane-manager.js";
import type { NodeExecution, Runner, RunnerContext } from "../types.js";

/**
 * commit nodes (§6.1, §9.3) under the lane lock: squashCheckpoints → `git reset --soft` to the last
 * non-checkpoint commit (messages starting "pg: checkpoint"); `git add -A`; nothing staged → succeeded
 * {noop:true}; message = config.message or generateMessage("commit"); `git commit -F -`.
 * Output {sha, message, usage?}.
 */
export class CommitRunner implements Runner {
  constructor(private readonly deps: { lanes: LaneManager }) {}

  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }
}
