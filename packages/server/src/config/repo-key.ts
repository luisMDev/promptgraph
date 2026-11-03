import { createHash } from "node:crypto";

/** Stable per-repository file key (instance lock, server-info record, background server log). */
export function repoKey(repoPath: string): string {
  return createHash("sha256").update(repoPath).digest("hex").slice(0, 32);
}
