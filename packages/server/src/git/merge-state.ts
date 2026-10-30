import fs from "node:fs";
import path from "node:path";
import { git, gitOk } from "./exec.js";

/** Absolute path of a file in the worktree's own git dir (`git rev-parse --git-path <name>`). */
export async function gitPath(cwd: string, name: string): Promise<string> {
  return path.resolve(cwd, await gitOk(cwd, ["rev-parse", "--git-path", name]));
}

export async function hasMergeHead(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
}

/** A `git merge --squash` that was not committed yet leaves SQUASH_MSG behind (no MERGE_HEAD). */
export async function hasPendingSquash(cwd: string): Promise<boolean> {
  return fs.existsSync(await gitPath(cwd, "SQUASH_MSG"));
}

/** Paths with unmerged index entries (`git diff --name-only --diff-filter=U`). */
export async function unmergedFiles(cwd: string): Promise<string[]> {
  const out = await gitOk(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return out.split("\n").filter(Boolean);
}

/** The worktree is in the middle of a merge: MERGE_HEAD, a pending squash merge, or unmerged paths. */
export async function mergeInProgress(cwd: string): Promise<boolean> {
  return (await hasMergeHead(cwd)) || (await hasPendingSquash(cwd)) || (await unmergedFiles(cwd)).length > 0;
}
