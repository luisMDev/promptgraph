import type { CompletionPolicy } from "@promptgraph/shared";

export interface CompletionCallbacks {
  /** Policy says the node is done. */
  succeed(): void;
  /** Turn finished but the node needs the user (status idle). */
  idle(): void;
  /** Activity resumed after idle/grace (status running). */
  resume(): void;
}

/**
 * §7.4 state machine, independent of PTYs/hooks (unit-testable with fake timers):
 * - auto: Stop → grace timer (graceSec); user input during grace cancels it → stays running; expiry → succeed.
 * - manual: Stop → idle until done().
 * - marker: Stop → last message contains token ? succeed : idle.
 * - hold (any policy): the current turn behaves as manual; clearing hold does not retroactively succeed.
 */
export class CompletionController {
  constructor(
    private readonly policy: CompletionPolicy,
    private readonly callbacks: CompletionCallbacks,
  ) {}

  onStop(lastAssistantMessage: string | null): void {
    throw new Error("not implemented");
  }

  onUserInput(): void {
    throw new Error("not implemented");
  }

  setHold(hold: boolean): void {
    throw new Error("not implemented");
  }

  /** Clears timers. */
  dispose(): void {
    throw new Error("not implemented");
  }
}
