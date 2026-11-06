import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { PgPaths } from "./paths.js";
import { isProcessAlive } from "../util/process.js";
import { repoKey } from "./repo-key.js";

function locksDir(paths: PgPaths): string {
  return path.join(paths.home, "locks");
}

/** `<PG_HOME>/locks/daemon.pid`: the daemon's pid, for messages only (the lock is the socket). */
export function daemonPidPath(paths: PgPaths): string {
  return path.join(locksDir(paths), "daemon.pid");
}

/** The current uid. */
export function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
}

/**
 * Name of an abstract-socket lock guarding `dir`: `\0promptgraph-[<kind>-]<uid>-<sha256(realpath dir)[:16]>`.
 * `dir` must exist (it is resolved, so two spellings of one directory share the lock).
 */
export function namedLockName(kind: string | null, dir: string): string {
  const real = fs.realpathSync(dir);
  return `\0promptgraph-${kind ? `${kind}-` : ""}${currentUid()}-${createHash("sha256").update(real).digest("hex").slice(0, 16)}`;
}

/**
 * Name of the daemon lock (DESIGN §4.1 item 1): the Linux abstract Unix socket
 * `\0promptgraph-<uid>-<sha256(realpath PG_HOME)[:16]>`. Creates PG_HOME (0700) so it can be resolved.
 */
export function daemonLockName(paths: PgPaths): string {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  return namedLockName(null, paths.home);
}

/**
 * A lock held by the kernel: a listening abstract Unix socket, released when the process dies (no stale
 * lock, no takeover race, no pid reuse). Unref'd: it does not keep the process alive by itself. Used by
 * the daemon lock and the desktop runtime lock (DESIGN §20.7).
 */
export class SocketLock {
  private constructor(private readonly server: net.Server) {}

