import type { ApprovalRequest, NodeRunOutput } from "@promptgraph/shared";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "./types.js";

/**
 * One pending decision (approval nodes, pr gate). `decision` resolves with the first approve() request,
 * or null once `signal` aborts (fail / cancel).
 */
export class ApprovalGate {
  readonly decision: Promise<ApprovalRequest | null>;
  private resolve!: (req: ApprovalRequest | null) => void;

  constructor(signal: AbortSignal) {
    this.decision = new Promise((r) => (this.resolve = r));
    if (signal.aborted) this.resolve(null);
    else signal.addEventListener("abort", () => this.resolve(null), { once: true });
  }

  approve(req: ApprovalRequest): void {
    this.resolve(req);
  }
}

/** Output of a decision: {approved, comment?}. */
export function approvalOutput(req: ApprovalRequest): NodeRunOutput {
  const comment = req.comment?.trim();
  return { approved: req.approved, ...(comment ? { comment } : {}) };
}

/** Error of a rejected gate: "<what> rejected[: comment]". */
export function rejectionError(what: string, req: ApprovalRequest): string {
  const comment = req.comment?.trim();
  return comment ? `${what} rejected: ${comment}` : `${what} rejected`;
}

/**
 * Stop handling shared by gate runners: fail() records the reason and aborts; the run's signal aborts
 * too. `outcome()` maps an abort to failed (with the reason) or cancelled.
 */
export class Interruption {
  readonly controller = new AbortController();
  private failReason: string | null = null;

  constructor(runSignal: AbortSignal) {
    if (runSignal.aborted) this.controller.abort();
    else runSignal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  fail(reason?: string): void {
    this.failReason ??= reason || "Marked as failed by the user";
    this.controller.abort();
  }

  /** Result for an aborted execution, or null when it was not aborted. */
  outcome(output?: NodeRunOutput): RunnerResult | null {
    if (this.failReason) return { status: "failed", error: this.failReason, ...(output ? { output } : {}) };
    return this.controller.signal.aborted ? { status: "cancelled" } : null;
  }
}

/**
 * approval nodes (§10): status waiting_approval until controls.approve() (or done(), which approves
 * without a comment); rejected → failed. Output {approved, comment}.
 */
export class ApprovalRunner implements Runner {
  start(ctx: RunnerContext): NodeExecution {
    const stop = new Interruption(ctx.signal);
    const gate = new ApprovalGate(stop.signal);
    ctx.update({ status: "waiting_approval" });

    const result = gate.decision.then((req): RunnerResult => {
      if (!req) return stop.outcome() ?? { status: "cancelled" };
      const output = approvalOutput(req);
      return req.approved ? { status: "succeeded", output } : { status: "failed", error: rejectionError("Approval", req), output };
    });

    return {
      result,
      controls: {
        done: () => gate.approve({ approved: true }),
        fail: (reason) => stop.fail(reason),
        setHold: () => undefined,
        approve: (req) => gate.approve(req),
        cancel: async () => {
          stop.controller.abort();
          await result;
        },
      },
    };
  }
}
