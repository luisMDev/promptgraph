import { git, gitOk } from "./exec.js";

/** `git rev-parse --show-toplevel` from `dir`. @throws Error("not a git repository") */
export async function resolveRepoRoot(dir: string): Promise<string> {
  let res;
  try {
    res = await git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("not a git repository");
  }
  const root = res.stdout.trim();
  if (res.code !== 0 || !root) throw new Error("not a git repository");
  return root;
}

export async function currentBranch(repoPath: string): Promise<string | null> {
  const res = await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return res.code === 0 ? res.stdout.trim() || null : null;
}

/** Local branch names. */
export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await gitOk(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  return out.split("\n").filter(Boolean);
}

/** Full sha of `ref`. */
export function revParse(cwd: string, ref: string): Promise<string> {
  return gitOk(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

/** Uncommitted (incl. untracked) changes in the worktree at `cwd`. */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all"])) !== "";
}
