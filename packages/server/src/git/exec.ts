import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  /** stdout reached GitOptions.maxStdoutBytes: git was killed, stdout holds the first bytes only. */
  truncated?: boolean;
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
  /** Stop reading (and kill git) once stdout exceeds this many bytes; the result is then `truncated`. */
  maxStdoutBytes?: number;
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
    let outBytes = 0;
    let truncated = false;
    child.stdout!.on("data", (c: Buffer) => {
      if (truncated) return;
      out.push(c);
      outBytes += c.length;
      if (opts.maxStdoutBytes !== undefined && outBytes > opts.maxStdoutBytes) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      resolve(truncated ? { stdout, stderr, code: 0, truncated } : { stdout, stderr, code: code ?? 1 });
    });
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
