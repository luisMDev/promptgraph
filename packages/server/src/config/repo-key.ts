import { createHash } from "node:crypto";

/** Per-repository file key of the pre-M7 servers (their lock is still written by LegacyRepoLocks, DESIGN §4.4). */
export function repoKey(repoPath: string): string {
  return createHash("sha256").update(repoPath).digest("hex").slice(0, 32);
}
