import { spawn } from "node:child_process";

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
export function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code: code ?? 1 }),
    );
    if (child.stdin) {
      // git may exit before reading its input (e.g. on a bad ref): the exit code reports that, not EPIPE.
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
  });
}

/** Like git() but throws GitError on non-zero exit; returns trimmed stdout. */
export async function gitOk(cwd: string, args: readonly string[], opts?: GitOptions): Promise<string> {
  const res = await git(cwd, args, opts);
  if (res.code !== 0) throw new GitError(args, res.code, res.stderr);
  return res.stdout.trim();
}
