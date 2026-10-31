import fs from "node:fs";
import path from "node:path";
import pty, { type IPty } from "node-pty";
import type { EventBus } from "../events/bus.js";
import { newId } from "../util/ids.js";
import { RingBuffer } from "./ring-buffer.js";
import { isUserTyping } from "./terminal-reports.js";

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

/**
 * Called for user input from a viewer (engine cancels auto grace / clears waiting_input). Chunks made
 * only of terminal reports (focus, mouse, query replies) are not user input.
 */
export type UserInputListener = (ptyId: string) => void;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
/** node-pty may deliver the last output chunks just after onExit; wait before flushing the log. */
const EXIT_DRAIN_MS = 50;
/** Exited handles kept in memory (get() after exit); older ones are forgotten, attach() reads their log. */
const KEEP_EXITED = 64;
/** killAll: SIGKILL stragglers after this long. */
const KILL_ALL_GRACE_MS = 2000;

class ManagedPty implements PtyHandle {
  readonly exited: Promise<PtyExit>;
  readonly ring = new RingBuffer();
  cols: number;
  rows: number;
  private live = true;
  private readonly listeners = new Set<(chunk: Buffer) => void>();

  constructor(
    readonly id: string,
    private readonly proc: IPty,
    readonly logPath: string,
    size: { cols: number; rows: number },
    onChunk: (chunk: Buffer) => void,
    onExit: (handle: ManagedPty, exit: PtyExit) => Promise<void>,
  ) {
    this.cols = size.cols;
    this.rows = size.rows;
    proc.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      this.ring.push(chunk);
      onChunk(chunk);
      for (const l of this.listeners) l(chunk);
    });
    this.exited = new Promise<PtyExit>((resolve) => {
      proc.onExit(({ exitCode, signal }) => {
        const exit: PtyExit = { code: signal ? null : exitCode, signal: signal || null };
        setTimeout(() => {
          this.live = false;
          this.listeners.clear();
          void onExit(this, exit).then(() => resolve(exit));
        }, EXIT_DRAIN_MS);
      });
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get isLive(): boolean {
    return this.live;
  }

  write(data: string): void {
    if (this.live) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.live || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.proc.resize(cols, rows);
    } catch {
      // The process may have exited between the check and the call.
    }
  }

  kill(signal?: NodeJS.Signals): void {
    if (!this.live) return;
    try {
      this.proc.kill(signal);
    } catch {
      // Already gone.
    }
  }

  onData(listener: (chunk: Buffer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Owns every PTY process (node-pty). Keeps a 2 MB ring buffer per PTY, emits `pty:data`/`pty:exit`
 * on the bus, flushes the buffer to `logPath` on exit, and replays live buffers or logs on attach.
 */
export class PtyManager {
  private readonly handles = new Map<string, ManagedPty>();
  /** Ids of exited handles, oldest first (bounded by KEEP_EXITED). */
  private readonly exitedIds: string[] = [];
  private readonly inputListeners = new Set<UserInputListener>();

  constructor(
    private readonly bus: EventBus,
    /** Resolves a log path for ptys not known in memory (after a server restart). */
    private readonly resolveLogPath: (ptyId: string) => string | null,
  ) {}

  spawn(opts: SpawnPtyOptions): PtyHandle {
    const id = opts.id ?? newId();
    if (this.handles.get(id)?.isLive) throw new Error(`PTY ${id} is already running`);
    const size = { cols: opts.cols ?? DEFAULT_COLS, rows: opts.rows ?? DEFAULT_ROWS };
    const proc = pty.spawn(opts.file, opts.args, {
      name: opts.env.TERM ?? "xterm-256color",
      cwd: opts.cwd,
      env: opts.env,
      ...size,
    });
    const handle = new ManagedPty(
      id,
      proc,
      opts.logPath,
      size,
      (data) => this.bus.emit("pty:data", { ptyId: id, data }),
      async (h, exit) => {
        await flushLog(h.logPath, h.ring.snapshot(), { cols: h.cols, rows: h.rows });
        // attach() of a finished PTY reads the log: the buffer would only hold memory from now on.
        h.ring.clear();
        this.forgetExited(id, h);
        this.bus.emit("pty:exit", { ptyId: id, code: exit.code });
      },
    );
    this.handles.set(id, handle);
    return handle;
  }

  private forgetExited(id: string, h: ManagedPty): void {
    this.exitedIds.push(id);
    while (this.exitedIds.length > KEEP_EXITED) {
      const old = this.exitedIds.shift()!;
      const handle = this.handles.get(old);
      if (handle && !handle.isLive && (old !== id || handle !== h)) this.handles.delete(old);
    }
  }

  get(id: string): PtyHandle | undefined {
    return this.handles.get(id);
  }

  /** Replay data for a viewer; resizes the PTY when cols/rows are given (latest attach wins). @throws if unknown. */
  attach(id: string, size?: { cols: number; rows: number }): PtyAttachResult {
    const handle = this.handles.get(id);
    if (handle?.isLive) {
      if (size) handle.resize(size.cols, size.rows);
      return { live: true, cols: handle.cols, rows: handle.rows, replay: handle.ring.snapshot() };
    }
    const logPath = handle?.logPath ?? this.resolveLogPath(id);
    if (!logPath) throw new Error(`Unknown PTY ${id}`);
    // The size the output was drawn at, so viewers replay a full-screen TUI without garbling it.
    const drawn = handle ? { cols: handle.cols, rows: handle.rows } : (readLogSize(logPath) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    return { live: false, ...drawn, replay: readLog(logPath) };
  }

  /** Input typed by a user in the browser: writes to the PTY and notifies input listeners. */
  userInput(id: string, data: string): void {
    const handle = this.handles.get(id);
    if (!handle?.isLive) throw new Error(`PTY ${id} is not running`);
    handle.write(data);
    if (!isUserTyping(data)) return;
    for (const l of this.inputListeners) l(id);
  }

  resize(id: string, cols: number, rows: number): void {
    this.handles.get(id)?.resize(cols, rows);
  }

  onUserInput(listener: UserInputListener): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /** Live PTYs. */
  list(): PtyHandle[] {
    return [...this.handles.values()].filter((h) => h.isLive);
  }

  /** SIGINT path: kills every live PTY (callers send /exit first) and waits for log flush. */
  async killAll(): Promise<void> {
    const live = this.list();
    for (const h of live) h.kill("SIGTERM");
    const timer = setTimeout(() => live.forEach((h) => h.kill("SIGKILL")), KILL_ALL_GRACE_MS);
    await Promise.all(live.map((h) => h.exited));
    clearTimeout(timer);
  }
}

/** Sidecar of a PTY log holding its final size (`<log>.size.json`), read when replaying after a restart. */
export function logSizePath(logPath: string): string {
  return `${logPath}.size.json`;
}

async function flushLog(logPath: string, data: Buffer, size: { cols: number; rows: number }): Promise<void> {
  try {
    // Terminal logs hold everything typed and printed: readable by the user only.
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(logPath, data, { mode: 0o600 });
    await fs.promises.writeFile(logSizePath(logPath), JSON.stringify(size), { mode: 0o600 });
  } catch {
    // A missing log only loses the replay of a finished terminal.
  }
}

function readLogSize(logPath: string): { cols: number; rows: number } | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(logSizePath(logPath), "utf8"));
    if (typeof v !== "object" || v === null) return null;
    const { cols, rows } = v as { cols?: unknown; rows?: unknown };
    return Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) > 0 && (rows as number) > 0
      ? { cols: cols as number, rows: rows as number }
      : null;
  } catch {
    return null;
  }
}

function readLog(logPath: string): Buffer {
  try {
    return fs.readFileSync(logPath);
  } catch {
    return Buffer.alloc(0);
  }
}
