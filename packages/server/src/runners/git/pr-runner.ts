import type { LaneManager } from "../../workspace/lane-manager.js";
import type { NodeExecution, Runner, RunnerContext } from "../types.js";

/**
 * pr nodes (§6.1, §10): checkpoint if dirty (§18 Q1); title/body = config or generateMessage("pr"),
 * stored in output {title, body}; requireApproval → waiting_approval until approve() (edited
 * title/body override; reject → failed); `git push -u origin <branch>` (mark lane pushed);
 * `gh pr create --base <base> --head <branch> --title --body [--draft]`. Output {prUrl, title, body}.
 */
export class PrRunner implements Runner {
  constructor(private readonly deps: { lanes: LaneManager }) {}

  start(ctx: RunnerContext): NodeExecution {
    throw new Error("not implemented");
  }
}
