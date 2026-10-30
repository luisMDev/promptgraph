import type { NodeExecution, Runner, RunnerContext } from "./types.js";

/** approval nodes (§10): status waiting_approval until controls.approve(); rejected → failed. Output {approved, comment}. */
export class ApprovalRunner implements Runner {
  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }
}
