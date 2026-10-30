export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

export interface GitOptions {
  /** Written to stdin. */
  input?: string;
  env?: Record<string, string>;
}

/** Runs git (never through a shell). Resolves with the exit code; never throws on non-zero. */
export function git(cwd: string, args: readonly string[], opts?: GitOptions): Promise<GitResult> {
  throw new Error("not implemented");
}

/** Like git() but throws GitError on non-zero exit; returns trimmed stdout. */
export function gitOk(cwd: string, args: readonly string[], opts?: GitOptions): Promise<string> {
  throw new Error("not implemented");
}
