import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PgPaths } from "./paths.js";

/**
 * One live server per repository: a pid file in `<PG_HOME>/locks/` (§4: one server manages one
 * repository; the state DB is shared). A second instance for the same repository would mark the first
 * one's live runs interrupted at startup, so it refuses instead. Stale files (dead pid) are taken over.
 */
export class InstanceLock {
  private constructor(private readonly file: string) {}

  static acquire(paths: PgPaths, repoPath: string, pid: number = process.pid): InstanceLock {
    const dir = path.join(paths.home, "locks");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${createHash("sha256").update(repoPath).digest("hex").slice(0, 32)}.pid`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, `${pid}\n${repoPath}\n`, { flag: "wx", mode: 0o600 });
        return new InstanceLock(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const owner = Number.parseInt(safeRead(file).split("\n")[0] ?? "", 10);
        if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
          throw new Error(`promptgraph is already running for ${repoPath} (pid ${owner}); stop it first or open its URL`);
        }
        fs.rmSync(file, { force: true }); // stale: its process is gone
      }
    }
    throw new Error(`Could not acquire the instance lock for ${repoPath}`);
  }

  release(): void {
    fs.rmSync(this.file, { force: true });
  }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
