/** Claude binary; tests point it at test/fixtures/fake-claude. */
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PG_CLAUDE_BIN || "claude";
}

/**
 * Variables that make a child `claude` behave as a nested/hermetic session (SPIKE): it would not persist
 * transcripts or would refuse to start. Stripped from every child process env.
 */
const STRIPPED_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_TEE_SDK_STDOUT",
  "CLAUDE_CODE_SYNC_SESSION_REFS",
]);
const STRIPPED_PATTERN = /HERMETIC/;

/** promptgraph's own variables passed to hooks (§7.1). */
export interface PgHookEnv {
  PG_PORT: string;
  PG_TOKEN: string;
  PG_NODE_RUN_ID: string;
}

/** Child env = parent env − nested-session vars + TERM + `extra`. */
export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIPPED_EXACT.has(k) || STRIPPED_PATTERN.test(k)) continue;
    env[k] = v;
  }
  return { ...env, TERM: "xterm-256color", ...extra };
}
