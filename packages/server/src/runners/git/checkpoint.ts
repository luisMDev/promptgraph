import { git, gitOk } from "../../git/exec.js";
import { mergeInProgress } from "../../git/merge-state.js";

/** Subject prefix of checkpoint commits (§9.3). */
export const CHECKPOINT_PREFIX = "pg: checkpoint";
/** Trailer of the squash-merge commits promptgraph makes: the sha of the squashed source branch tip. */
export const SQUASH_TRAILER = "Pg-Squash-Of";

export function checkpointMessage(afterLabel: string): string {
  return `${CHECKPOINT_PREFIX} after ${afterLabel}`;
}

export function isCheckpointMessage(subject: string): boolean {
  return subject.startsWith(CHECKPOINT_PREFIX);
}

/** Message of a squash-merge commit: `message` plus the SQUASH_TRAILER naming the squashed tip. */
export function squashMergeMessage(message: string, sourceSha: string): string {
  return `${message}\n\n${SQUASH_TRAILER}: ${sourceSha}`;
}

/**
 * §9.3: `git add -A && git commit -m "pg: checkpoint after <label>" --no-verify` when the worktree is
 * dirty. Returns the new sha, or null when there was nothing to commit (also when only a submodule is
 * dirty: `add -A` stages nothing for it). Callers hold the lane lock.
 * @throws when the worktree is in the middle of a merge (committing would conclude it, markers included).
 */
export async function checkpointIfDirty(cwd: string, afterLabel: string): Promise<string | null> {
  const status = await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status) return null;
  if (await mergeInProgress(cwd)) {
    throw new Error(`The worktree ${cwd} is in the middle of a merge: finish or abort it (git merge --abort) first`);
  }
  await gitOk(cwd, ["add", "-A"]);
  if ((await git(cwd, ["diff", "--cached", "--quiet"])).code === 0) return null;
  await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", checkpointMessage(afterLabel)]);
  return gitOk(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Commit to soft-reset to before committing (squashCheckpoints): the newest first-parent commit after
 * `baseRef` that is not noise, or `baseRef` itself when every newer commit is noise. Noise = checkpoints,
 * merge commits whose merged-in side holds only checkpoints and merges (a merge node joining lanes that
 * never committed), and promptgraph squash merges (SQUASH_TRAILER) of such sides. Never goes below
 * `baseRef`, nor below a commit in `keep` (fork points other lanes branched from), so history shared with
 * other lanes is kept. Null when HEAD is not noise.
 */
export async function squashTarget(cwd: string, baseRef: string, keep: readonly string[] = []): Promise<string | null> {
  const res = await git(cwd, ["log", "--first-parent", `--format=${LOG_FORMAT}`, `${baseRef}..HEAD`]);
  if (res.code !== 0) return null;
  const commits = parseLog(res.stdout);
  for (const [i, commit] of commits.entries()) {
    if (keep.includes(commit.sha) || !(await isNoise(cwd, commit))) return i === 0 ? null : commit.sha;
  }
  return commits.length === 0 ? null : baseRef;
}

const LOG_FORMAT = `%H%x00%P%x00%s%x00%(trailers:key=${SQUASH_TRAILER},valueonly,separator=%x20)`;

interface LogEntry {
  sha: string;
  parents: string[];
  subject: string;
  /** SQUASH_TRAILER value, or "". */
  squashOf: string;
}

function parseLog(stdout: string): LogEntry[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", parents = "", subject = "", squashOf = ""] = line.split("\0");
      return { sha, parents: parents.split(" ").filter(Boolean), subject, squashOf: squashOf.trim() };
    });
}

async function isNoise(cwd: string, commit: LogEntry): Promise<boolean> {
  const [first, ...others] = commit.parents;
  if (others.length > 0) {
    for (const other of others) if (!(await isNoiseRange(cwd, `${first}..${other}`))) return false;
    return true;
  }
  if (isCheckpointMessage(commit.subject)) return true;
  return first !== undefined && commit.squashOf !== "" && (await isNoiseRange(cwd, `${first}..${commit.squashOf}`));
}

/** Every commit in `range` is a checkpoint or a merge. False when the range cannot be read. */
async function isNoiseRange(cwd: string, range: string): Promise<boolean> {
  const res = await git(cwd, ["log", `--format=${LOG_FORMAT}`, range]);
  return res.code === 0 && parseLog(res.stdout).every((c) => c.parents.length > 1 || isCheckpointMessage(c.subject));
}
