import { git, gitOk } from "../../git/exec.js";

/** Subject prefix of checkpoint commits (§9.3). */
export const CHECKPOINT_PREFIX = "pg: checkpoint";

export function checkpointMessage(afterLabel: string): string {
  return `${CHECKPOINT_PREFIX} after ${afterLabel}`;
}

export function isCheckpointMessage(subject: string): boolean {
  return subject.startsWith(CHECKPOINT_PREFIX);
}

/**
 * §9.3: `git add -A && git commit -m "pg: checkpoint after <label>" --no-verify` when the worktree is
 * dirty. Returns the new sha, or null when there was nothing to commit. Callers hold the lane lock.
 */
export async function checkpointIfDirty(cwd: string, afterLabel: string): Promise<string | null> {
  const status = await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status) return null;
  await gitOk(cwd, ["add", "-A"]);
  await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", checkpointMessage(afterLabel)]);
  return gitOk(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Commit to soft-reset to before committing (squashCheckpoints): the newest first-parent commit after
 * `baseRef` that is not noise, or `baseRef` itself when every newer commit is noise. Noise = checkpoints and
 * merge commits whose merged-in side holds only checkpoints and merges (a merge node joining lanes that never
 * committed). Never goes below `baseRef`, so history shared with a parent lane is kept. Null when HEAD is not noise.
 */
export async function squashTarget(cwd: string, baseRef: string): Promise<string | null> {
  const res = await git(cwd, ["log", "--first-parent", "--format=%H%x00%P%x00%s", `${baseRef}..HEAD`]);
  if (res.code !== 0) return null;
  const commits = parseLog(res.stdout);
  for (const [i, commit] of commits.entries()) {
    if (await isNoise(cwd, commit)) continue;
    return i === 0 ? null : commit.sha;
  }
  return commits.length === 0 ? null : baseRef;
}

interface LogEntry {
  sha: string;
  parents: string[];
  subject: string;
}

function parseLog(stdout: string): LogEntry[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", parents = "", subject = ""] = line.split("\0");
      return { sha, parents: parents.split(" ").filter(Boolean), subject };
    });
}

async function isNoise(cwd: string, commit: LogEntry): Promise<boolean> {
  if (commit.parents.length < 2) return isCheckpointMessage(commit.subject);
  const [first, ...others] = commit.parents;
  for (const other of others) {
    const side = await gitOk(cwd, ["log", "--format=%H%x00%P%x00%s", `${first}..${other}`]);
    if (!parseLog(side).every((c) => c.parents.length > 1 || isCheckpointMessage(c.subject))) return false;
  }
  return true;
}
