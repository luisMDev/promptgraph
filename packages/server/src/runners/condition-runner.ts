import type { NodeExecution, Runner, RunnerContext } from "./types.js";

/**
 * Phase 2 condition nodes (§15.2), single predecessor: exitCode (predecessor output.exitCode === equals),
 * regex (on predecessor output.text ?? stdoutTail), judge (runHeadless with JUDGE_JSON_SCHEMA, the
 * predecessor output and the lane diff stat). Result: succeeded with output.port "true"/"false"
 * (+ text = judge reason). Evaluation errors → failed.
 */
export class ConditionRunner implements Runner {
  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }
}
