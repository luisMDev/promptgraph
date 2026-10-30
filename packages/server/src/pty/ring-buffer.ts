/** Default per-PTY replay buffer (§7.3). */
export const PTY_RING_BYTES = 2 * 1024 * 1024;

/** Byte ring buffer keeping the most recent `capacity` bytes. */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(readonly capacity: number = PTY_RING_BYTES) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.capacity) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.capacity))];
      this.bytes = this.capacity;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.capacity) {
      const head = this.chunks[0]!;
      const excess = this.bytes - this.capacity;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  /** Current contents, oldest first. */
  snapshot(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.bytes)];
    return Buffer.from(this.chunks[0] ?? Buffer.alloc(0));
  }

  get size(): number {
    return this.bytes;
  }
}
