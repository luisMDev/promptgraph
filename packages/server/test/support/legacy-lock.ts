import fs from "node:fs";
import path from "node:path";
import type { PgPaths } from "../../src/config/paths.js";
import { repoKey } from "../../src/config/repo-key.js";
import { isProcessAlive } from "../../src/util/process.js";

/**
 * The lock logic of the pre-M7 per-repository servers (copied verbatim from the old instance lock): an
 * old binary started next to the daemon runs exactly this before it opens the DB, so the daemon's
 * LegacyRepoLocks must make it throw "already running".
 */
export function acquirePreM7Lock(paths: PgPaths, repoPath: string, pid: number = process.pid): { release(): void } {
  const dir = path.join(paths.home, "locks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${repoKey(repoPath)}.pid`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${pid}\n${repoPath}\n`, { flag: "wx", mode: 0o600 });
      return { release: () => fs.rmSync(file, { force: true }) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let content = "";
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        // Treated as stale.
      }
      const owner = Number.parseInt(content.split("\n")[0] ?? "", 10);
      if (Number.isInteger(owner) && owner > 0 && isProcessAlive(owner)) {
        throw new Error(`promptgraph is already running for ${repoPath} (pid ${owner}); stop it first or open its URL`);
      }
      fs.rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  throw new Error(`Could not acquire the instance lock for ${repoPath}`);
}
