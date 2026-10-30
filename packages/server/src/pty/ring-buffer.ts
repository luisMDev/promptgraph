/** Default per-PTY replay buffer (§7.3). */
export const PTY_RING_BYTES = 2 * 1024 * 1024;

/** Byte ring buffer keeping the most recent `capacity` bytes. */
export class RingBuffer {
  constructor(readonly capacity: number = PTY_RING_BYTES) {}

  push(chunk: Buffer): void {
    throw new Error("not implemented");
  }

  /** Current contents, oldest first. */
  snapshot(): Buffer {
    throw new Error("not implemented");
  }

  get size(): number {
    throw new Error("not implemented");
  }
}
