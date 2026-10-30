/** `git rev-parse --show-toplevel` from `dir`. @throws Error("not a git repository") */
export function resolveRepoRoot(dir: string): Promise<string> {
  throw new Error("not implemented");
}

export function currentBranch(repoPath: string): Promise<string | null> {
  throw new Error("not implemented");
}

/** Local branch names. */
export function listBranches(repoPath: string): Promise<string[]> {
  throw new Error("not implemented");
}

/** Full sha of `ref`. */
export function revParse(cwd: string, ref: string): Promise<string> {
  throw new Error("not implemented");
}

/** Uncommitted (incl. untracked) changes in the worktree at `cwd`. */
export function isDirty(cwd: string): Promise<boolean> {
  throw new Error("not implemented");
}