  /** Takes the lock, or null when another holder has it (EADDRINUSE). */
  static tryAcquire(name: string): Promise<SocketLock | null> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.destroy());
      server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(null) : reject(err)));
      server.listen(name, () => {
        server.unref();
        // The socket is only a lock: a late error (none is expected) must not crash the process.
        server.on("error", () => undefined);
        resolve(new SocketLock(server));
      });
    });
  }

  /** Waits up to `timeoutMs` for the lock (polling every `pollMs`). @throws when it stays held. */
  static async acquire(name: string, opts: { timeoutMs: number; pollMs?: number; what?: string }): Promise<SocketLock> {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const lock = await SocketLock.tryAcquire(name);
      if (lock) return lock;
      if (Date.now() >= deadline) throw new Error(`${opts.what ?? "the lock"} is held by another process; retry later`);
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
    }
  }

  /** Whether someone holds it right now (binds and closes the socket at once when it is free). */
  static isHeld(name: string): Promise<boolean> {
    return SocketLock.tryAcquire(name).then(async (lock) => {
      if (!lock) return true;
      await lock.release();
      return false;
    });
  }

  get held(): boolean {
    return this.server.listening;
  }

  async release(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Runs `fn` while holding the named lock (waiting up to `timeoutMs` for it). */
export async function withSocketLock<T>(name: string, opts: { timeoutMs: number; what?: string }, fn: () => Promise<T> | T): Promise<T> {
  const lock = await SocketLock.acquire(name, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** First line of a pid file as a positive integer, or null. */
function readPid(file: string): number | null {
  const pid = Number.parseInt(safeRead(file).split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Creates `file` with `content` (0600) only if it does not exist: a temp file hard-linked into place, so
 * no reader sees a partial file. Returns false when the file already exists.
 */
function linkExclusive(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Another daemon holds the lock; `heldBy` is the pid from `locks/daemon.pid` when that process is alive. */
export interface DaemonLockHeld {
  heldBy: number | null;
}

/**
 * One daemon per PG_HOME. The lock is a SocketLock on daemonLockName. `locks/daemon.pid` is written
 * next to it for messages only and never decides anything.
 */
export class DaemonLock {
  private constructor(
    private readonly lock: SocketLock,
    private readonly pidFile: string,
    private readonly pid: number,
  ) {}

  static async acquire(paths: PgPaths, pid: number = process.pid): Promise<DaemonLock | DaemonLockHeld> {
    const name = daemonLockName(paths);
    const pidFile = daemonPidPath(paths);
    const lock = await SocketLock.tryAcquire(name);
    if (!lock) {
      const holder = readPid(pidFile);
      return { heldBy: holder !== null && isProcessAlive(holder) ? holder : null };
    }
    try {
      fs.mkdirSync(locksDir(paths), { recursive: true, mode: 0o700 });
      writeAtomic(pidFile, `${pid}\n`);
    } catch {
      // Informational only.
    }
    return new DaemonLock(lock, pidFile, pid);
  }

  /**
   * Whether a daemon holds the lock right now: binds the socket and closes it at once when it is free,
   * without touching `locks/daemon.pid`. A daemon may take it right after this answers false.
   */
  static isHeld(paths: PgPaths): Promise<boolean> {
    return SocketLock.isHeld(daemonLockName(paths));
  }

  /** Closes the socket (the next acquire succeeds) and removes `locks/daemon.pid` if it is still ours. */
  async release(): Promise<void> {
    if (readPid(this.pidFile) === this.pid) fs.rmSync(this.pidFile, { force: true });
    await this.lock.release();
  }
}

/** Type guard for the result of DaemonLock.acquire. */
export function isDaemonLock(result: DaemonLock | DaemonLockHeld): result is DaemonLock {
  return result instanceof DaemonLock;
}

/**
 * Pre-M7 per-repository locks owned by the daemon (DESIGN §4.4): `locks/<repoKey>.pid` =
 * `<daemon pid>\n<repoPath>\n` for every registered repository, so an old per-repository binary started
 * while the daemon runs fails with its own "already running" error instead of racing on the repository.
 */
export class LegacyRepoLocks {
  private readonly held = new Set<string>();

  constructor(
    private readonly paths: PgPaths,
    private readonly pid: number = process.pid,
  ) {}

  private fileOf(repoPath: string): string {
    return path.join(locksDir(this.paths), `${repoKey(repoPath)}.pid`);
  }

  /**
   * Writes the lock file with the daemon's pid (idempotent). @throws when a live pre-M7 server of
   * another process holds it: that server owns the repository's runs until it is stopped.
   *
   * Never overwrites a file it has not checked: the file is created exclusively (temp file hard-linked
   * into place, EEXIST when it exists), and a stale one (dead or unreadable owner) is first moved aside
   * atomically and re-read there, so a live lock an old binary created after the check is put back
   * instead of being replaced.
   */
  hold(repoPath: string): void {
    const file = this.fileOf(repoPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const content = `${this.pid}\n${repoPath}\n`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (linkExclusive(file, content)) {
        this.held.add(repoPath);
        return;
      }
      const owner = readPid(file);
      if (owner === this.pid) {
        this.held.add(repoPath);
        return;
      }
      this.refuseLiveOwner(repoPath, owner);
      // Stale: move it aside (atomic) and look at what was actually moved.
      const aside = `${file}.${this.pid}.${randomBytes(6).toString("hex")}.stale`;
      try {
        fs.renameSync(file, aside);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // removed meanwhile: retry
        throw err;
      }
      try {
        const moved = readPid(aside);
        if (moved !== null && moved !== this.pid && isProcessAlive(moved)) {
          // A live owner created it after the check: put it back (unless yet another file took its place).
          try {
            fs.linkSync(aside, file);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          }
          this.refuseLiveOwner(repoPath, moved);
        }
      } finally {
        fs.rmSync(aside, { force: true });
      }
    }
    throw new Error(`Could not take the lock for ${repoPath}`);
  }

  private refuseLiveOwner(repoPath: string, owner: number | null): void {
    if (owner !== null && owner !== this.pid && isProcessAlive(owner)) {
      throw new Error(`stop the promptgraph server for ${repoPath} (pid ${owner}) first`);
    }
  }

  /** Removes the lock file if it is still ours. */
  release(repoPath: string): void {
    this.held.delete(repoPath);
    const file = this.fileOf(repoPath);
    if (readPid(file) === this.pid) fs.rmSync(file, { force: true });
  }

  releaseAll(): void {
    for (const repoPath of [...this.held]) this.release(repoPath);
  }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
