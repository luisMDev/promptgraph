import type { CompletionPolicy } from "@promptgraph/shared";

export interface CompletionCallbacks {
  /** Policy says the node is done. */
  succeed(): void;
  /** Turn finished but the node needs the user (status idle). */
  idle(): void;
  /** Activity resumed after idle/grace (status running). */
  resume(): void;
  /** The held turn ended and a new one started: the hold no longer applies (§7.4). */
  holdReleased(): void;
}

type Phase = "working" | "grace" | "idle" | "done";

/**
 * §7.4 state machine, independent of PTYs/hooks (unit-testable with fake timers):
 * - auto: Stop → grace timer (graceSec); user input during grace cancels it → stays running; expiry → succeed.
 * - manual: Stop → idle until done().
 * - marker: Stop → last message contains token ? succeed : idle.
 * - hold (any policy): the current turn behaves as manual; clearing hold does not retroactively succeed.
 *   Once that turn has ended in idle, the next turn (user input / activity) releases the hold.
 */
export class CompletionController {
  private phase: Phase = "working";
  private hold = false;
  /** A turn ended in idle because of the hold. */
  private holdSpent = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly policy: CompletionPolicy,
    private readonly callbacks: CompletionCallbacks,
  ) {}

  onStop(lastAssistantMessage: string | null): void {
    if (this.phase === "done") return;
    this.clearTimer();
    if (this.hold) {
      this.holdSpent = true;
      return this.toIdle();
    }
    if (this.policy.mode === "manual") return this.toIdle();
    if (this.policy.mode === "marker") {
      return lastAssistantMessage?.includes(this.policy.token) ? this.succeed() : this.toIdle();
    }
    if (this.policy.graceSec <= 0) return this.succeed();
    this.phase = "grace";
    this.timer = setTimeout(() => this.succeed(), this.policy.graceSec * 1000);
  }

  onUserInput(): void {
    this.backToWork();
  }

  /** Claude started working again (PreToolUse after idle/grace): same effect as user input. */
  onActivity(): void {
    this.backToWork();
  }

  setHold(hold: boolean): void {
    this.hold = hold;
    this.holdSpent = false;
    if (hold && this.phase === "grace") {
      this.clearTimer();
      this.holdSpent = true;
      this.toIdle();
    }
  }

  /** Clears timers. */
  dispose(): void {
    this.clearTimer();
    this.phase = "done";
  }

  private backToWork(): void {
    if (this.phase !== "grace" && this.phase !== "idle") return;
    this.clearTimer();
    this.phase = "working";
    if (this.holdSpent) {
      this.hold = false;
      this.holdSpent = false;
      this.callbacks.holdReleased();
    }
    this.callbacks.resume();
  }

  private toIdle(): void {
    this.phase = "idle";
    this.callbacks.idle();
  }

  private succeed(): void {
    this.clearTimer();
    this.phase = "done";
    this.callbacks.succeed();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
