/** The global transcription slot is taken and the wait queue is full, or the wait timed out. */
export class SlotBusyError extends Error {
  constructor(message = "Another transcription is running; try again in a moment") {
    super(message);
    this.name = "SlotBusyError";
  }
}

export class SlotAbortedError extends Error {
  constructor() {
    super("Wait for the transcription slot aborted");
    this.name = "SlotAbortedError";
  }
}

export type Release = () => void;

interface Waiter {
  grant(release: Release): void;
  fail(err: Error): void;
}

/**
 * Global concurrency of whisper processes (§22.5): one at a time. Partial passes use tryAcquire (skipped when
 * taken); final passes wait in a bounded FIFO queue with a timeout, and get SlotBusyError when it is full.
 */
export class TranscriptionSlot {
  private taken = false;
  private readonly queue: Waiter[] = [];

  constructor(private readonly maxQueue = 4) {}

  get busy(): boolean {
    return this.taken;
  }

  tryAcquire(): Release | null {
    if (this.taken) return null;
    this.taken = true;
    return this.releaser();
  }

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<Release> {
    const now = this.tryAcquire();
    if (now) return Promise.resolve(now);
    if (signal?.aborted) return Promise.reject(new SlotAbortedError());
    if (this.queue.length >= this.maxQueue) return Promise.reject(new SlotBusyError());
    return new Promise<Release>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = this.queue.indexOf(waiter);
        if (i !== -1) this.queue.splice(i, 1);
      };
      const waiter: Waiter = {
        grant: (release) => {
          cleanup();
          resolve(release);
        },
        fail: (err) => {
          cleanup();
          reject(err);
        },
      };
      const onAbort = () => waiter.fail(new SlotAbortedError());
      const timer = setTimeout(() => waiter.fail(new SlotBusyError()), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant(this.releaser());
      else this.taken = false;
    };
  }
}
