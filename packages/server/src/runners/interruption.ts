import type { NodeRunOutput } from "@promptgraph/shared";
import type { RunnerResult } from "./types.js";

/**
 * Stop handling shared by runners (gates, condition, merge, pr, commit): fail() records the reason and aborts; the run's signal aborts
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
