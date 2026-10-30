import { spawn } from "node:child_process";
import { HeadlessResultSchema, type HeadlessResult } from "@promptgraph/shared";
import { childEnv, claudeBin } from "../../config/child-env.js";

export interface HeadlessOptions {
  /** Sent on stdin. */
  prompt: string;
  cwd: string;
  /** JSON schema object → `--json-schema <JSON>`; the parsed value is in result.structured_output. */
  jsonSchema?: object;
  model?: string;
  timeoutMs?: number; // default 120s
  signal?: AbortSignal;
  /** Base env (claudeBin + childEnv); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * `claude -p --output-format json [--json-schema …] [--model …]` (§6.1 generated messages, §15.2 judge)
 * with childEnv(). Parses HeadlessResultSchema. @throws on spawn failure, timeout, non-JSON output or is_error.
 */
export function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const env = opts.env ?? process.env;
  const args = ["-p", "--output-format", "json"];
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  if (opts.model) args.push("--model", opts.model);

  return new Promise<HeadlessResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const child = spawn(claudeBin(env), args, { cwd: opts.cwd, env: childEnv({}, env), stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | null = null;
    const stop = (err: Error) => {
      failure ??= err;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error(`claude -p timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`)), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop(abortError());
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.prompt);
    child.on("error", (err) => stop(err));
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (failure) return reject(failure);
      const out = Buffer.concat(stdout).toString("utf8");
      const envelope = parseEnvelope(out);
      if (!envelope) {
        const detail = Buffer.concat(stderr).toString("utf8").trim() || out.trim();
        return reject(new Error(`claude -p failed (exit ${code}): ${detail.slice(0, 500) || "no output"}`));
      }
      if (envelope.is_error) return reject(new Error(`claude -p error (${envelope.subtype}): ${envelope.result ?? ""}`.trim()));
      resolve(envelope);
    });
  });
}

/** The envelope is the last JSON line of stdout. */
function parseEnvelope(stdout: string): HeadlessResult | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = HeadlessResultSchema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON.
    }
  }
  return null;
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
