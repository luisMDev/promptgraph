import type { EventBus } from "../events/bus.js";

export interface SpawnPtyOptions {
  /** Defaults to a fresh id. Node PTYs use the nodeRunId (see CONTRACTS.md § PTY ids). */
  id?: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number; // default 120
  rows?: number; // default 40
  /** Where the ring buffer is flushed on exit (replay of finished terminals). */
  logPath: string;
}

export interface PtyExit {
  code: number | null;
  signal: number | null;
}

export interface PtyHandle {
  readonly id: string;
  readonly pid: number;
  /** Resolves when the process exits and the log has been flushed. */
  readonly exited: Promise<PtyExit>;
  readonly isLive: boolean;
  /** Writes to the PTY (programmatic input, e.g. "/exit\r"); does NOT count as user input. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  /** Subscribe to output; returns unsubscribe. Used by runners (e.g. trust-dialog detection, shell tail). */
  onData(listener: (chunk: Buffer) => void): () => void;
}

export interface PtyAttachResult {
  live: boolean;
  cols: number;
  rows: number;
  /** Ring buffer (live) or log file (finished) contents to replay. */
  replay: Buffer;
}

/** Called for every chunk of user input from a viewer (engine cancels auto grace / clears waiting_input). */
export type UserInputListener = (ptyId: string) => void;

/**
 * Owns every PTY process (node-pty). Keeps a 2 MB ring buffer per PTY, emits `pty:data`/`pty:exit`
 * on the bus, flushes the buffer to `logPath` on exit, and replays live buffers or logs on attach.
 */
export class PtyManager {
  constructor(
    private readonly bus: EventBus,
    /** Resolves a log path for ptys not known in memory (after a server restart). */
    private readonly resolveLogPath: (ptyId: string) => string | null,
  ) {}

  spawn(opts: SpawnPtyOptions): PtyHandle {
    throw new Error("not implemented");
  }

  get(id: string): PtyHandle | undefined {
    throw new Error("not implemented");
  }

  /** Replay data for a viewer; resizes the PTY when cols/rows are given (latest attach wins). @throws if unknown. */
  attach(id: string, size?: { cols: number; rows: number }): PtyAttachResult {
    throw new Error("not implemented");
  }

  /** Input typed by a user in the browser: writes to the PTY and notifies input listeners. */
  userInput(id: string, data: string): void {
    throw new Error("not implemented");
  }

  resize(id: string, cols: number, rows: number): void {
    throw new Error("not implemented");
  }

  onUserInput(listener: UserInputListener): () => void {
    throw new Error("not implemented");
  }

  /** Live PTYs. */
  list(): PtyHandle[] {
    throw new Error("not implemented");
  }

  /** SIGINT path: kills every live PTY (callers send /exit first) and waits for log flush. */
  killAll(): Promise<void> {
    throw new Error("not implemented");
  }
}
