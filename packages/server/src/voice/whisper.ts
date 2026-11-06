import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "../config/child-env.js";

/** stdout kept from one whisper run (a 2-minute transcript is a few KB). */
const MAX_STDOUT_BYTES = 256 * 1024;
/** Tail of stderr kept for the error message (never logged). */
const STDERR_TAIL_BYTES = 600;

export type WhisperErrorKind = "failed" | "timeout" | "cancelled";

export class WhisperError extends Error {
  constructor(
    readonly kind: WhisperErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WhisperError";
  }
}

export interface WhisperPassOptions {
  bin: string;
  model: string;
  wavPath: string;
  /** whisper code or "auto". */
  language: string;
  threads?: number;
  /** `--prompt` (keyterms joined by ", "). Never audio-derived. */
  prompt?: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export interface WhisperRun {
  /** Raw stdout on exit 0; rejects with WhisperError otherwise. */
  result: Promise<string>;
  /** Kills the child (SIGKILL); `result` rejects with kind "cancelled". */
  kill(): void;
}

/** Runs one transcription pass. Injectable for tests (VoiceService `runner`). */
export type WhisperRunner = (opts: WhisperPassOptions) => WhisperRun;

/** `-m <model> -f <wav> -l <lang> -nt -np [-t <threads>] [--prompt <p>]` (§22.5). */
export function whisperArgs(opts: Pick<WhisperPassOptions, "model" | "wavPath" | "language" | "threads" | "prompt">): string[] {
  const args = ["-m", opts.model, "-f", opts.wavPath, "-l", opts.language, "-nt", "-np"];
  if (opts.threads !== undefined) args.push("-t", String(opts.threads));
  if (opts.prompt) args.push("--prompt", opts.prompt);
  return args;
}

/** Default runner: child_process.spawn with an argument array (no shell). */
export const spawnWhisper: WhisperRunner = (opts) => {
  let settled = false;
  let killedByUs = false;
  let timedOut = false;
  const child = spawn(opts.bin, whisperArgs(opts), { stdio: ["ignore", "pipe", "pipe"], env: childEnv({}, opts.env) });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes >= MAX_STDOUT_BYTES) return;
    stdout.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    timer.unref();
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.on("error", (err) => done(() => reject(new WhisperError("failed", `Could not run ${path.basename(opts.bin)}: ${err.message}`))));
    child.on("close", (code, signal) =>
      done(() => {
        if (killedByUs) return reject(new WhisperError("cancelled", "Transcription cancelled"));
        if (timedOut) return reject(new WhisperError("timeout", `Transcription timed out after ${Math.round(opts.timeoutMs / 1000)} s`));
        if (code !== 0) {
          const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").trim();
          const how = code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`;
          return reject(new WhisperError("failed", `${path.basename(opts.bin)} ${how}${tail ? `: ${tail}` : ""}`));
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      }),
    );
  });
  return {
    result,
    kill: () => {
      if (settled || killedByUs) return;
      killedByUs = true;
      child.kill("SIGKILL");
    },
  };
};

/** First `names` entry found as an executable file on `PATH` (absolute path), or null. */
export function findOnPath(names: readonly string[], envPath: string | undefined): string | null {
  const dirs = (envPath ?? "").split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const name of names) {
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isReadableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `<bin> --help` smoke test: ok when it exits 0 (or prints a usage text, for builds that exit non-zero on
 * --help). Returns null on success, else a short reason.
 */
export function smokeTestWhisper(bin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv({}, env) });
    } catch (err) {
      return resolve(`Could not run ${bin}: ${(err as Error).message}`);
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`${bin} --help did not finish in ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    timer.unref();
    const collect = (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => finish(`Could not run ${bin}: ${err.message}`));
    child.on("close", (code, signal) => {
      if (code === 0 || /usage/i.test(output)) return finish(null);
      const tail = output.trim().split(/\r?\n/).slice(-2).join(" ").slice(-300);
      finish(`${bin} --help ${code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`}${tail ? `: ${tail}` : ""}`);
    });
  });
}
