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

/**
 * Name of the daemon lock (DESIGN §4.1 item 1): the Linux abstract Unix socket
 * `\0promptgraph-<uid>-<sha256(realpath PG_HOME)[:16]>`. Creates PG_HOME (0700) so it can be resolved.
 */
export function daemonLockName(paths: PgPaths): string {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const home = fs.realpathSync(paths.home);
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return `\0promptgraph-${uid}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
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
 * One daemon per PG_HOME. The lock is held by the kernel: a listening abstract Unix socket, released
 * when the process dies (no stale lock, no takeover race, no pid reuse). `locks/daemon.pid` is written
 * next to it for messages only and never decides anything. The socket is unref'd: it does not keep the
 * process alive by itself.
 */
export class DaemonLock {
  private constructor(
    private readonly server: net.Server,
    private readonly pidFile: string,
    private readonly pid: number,
  ) {}

  static acquire(paths: PgPaths, pid: number = process.pid): Promise<DaemonLock | DaemonLockHeld> {
    const name = daemonLockName(paths);
    const pidFile = daemonPidPath(paths);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.destroy());
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE") return reject(err);
        const holder = readPid(pidFile);
        resolve({ heldBy: holder !== null && isProcessAlive(holder) ? holder : null });
      });
      server.listen(name, () => {
        server.unref();
        // The socket is only a lock: a late error (none is expected) must not crash the process.
        server.on("error", () => undefined);
        try {
          fs.mkdirSync(locksDir(paths), { recursive: true, mode: 0o700 });
          writeAtomic(pidFile, `${pid}\n`);
        } catch {
          // Informational only.
        }
        resolve(new DaemonLock(server, pidFile, pid));
      });
    });
  }

  /**
   * Whether a daemon holds the lock right now: binds the socket and closes it at once when it is free,
   * without touching `locks/daemon.pid`. A daemon may take it right after this answers false.
   */
  static isHeld(paths: PgPaths): Promise<boolean> {
    const name = daemonLockName(paths);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.destroy());
      server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(true) : reject(err)));
      server.listen(name, () => server.close(() => resolve(false)));
    });
  }

  /** Closes the socket (the next acquire succeeds) and removes `locks/daemon.pid` if it is still ours. */
  async release(): Promise<void> {
    if (readPid(this.pidFile) === this.pid) fs.rmSync(this.pidFile, { force: true });
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
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
