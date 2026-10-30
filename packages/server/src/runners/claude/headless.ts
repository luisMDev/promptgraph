import type { HeadlessResult } from "@promptgraph/shared";

export interface HeadlessOptions {
  /** Sent on stdin. */
  prompt: string;
  cwd: string;
  /** JSON schema object → `--json-schema <JSON>`; the parsed value is in result.structured_output. */
  jsonSchema?: object;
  model?: string;
  timeoutMs?: number; // default 120s
  signal?: AbortSignal;
}

/**
 * `claude -p --output-format json [--json-schema …] [--model …]` (§6.1 generated messages, §15.2 judge)
 * with childEnv(). Parses HeadlessResultSchema. @throws on spawn failure, timeout, non-JSON output or is_error.
 */
export function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  throw new Error("not implemented");
}
