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
 * `baseRef` that is not a checkpoint, or `baseRef` itself when every newer commit is a checkpoint.
 * Never goes below `baseRef`, so history shared with a parent lane is kept. Null when HEAD is not a checkpoint.
 */
export async function squashTarget(cwd: string, baseRef: string): Promise<string | null> {
  const res = await git(cwd, ["log", "--first-parent", "--format=%H%x00%s", `${baseRef}..HEAD`]);
  if (res.code !== 0) return null;
  const commits = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0");
      return { sha, subject };
    });
  if (commits.length === 0 || !isCheckpointMessage(commits[0]!.subject)) return null;
  return commits.find((c) => !isCheckpointMessage(c.subject))?.sha ?? baseRef;
}
